import { Router, Request, Response } from 'express';
import { ITEM_PRICES, razorpay, PORT, RAZORPAY_WEBHOOK_SECRET } from '../config/config';
import { Order, Payment, WebhookEvent, AuditLog } from '../database/models';
import { verifyPaymentSignature, verifyWebhookSignature } from '../utils/razorpay';
import { runReconciliation } from '../cron/sync';

const router = Router();

/**
 * @route POST /api/orders
 * @receives { itemId: string } in request body.
 * @does 
 *   1. Looks up the item ID in the server-side PRICE catalog to prevent client tampering.
 *   2. Converts the price from Rupees to Paise (multiplies by 100 and rounds) as required by Razorpay.
 *   3. Calls the Razorpay API to generate a new secure transaction Order.
 *   4. Stores the generated Order in MongoDB with a 'created' state and logs the action.
 * @returns JSON object containing Razorpay public keyId, the Razorpay Order ID, total amount in Paise, 
 *          currency code ('INR'), and the canonical Item Name.
 * @consequence If this route is missing: The frontend application cannot initiate any purchase. 
 *              Users would be unable to get a valid transaction Order ID from Razorpay, meaning 
 *              the checkout popup cannot open.
 */
router.post('/orders', async (req: Request, res: Response) => {
  try {
    const { itemId } = req.body;
    
    if (!itemId || !ITEM_PRICES[itemId]) {
      return res.status(400).json({ error: 'Invalid or missing Item ID' });
    }

    const item = ITEM_PRICES[itemId];
    // ALWAYS calculate price on server, convert Rupees to Paise (multiply by 100)
    const amountPaise = Math.round(item.priceRupees * 100);

    // Call Razorpay API to generate the order
    const options = {
      amount: amountPaise,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1, // 1 for auto-capture, 0 for manual capture
    };

    const rzpOrder = await razorpay.orders.create(options);

    // Save to Database
    const order = await Order.create({
      orderId: rzpOrder.id,
      itemId: itemId,
      amount: amountPaise,
      currency: 'INR',
      status: 'created',
    });

    await AuditLog.create({
      level: 'info',
      message: `Created order successfully.`,
      meta: { orderId: order.orderId, itemId, amountPaise }
    });

    return res.status(201).json({
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholderID',
      orderId: order.orderId,
      amount: order.amount,
      currency: order.currency,
      itemName: item.name
    });

  } catch (error: any) {
    await AuditLog.create({
      level: 'error',
      message: `Failed to create order: ${error.message}`,
      meta: { error }
    });
    return res.status(500).json({ error: 'Order creation failed', details: error.message });
  }
});

/**
 * @route POST /api/payments/verify
 * @receives { orderId: string, paymentId: string, signature: string } in request body.
 * @does 
 *   1. Verifies the browser checkout signature using SHA256 HMAC and the server's Secret Key.
 *   2. Queries Razorpay API directly for validation of the payment status.
 *   3. Updates the local Order status to 'captured' and writes the Payment attempt details to MongoDB.
 *   4. Automatically creates database records if it identifies an "orphan" order (e.g. server crashed before saving order ID).
 * @returns Success JSON { success: true, message: 'Payment verified successfully' } or 400 error.
 * @consequence If this route is missing: The application will trust client-reported success messages, 
 *              allowing users to easily fake signatures/payments. The database will never mark transactions 
 *              as verified, making it impossible to check if payments were genuine in real-time.
 */
router.post('/payments/verify', async (req: Request, res: Response) => {
  try {
    const { orderId, paymentId, signature } = req.body;

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: 'Missing verification fields' });
    }

    // Verify signature using SHA256 against Secret Key (never exposed on client)
    const isValid = verifyPaymentSignature(orderId, paymentId, signature);

    if (!isValid) {
      await AuditLog.create({
        level: 'warn',
        message: 'Signature verification failed for payment.',
        meta: { orderId, paymentId }
      });
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Fetch details from Razorpay to fetch actual payment info (safe validation)
    const rzpPayment = await razorpay.payments.fetch(paymentId);

    // Update order status if not already captured
    const order = await Order.findOne({ orderId });
    if (order) {
      if (order.status !== 'captured' && order.status !== 'refunded') {
        order.status = 'captured';
        await order.save();
      }
    } else {
      // Handle orphan order (database crashed after creation but before saving, or other sync issue)
      await Order.create({
        orderId,
        itemId: 'unknown-sync-success',
        amount: Number(rzpPayment.amount),
        currency: rzpPayment.currency as string,
        status: 'captured'
      });
    }

    // Save payment attempt to Database
    await Payment.findOneAndUpdate(
      { paymentId },
      {
        orderId,
        amount: Number(rzpPayment.amount),
        status: 'captured',
        method: rzpPayment.method as string,
        email: rzpPayment.email as string,
        contact: rzpPayment.contact as string,
        signatureVerified: true,
      },
      { upsert: true, new: true }
    );

    await AuditLog.create({
      level: 'info',
      message: 'Payment verified and captured successfully.',
      meta: { orderId, paymentId }
    });

    return res.json({ success: true, message: 'Payment verified successfully' });

  } catch (error: any) {
    await AuditLog.create({
      level: 'error',
      message: `Signature verification exception: ${error.message}`,
      meta: { error }
    });
    return res.status(500).json({ error: 'Verification failed', details: error.message });
  }
});

