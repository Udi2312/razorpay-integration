import mongoose, { Schema, Document } from 'mongoose';

// --- ORDER INTERFACE & SCHEMA ---
export interface IOrder extends Document {
  orderId: string; // Razorpay Order ID (e.g., order_123)
  itemId: string;
  amount: number; // in paise
  currency: string;
  status: 'created' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';
  amountRefunded: number; // in paise
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema: Schema = new Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    itemId: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: {
      type: String,
      enum: ['created', 'captured', 'failed', 'refunded', 'partially_refunded'],
      default: 'created',
    },
    amountRefunded: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// --- PAYMENT INTERFACE & SCHEMA ---
export interface IPayment extends Document {
  paymentId: string; // Razorpay Payment ID (e.g., pay_123)
  orderId: string; // Razorpay Order ID
  amount: number; // in paise
  status: 'authorized' | 'captured' | 'failed' | 'refunded';
  method: string;
  email?: string;
  contact?: string;
  errorDescription?: string;
  signatureVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentSchema: Schema = new Schema(
  {
    paymentId: { type: String, required: true, unique: true, index: true },
    orderId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ['authorized', 'captured', 'failed', 'refunded'],
      required: true,
    },
    method: { type: String, required: true },
    email: { type: String },
    contact: { type: String },
    errorDescription: { type: String },
    signatureVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// --- WEBHOOK EVENT INTERFACE & SCHEMA ---
export interface IWebhookEvent extends Document {
  eventId: string; // Razorpay Webhook Event ID
  processed: boolean;
  receivedAt: Date;
}

const WebhookEventSchema: Schema = new Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  processed: { type: Boolean, default: true },
  receivedAt: { type: Date, default: Date.now },
});

// --- AUDIT LOG INTERFACE & SCHEMA ---
export interface ILog extends Document {
  level: 'info' | 'warn' | 'error';
  message: string;
  meta: Record<string, any>;
  timestamp: Date;
}

const LogSchema: Schema = new Schema({
  level: { type: String, enum: ['info', 'warn', 'error'], required: true },
  message: { type: String, required: true },
  meta: { type: Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, default: Date.now },
});

// Export Models
export const Order = mongoose.model<IOrder>('Order', OrderSchema);
export const Payment = mongoose.model<IPayment>('Payment', PaymentSchema);
export const WebhookEvent = mongoose.model<IWebhookEvent>('WebhookEvent', WebhookEventSchema);
export const AuditLog = mongoose.model<ILog>('AuditLog', LogSchema);
