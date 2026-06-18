import crypto from 'crypto';
import { RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } from '../config/config';

/**
 * Verify signature sent from browser after payment success.
 * Tied to the exact order and payment IDs to prevent replay attacks.
 */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  const data = `${orderId}|${paymentId}`;
  const generatedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(data)
    .digest('hex');
  return generatedSignature === signature;
}

/**
 * Verify signature sent by Razorpay in the webhook request headers.
 * Uses the raw, unparsed request body.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  if (!signature || !rawBody) return false;
  const generatedSignature = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  
  // Use timingSafeEqual to avoid timing attack vulnerabilities
  try {
    return crypto.timingSafeEqual(
      Buffer.from(generatedSignature, 'utf-8'),
      Buffer.from(signature, 'utf-8')
    );
  } catch (e) {
    return false;
  }
}