// 3. Webhooks Listener (Webhook logic with Raw Body, Idempotency, Fast Response & Async Processing)
/**
 * @route POST /api/webhooks
 * @receives Raw request body + 'x-razorpay-signature' in headers.
 * @does 
 *   1. Computes the SHA256 signature using the raw, untouched request body buffer to verify authenticity.
 *   2. Prevents double-processing via an idempotency check against processed Webhook Event IDs.
 *   3. Instantly responds with status 200 OK (fast response) to ensure Razorpay does not flag timeouts.
 *   4. Spawns an asynchronous background process to update the database for captured, failed, and refund events.
 *   5. Prevents downgrading state changes (e.g. out-of-order failure message overwriting a previous success state).
 *   6. Handles orphan orders by inserting missing records into MongoDB.
 * @returns Status 200 JSON { status: 'received' } or { status: 'ok', duplicated: true }
 * @consequence If this route is missing: Payments made during internet drops, browser tab closures, 
 *              delayed banking approvals, or mobile app transitions will never sync to the database. 
 *              Webhook updates will fail, leaving paid orders in a perpetually "created" state.
 */
router.post('/webhooks', async (req: Request, res: Response) => {
  const signature = req.headers['x-razorpay-signature'] as string;
  const rawBody = (req as any).rawBody; // Extracted via custom body parser middleware

  try {
    // A. Verify genuine source using raw untouched body
    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      await AuditLog.create({
        level: 'warn',
        message: 'Invalid webhook signature received.',
        meta: { signature }
      });
      return res.status(400).send('Invalid Signature');
    }

    const payload = JSON.parse(rawBody);
    const eventId = payload.created_at + '_' + (payload.event || 'unknown'); // or payload.id if provided

    // B. Idempotency Check: Avoid processing same webhook multiple times
    const existingEvent = await WebhookEvent.findOne({ eventId });
    if (existingEvent) {
      // Webhook already processed, send fast 200 OK
      return res.status(200).json({ status: 'ok', duplicated: true });
    }

    // Save Event immediately to prevent race conditions
    await WebhookEvent.create({ eventId, processed: true });

    // C. Respond FAST (Just save info & schedule processing, don't keep client waiting)
    res.status(200).json({ status: 'received' });

    // D. Process the Webhook event asynchronously (don't block the HTTP response)
    processWebhookEventAsync(payload).catch((err) => {
      console.error('Asynchronous webhook processing failed:', err);
    });

  } catch (error: any) {
    console.error('Webhook error:', error);
    return res.status(500).send('Webhook error');
  }
});

