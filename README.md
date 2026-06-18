# Razorpay secure payment Integration Lab

This repository contains a full Next.js App Router (TypeScript) frontend and a Node.js Express (TypeScript, Mongoose) backend demonstrating best practices for integrating Razorpay secure payment checkout flows. It is configured to run in **Test Mode** and features an interactive developer dashboard with live MongoDB sync monitoring, cron synchronization, and a built-in webhook simulator.

---

## 🛠️ Tech Stack & Architecture

- **Frontend**: Next.js (TypeScript, React Client Components, Custom Vanilla CSS Theme).
- **Backend**: Node.js Express (TypeScript, Native Fetch, `node-cron` for scheduling, timing-safe SHA256 verification).
- **Database**: MongoDB (Mongoose schemas for `Order`, `Payment`, `WebhookEvent`, and audit `AuditLog`).

---

## 🚀 How to Run Locally

### Prerequisites
- Node.js (v18+)
- MongoDB running locally on `mongodb://localhost:27017` (or provide a remote connection string)

### 1. Backend Setup
1. Open a terminal and navigate to `backend/`:
   ```bash
   cd backend
   ```
2. Open the `.env` file and verify or replace the variables:
   ```env
   PORT=5000
   MONGODB_URI=mongodb://localhost:27017/razorpay_demo
   RAZORPAY_KEY_ID=your_razorpay_test_key_id
   RAZORPAY_KEY_SECRET=your_razorpay_test_key_secret
   RAZORPAY_WEBHOOK_SECRET=your_webhook_secret_key
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```

### 2. Frontend Setup
1. Open another terminal and navigate to `frontend/`:
   ```bash
   cd frontend
   ```
2. Run the Next.js development server:
   ```bash
   npm run dev
   ```
3. Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🔒 How Edge Cases are Solved in this Codebase

### 1. Money Representation & Pricing Authority
* **Paise Conversion**: Razorpay requires payment values in Paise (e.g. ₹499.00 must be `49900`). The conversion is done strictly by multiplying by `100` and rounding (`Math.round(rupees * 100)`) on the server.
* **Server-side Price Calculation**: The client never determines the price. It only passes an item ID (`starter-pack`, `premium-sub`, `pro-course`). The backend looks up the canonical pricing internally, preventing price tampering. See [payment.routes.ts](file:///d:/Projects/razorpay_v1/backend/src/routes/payment.routes.ts#L9-L21).

### 2. Client Response & Signature Safety
* **SHA256 Signature Verification**: We do not trust the browser callback for successful payments. The frontend passes the checkout-generated `razorpay_order_id`, `razorpay_payment_id`, and `razorpay_signature`. The backend signs the concatenated data using the private `RAZORPAY_KEY_SECRET` and performs validation on the server.
* **Secret Key Safety**: The secret API keys live strictly in the backend `.env` variables and are never bundled or transmitted to the client code. See [razorpay.ts](file:///d:/Projects/razorpay_v1/backend/src/utils/razorpay.ts#L4-L20).

### 3. Webhook Integrity
* **Raw Body signature check**: Express JSON parsers clean/alter string spaces. To prevent validation failure, a custom middleware captures the raw body stream buffer on `/api/webhooks` before any JSON transformation. Webhooks are validated against the raw string. See [server.ts](file:///d:/Projects/razorpay_v1/backend/src/server.ts#L17-L22).
* **Strict Webhook Idempotency**: Each webhook event generates an event ID combination. We check our `WebhookEvent` database collection before processing. If an event has already been processed, it immediately exits. See [payment.routes.ts](file:///d:/Projects/razorpay_v1/backend/src/routes/payment.routes.ts#L157-L168).
* **Out-of-Order Webhooks**: State transitions are guard-checked. We do not downgrade a `captured` order back to `created` or mark it `failed` if an old or late event arrives out of order. See [payment.routes.ts](file:///d:/Projects/razorpay_v1/backend/src/routes/payment.routes.ts#L202-L209).
* **Asynchronous Response Delivery**: When a valid webhook arrives, we verify the signature, log the event ID in MongoDB, and immediately return `200 OK` back to Razorpay (resolving within milliseconds). The actual processing of updating order statuses is done asynchronously in the background.

### 4. Confused Order & Payment States
* **Orphan Webhooks**: If a server crashes or database write fails immediately after creating a Razorpay order but before local save, a webhook for `payment.captured` will arrive for an unrecognized ID. The backend handles this by dynamically creating the missing order record as `created-from-webhook` and proceeding to mark it paid. See [payment.routes.ts](file:///d:/Projects/razorpay_v1/backend/src/routes/payment.routes.ts#L210-L219).
* **Reconciliation Cron Job**: A scheduled cron job queries all local orders in `created` status. It polls the Razorpay API. If the API shows the order has been successfully completed, the database is synced. See [sync.ts](file:///d:/Projects/razorpay_v1/backend/src/cron/sync.ts#L13-L58).
* **Multiple Attempts**: If a payment fails and the user retries, multiple payments might map to one order. Only the first successful signature-verified capture marks the master order as `captured`. Subsequent failures do not override it.

### 5. Delayed Payments & Manual Capture Timeout
* **Automatic capture prevention**: If the capture mode is set to manual, payments can get stuck in the `authorized` state. If left uncaptured, Razorpay auto-refunds them in 5 days. The cron job actively scans for `authorized` payments and calls the Razorpay Capture API to secure the funds. See [sync.ts](file:///d:/Projects/razorpay_v1/backend/src/cron/sync.ts#L59-L87).

### 6. Refund Constraints
* **State & Value validations**: The `/api/refunds` API verifies that the order status is currently `captured` (pre-condition). It compares the request amount with the remaining balance (`amount - amountRefunded`) to prevent duplicate refund leaks and tracks partial refunds. See [payment.routes.ts](file:///d:/Projects/razorpay_v1/backend/src/routes/payment.routes.ts#L294-L322).

### 7. Script Ad-Blockers & Timeout Handling
* **Script Load Check**: The Next.js frontend checks if `window.Razorpay` exists. If an ad-blocker blocks the CDN checkout script, the dashboard presents a clear warnings banner and disables checkout buttons to prevent dead clicks. See [page.tsx](file:///d:/Projects/razorpay_v1/frontend/src/app/page.tsx#L60-L72).
