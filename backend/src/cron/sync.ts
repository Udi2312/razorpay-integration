import cron from 'node-cron';
import { razorpay } from '../config/config';
import { Order, Payment, AuditLog } from '../database/models';

/**
 * Reconciles local database orders with Razorpay API status.
 * @receives Nothing (runs on scheduled intervals or manual triggers).
 * @does 
 *   1. Fetches all local orders in a pending 'created' state from the last 7 days.
 *   2. For each pending order, queries the Razorpay API to retrieve all payment attempts.
 *   3. If a payment was successfully 'captured' on Razorpay but not in our database, it syncs the database.
 *   4. If a payment was 'authorized' on Razorpay but not captured, it triggers Razorpay's Capture API 
 *      to claim the funds, preventing an automatic refund (delayed payment edge case).
 * @returns Promise<void>
 * @consequence If this function is missing: Delayed bank approvals (where the bank succeeds minutes/hours later) 
 *              will never update the database. Authorized payments left uncaptured will be auto-refunded by Razorpay 
 *              after 5 days, resulting in lost revenue.
 */
export async function runReconciliation() {
  console.log('Running payment synchronization cron job...');
  
  await AuditLog.create({
    level: 'info',
    message: 'Cron job started: Syncing order status with Razorpay.',
  });

  try {
    // Find orders created in the last 7 days that are not captured or refunded
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    const pendingOrders = await Order.find({
      status: 'created',
      createdAt: { $gte: cutoffDate },
    });

    console.log(`Found ${pendingOrders.length} pending orders to check.`);

    for (const order of pendingOrders) {
      try {
        // Fetch payment attempts for this order from Razorpay API
        const rzpPaymentsResponse = await razorpay.orders.fetchPayments(order.orderId);
        const paymentsList = rzpPaymentsResponse.items || [];

        if (paymentsList.length === 0) {
          continue; // No payments attempted for this order yet
        }

        // Search for a successful capture or authorization in the payments list
        const capturedPayment = paymentsList.find((p) => p.status === 'captured');
        const authorizedPayment = paymentsList.find((p) => p.status === 'authorized');

        if (capturedPayment) {
          // If Razorpay has captured it but our DB shows created: sync!
          order.status = 'captured';
          await order.save();

          await Payment.findOneAndUpdate(
            { paymentId: capturedPayment.id },
            {
              orderId: order.orderId,
              amount: Number(capturedPayment.amount),
              status: 'captured',
              method: capturedPayment.method as string,
              email: capturedPayment.email as string,
              contact: capturedPayment.contact as string,
            },
            { upsert: true }
          );

          await AuditLog.create({
            level: 'info',
            message: `Cron Sync: Order ${order.orderId} successfully resolved to captured.`,
            meta: { orderId: order.orderId, paymentId: capturedPayment.id }
          });
        } 
        
        else if (authorizedPayment) {
          // Tricky Edge Case: Authorized but not captured. We must capture it to prevent auto-refund.
          console.log(`Cron Sync: Found authorized payment ${authorizedPayment.id}. Capturing now...`);
          
          const capturedResult = await razorpay.payments.capture(
            authorizedPayment.id,
            authorizedPayment.amount,
            authorizedPayment.currency as string
          );

          order.status = 'captured';
          await order.save();

          await Payment.findOneAndUpdate(
            { paymentId: authorizedPayment.id },
            {
              orderId: order.orderId,
              amount: Number(capturedResult.amount),
              status: 'captured',
              method: capturedResult.method as string,
              email: capturedResult.email as string,
              contact: capturedResult.contact as string,
            },
            { upsert: true }
          );

          await AuditLog.create({
            level: 'info',
            message: `Cron Sync: Authorized payment ${authorizedPayment.id} captured automatically via cron.`,
            meta: { orderId: order.orderId, paymentId: authorizedPayment.id }
          });
        }
      } catch (err: any) {
        await AuditLog.create({
          level: 'error',
          message: `Cron Sync: Failed to check order ${order.orderId}: ${err.message}`,
          meta: { orderId: order.orderId }
        });
      }
    }
  } catch (error: any) {
    await AuditLog.create({
      level: 'error',
      message: `Cron Sync Job experienced an error: ${error.message}`,
    });
    console.error('Error during reconciliation cron:', error);
  }
}

// Schedule cron job to run every 10 minutes
export function startCronScheduler() {
  cron.schedule('*/10 * * * *', () => {
    runReconciliation();
  });
  console.log('Cron scheduler registered (running every 10 minutes).');
}