// Helper for Webhook Async Handler
async function processWebhookEventAsync(payload: any) {
  const event = payload.event;
  const data = payload.payload;

  await AuditLog.create({
    level: 'info',
    message: `Processing Webhook event: ${event}`,
    meta: { event }
  });

  if (event === 'payment.captured' || event === 'order.paid') {
    const paymentData = data.payment?.entity;
    const orderId = paymentData?.order_id || data.order?.entity?.id;
    const paymentId = paymentData?.id;

    if (!orderId) return;

    // Fetch order from DB
    const order = await Order.findOne({ orderId });
    if (order) {
      // Out-of-order event check: Avoid downgrading state
      if (order.status !== 'captured' && order.status !== 'refunded') {
        order.status = 'captured';
        await order.save();
      }
    } else {
      // Orphan Order Case: Order wasn't saved in DB yet when Webhook arrived
      await Order.create({
        orderId,
        itemId: 'unknown-orphan-webhook',
        amount: Number(paymentData?.amount || 0),
        currency: paymentData?.currency || 'INR',
        status: 'captured'
      });
    }

    if (paymentId) {
      await Payment.findOneAndUpdate(
        { paymentId },
        {
          orderId,
          amount: Number(paymentData.amount),
          status: 'captured',
          method: paymentData.method,
          email: paymentData.email,
          contact: paymentData.contact,
        },
        { upsert: true }
      );
    }
  }

  else if (event === 'payment.failed') {
    const paymentData = data.payment?.entity;
    const orderId = paymentData?.order_id;
    const paymentId = paymentData?.id;

    if (!orderId) return;

    const order = await Order.findOne({ orderId });
    // Don't mark failed if already captured (avoid out-of-order failure overwriting success)
    if (order && order.status !== 'captured' && order.status !== 'refunded') {
      order.status = 'failed';
      await order.save();
    }

    if (paymentId) {
      await Payment.findOneAndUpdate(
        { paymentId },
        {
          orderId,
          amount: Number(paymentData.amount),
          status: 'failed',
          method: paymentData.method,
          email: paymentData.email,
          contact: paymentData.contact,
          errorDescription: paymentData.error_description || 'Payment failed',
        },
        { upsert: true }
      );
    }
  }

  else if (event === 'refund.created') {
    const refundEntity = data.refund?.entity;
    const paymentId = refundEntity?.payment_id;
    const amountRefunded = Number(refundEntity?.amount || 0);

    if (paymentId) {
      const payment = await Payment.findOne({ paymentId });
      if (payment) {
        payment.status = 'refunded';
        await payment.save();

        const order = await Order.findOne({ orderId: payment.orderId });
        if (order) {
          order.amountRefunded = (order.amountRefunded || 0) + amountRefunded;
          if (order.amountRefunded >= order.amount) {
            order.status = 'refunded';
          } else {
            order.status = 'partially_refunded';
          }
          await order.save();
        }
      }
    }
  }
}

// 4. Create Refunds Endpoint (Pre-conditions and remaining balance verification)
/**
 * @route POST /api/refunds
 * @receives { orderId: string, amountRupees: number } in request body.
 * @does 
 *   1. Verifies the order status is currently captured or partially refunded (pre-condition).
 *   2. Checks if requested refund amount exceeds the remaining transaction balance to prevent balance leak.
 *   3. Submits the refund transaction payload to the Razorpay API using the payment ID.
 *   4. Updates MongoDB order states to 'refunded' or 'partially_refunded' and increments 'amountRefunded' values.
 * @returns Updated status JSON { success: true, orderStatus: string, amountRefunded: number }
 * @consequence If this route is missing: Administrators cannot initiate partial or full refunds. 
 *              All refunds would have to be manually entered on the Razorpay dashboard, creating 
 *              potential syncing discrepancies and risk of double-refunding.
 */
