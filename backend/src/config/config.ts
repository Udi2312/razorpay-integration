import Razorpay from 'razorpay';
import dotenv from 'dotenv';

dotenv.config();

export const PORT = process.env.PORT || 5000;
export const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/razorpay_demo';

export const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholderID';
export const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_placeholderSecret';
export const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'webhook_secret_placeholder';

// Canonical item pricing on the server to prevent client-side price tampering.
// Price is specified in Rupees. We will convert it to Paise (amount * 100) before creating the order.
export const ITEM_PRICES: Record<string, { name: string; priceRupees: number }> = {
  'premium-sub': {
    name: 'Premium Subscription (Monthly)',
    priceRupees: 499.0, // ₹499.00 -> 49900 paise
  },
  'starter-pack': {
    name: 'Starter Developer Pack',
    priceRupees: 99.0, // ₹99.00 -> 9900 paise
  },
  'pro-course': {
    name: 'Full-Stack Payment Integration Course',
    priceRupees: 1499.0, // ₹1499.00 -> 149900 paise
  },
};

// Initialize Razorpay Client
export const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});