router.post('/refunds', async (req: Request, res: Response) => {
  try {
    const { orderId, amountRupees } = req.body;

    if (!orderId || amountRupees === undefined) {
      return res.status(400).json({ error: 'Missing orderId or refund amount' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Refund restriction: Only captured orders can be refunded
    if (order.status !== 'captured' && order.status !== 'partially_refunded') {
      return res.status(400).json({ error: 'Only captured payments can be refunded' });
    }

    const refundAmountPaise = Math.round(amountRupees * 100);
    const maxRefundable = order.amount - order.amountRefunded;

    // Prevent refunding more than the remaining balance
    if (refundAmountPaise > maxRefundable) {
      return res.status(400).json({
        error: `Refund amount exceeds remaining balance. Max refundable: ₹${maxRefundable / 100}`
      });
    }

    // Find the successful payment corresponding to this order
    const payment = await Payment.findOne({ orderId, status: 'captured' });
    if (!payment) {
      return res.status(404).json({ error: 'Successful payment record not found for this order' });
    }

    // Trigger Razorpay Refund API
    const rzpRefund = await razorpay.payments.refund(payment.paymentId, {
      amount: refundAmountPaise,
      notes: { reason: 'User initiated refund' }
    });

    // Update database
    order.amountRefunded += refundAmountPaise;
    if (order.amountRefunded >= order.amount) {
      order.status = 'refunded';
    } else {
      order.status = 'partially_refunded';
    }
    await order.save();

    await AuditLog.create({
      level: 'info',
      message: 'Processed refund successfully.',
      meta: { orderId, refundId: rzpRefund.id, amountRefunded: refundAmountPaise }
    });

    return res.json({
      success: true,
      orderStatus: order.status,
      amountRefunded: order.amountRefunded / 100
    });

  } catch (error: any) {
    await AuditLog.create({
      level: 'error',
      message: `Refund operation failed: ${error.message}`,
      meta: { error }
    });
    return res.status(500).json({ error: 'Refund failed', details: error.message });
  }
});

// 5. Dashboard Data (helper endpoint for UI presentation)
/**
 * @route GET /api/dashboard
 * @receives Nothing (HTTP GET request)
 * @does Queries MongoDB for the 10 most recent Orders, Payments, WebhookEvents, and 20 most recent AuditLogs.
 * @returns JSON object { orders, payments, webhooks, logs }
 * @consequence If this route is missing: The developer/administrator console UI on the frontend will be 
 *              completely blind. It won't show the real-time database state or audit records.
 */
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).limit(10);
    const payments = await Payment.find().sort({ createdAt: -1 }).limit(10);
    const webhooks = await WebhookEvent.find().sort({ receivedAt: -1 }).limit(10);
    const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(20);

    return res.json({ orders, payments, webhooks, logs });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// 6. Manual trigger for Cron job reconciliation (helper endpoint)
/**
 * @route POST /api/cron/trigger
 * @receives Nothing (HTTP POST request)
 * @does Synchronously triggers the background database reconciliation cron job immediately.
 * @returns JSON { success: true, message: 'Cron reconciliation triggered successfully' }
 * @consequence If this route is missing: Developers or admins cannot manually trigger a payment reconciliation 
 *              from the user interface; they would have to wait for the next 10-minute automated schedule.
 */
router.post('/cron/trigger', async (req: Request, res: Response) => {
  try {
    await runReconciliation();
    return res.json({ success: true, message: 'Cron reconciliation triggered successfully' });
  } catch (error: any) {
    return res.status(500).json({ error: 'Reconciliation failed', details: error.message });
  }
});

// 7. Developer simulation route to trigger a signed webhook event securely from the server
/**
 * @route POST /api/webhooks/simulate
 * @receives { event: string, orderId?: string, paymentId?: string, amountRupees?: number }
 * @does 
 *   1. Generates a valid JSON representation matching standard Razorpay webhook payloads.
 *   2. Automatically hashes and signs the generated payload with the private webhook secret key.
 *   3. Submits an internal HTTP request to the server's own raw body Webhooks receiver `/api/webhooks`.
 * @returns Success status message JSON.
 * @consequence If this route is missing: Developers cannot test webhook processing (such as orphan order, 
 *              failed states, or duplicate events) locally without setting up public tunneling (e.g. ngrok) 
 *              and performing actual test mode checkouts.
 */
router.post('/webhooks/simulate', async (req: Request, res: Response) => {
  try {
    const { event, orderId, paymentId, amountRupees } = req.body;

    const amt = amountRupees ? Math.round(amountRupees * 100) : 49900;
    const ordId = orderId || `order_sim_${Date.now()}`;
    const payId = paymentId || `pay_sim_${Date.now()}`;

    let payload: any = {
      entity: 'event',
      account_id: 'acc_placeholder',
      event: event || 'payment.captured',
      contains: ['payment'],
      payload: {},
      created_at: Math.floor(Date.now() / 1000)
    };

    if (event === 'payment.captured' || event === 'payment.failed') {
      payload.payload = {
        payment: {
          entity: {
            id: payId,
            entity: 'payment',
            amount: amt,
            currency: 'INR',
            status: event === 'payment.captured' ? 'captured' : 'failed',
            order_id: ordId,
            method: 'upi',
            email: 'simulated_user@example.com',
            contact: '+919999999999',
            error_description: event === 'payment.failed' ? 'UPI pin entry timeout' : null
          }
        }
      };
    } else if (event === 'refund.created') {
      payload.payload = {
        refund: {
          entity: {
            id: `rfnd_sim_${Date.now()}`,
            payment_id: payId,
            amount: amt,
            currency: 'INR',
            created_at: Math.floor(Date.now() / 1000)
          }
        }
      };
    }

    const payloadString = JSON.stringify(payload);
    
    // Generate valid signature using the webhook secret
    const crypto = require('crypto');
    const signature = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(payloadString)
      .digest('hex');

    // Make an internal HTTP POST to our own webhook endpoint to test raw body validation and signature parsing
    const response = await fetch(`http://localhost:${PORT}/api/webhooks`, {
      method: 'POST',
      body: payloadString,
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signature
      }
    });

    if (!response.ok) {
      throw new Error(`Local webhook route responded with status: ${response.status}`);
    }

    return res.json({ success: true, message: `Simulated event ${event} dispatched successfully` });
  } catch (error: any) {
    return res.status(500).json({ error: 'Simulation failed', details: error.message });
  }
});

export default router;
