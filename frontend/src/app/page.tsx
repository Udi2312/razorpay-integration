'use client';

import React, { useEffect, useState, useRef } from 'react';

/**
 * @page / (Root page of the checkout application)
 * @receives 
 *   - User interaction events (click payment, submit refund, dispatch mock webhook event).
 *   - Live polling database records (Orders, Payments, Webhooks, Logs) from backend `/api/dashboard`.
 * @does 
 *   1. Displays the products and enables checkout via Razorpay Checkout pop-ups.
 *   2. Detects ad-blockers preventing the Razorpay SDK script from loading.
 *   3. Offers a full administration console for issuing refunds and triggering database cron syncs.
 *   4. Employs a webhook simulation dashboard to locally test signed event logic.
 *   5. Polls and monitors the backend MongoDB state dynamically every 4 seconds.
 * @returns React JSX nodes rendering the checkout store, live databases logs console, and management controls.
 * @consequence If this page is missing: Customers cannot view the catalog or pay for anything. 
 *              Developers and administrators would also lack a GUI to trigger cron jobs, request refunds, 
 *              or monitor MongoDB changes visually.
 */
// Backend URL configuration
const BACKEND_URL = 'http://localhost:5000/api';

interface DBOrder {
  _id: string;
  orderId: string;
  itemId: string;
  amount: number;
  currency: string;
  status: string;
  amountRefunded: number;
  createdAt: string;
}

interface DBPayment {
  _id: string;
  paymentId: string;
  orderId: string;
  amount: number;
  status: string;
  method: string;
  email?: string;
  contact?: string;
  errorDescription?: string;
}

interface DBWebhook {
  _id: string;
  eventId: string;
  processed: boolean;
  receivedAt: string;
}

interface DBLog {
  _id: string;
  level: string;
  message: string;
  meta?: any;
  timestamp: string;
}

const ITEMS = [
  { id: 'starter-pack', name: 'Starter Developer Pack', price: 99, desc: 'Ideal for experimenting with basic hooks.' },
  { id: 'premium-sub', name: 'Monthly Premium Sub', price: 499, desc: 'Get access to elite API endpoints and limits.' },
  { id: 'pro-course', name: 'Full-Stack Integration Course', price: 1499, desc: 'Comprehensive video tutorials on payment security.' },
];

export default function RazorpayDemoPage() {
  // Data lists from DB
  const [orders, setOrders] = useState<DBOrder[]>([]);
  const [payments, setPayments] = useState<DBPayment[]>([]);
  const [webhooks, setWebhooks] = useState<DBWebhook[]>([]);
  const [logs, setLogs] = useState<DBLog[]>([]);

  // UI state
  const [adBlockerActive, setAdBlockerActive] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  
  // Checkout flow state
  const [activePaymentStep, setActivePaymentStep] = useState<string | null>(null);
  const checkoutTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Forms state
  const [refundOrderId, setRefundOrderId] = useState<string>('');
  const [refundAmount, setRefundAmount] = useState<number>(0);

  // Webhook Simulator state
  const [simEvent, setSimEvent] = useState<string>('payment.captured');
  const [simOrderId, setSimOrderId] = useState<string>('');
  const [simPaymentId, setSimPaymentId] = useState<string>('');
  const [simAmount, setSimAmount] = useState<number>(99);

  // Tabs for the data panel
  const [activeTab, setActiveTab] = useState<'orders' | 'payments' | 'webhooks' | 'logs'>('orders');

  // Check if Razorpay script is loaded (Ad blocker check)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!(window as any).Razorpay) {
        setAdBlockerActive(true);
        setStatusMessage({
          type: 'error',
          text: 'Razorpay script was blocked. Please check if you have an active Ad blocker enabled.'
        });
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  // Fetch dashboard data
  const fetchDashboardData = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/dashboard`);
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders || []);
        setPayments(data.payments || []);
        setWebhooks(data.webhooks || []);
        setLogs(data.logs || []);
      }
    } catch (error) {
      console.error('Error fetching dashboard details:', error);
    }
  };

  // Poll for database updates every 4 seconds to simulate real-time event streaming
  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 4000);
    return () => clearInterval(interval);
  }, []);

  // Show status wrapper helper
  const showStatus = (type: 'success' | 'error' | 'info', text: string) => {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage(null), 8000);
  };

  // 1. Trigger Razorpay Checkout
  const handlePay = async (itemId: string) => {
    setIsLoading(true);
    setStatusMessage(null);
    setActivePaymentStep('Creating order on server...');

    try {
      // Step A: Contact Node.js backend to construct order (rupees converted to paise securely on server)
      const orderRes = await fetch(`${BACKEND_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
      });

      if (!orderRes.ok) {
        const errData = await orderRes.json();
        throw new Error(errData.error || 'Failed to create order on server');
      }

      const orderData = await orderRes.json();
      setActivePaymentStep('Launching secure Razorpay popup...');

      // Step B: Build client configuration
      if (!(window as any).Razorpay) {
        throw new Error('Razorpay SDK script not loaded. Check ad-blockers.');
      }

      const options = {
        key: orderData.keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Razorpay Integration Lab',
        description: orderData.itemName,
        order_id: orderData.orderId,
        
        // Browser success handler
        handler: async function (response: any) {
          // Signature, order id, payment id are returned to browser
          setActivePaymentStep('Verifying payment signature securely on backend...');
          
          try {
            const verifyRes = await fetch(`${BACKEND_URL}/payments/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                orderId: orderData.orderId,
                paymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
              }),
            });

            const verifyData = await verifyRes.json();
            if (verifyRes.ok && verifyData.success) {
              showStatus('success', `Payment captured & signature verified! ID: ${response.razorpay_payment_id}`);
            } else {
              showStatus('error', `Signature verification failed: ${verifyData.error}`);
            }
          } catch (err: any) {
            showStatus('error', `Verification route failed: ${err.message}`);
          } finally {
            setActivePaymentStep(null);
            fetchDashboardData();
          }
        },
        
        // Modal styling and callbacks
        modal: {
          ondismiss: function () {
            setActivePaymentStep(null);
            setIsLoading(false);
            showStatus('info', 'Secure payment window closed by user.');
          },
        },
        prefill: {
          name: 'Demo Customer',
          email: 'customer@example.com',
          contact: '+919999999999',
        },
        theme: {
          color: '#3b82f6',
        },
      };

      const rzp = new (window as any).Razorpay(options);
      
      // Setup window checkout fallback timer
      if (checkoutTimeoutRef.current) clearTimeout(checkoutTimeoutRef.current);
      checkoutTimeoutRef.current = setTimeout(() => {
        setActivePaymentStep(null);
        setIsLoading(false);
      }, 300000); // 5 minutes timeout protection

      rzp.open();

    } catch (error: any) {
      showStatus('error', error.message);
      setActivePaymentStep(null);
    } finally {
      setIsLoading(false);
    }
  };

  // 2. Request Refund
  const handleRequestRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundOrderId || refundAmount <= 0) {
      showStatus('error', 'Please provide a valid Order ID and positive refund amount.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/refunds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: refundOrderId, amountRupees: refundAmount }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        showStatus('success', `Refund processed successfully! Updated Order status: ${data.orderStatus}`);
        setRefundOrderId('');
        setRefundAmount(0);
      } else {
        showStatus('error', `Refund failed: ${data.error || 'Server error'}`);
      }
    } catch (err: any) {
      showStatus('error', `Refund exception: ${err.message}`);
    } finally {
      setIsLoading(false);
      fetchDashboardData();
    }
  };

  // 3. Trigger manual Cron Reconciliation
  const handleTriggerCron = async () => {
    setIsLoading(true);
    showStatus('info', 'Triggering database-to-Razorpay cron synchronization...');
    try {
      const res = await fetch(`${BACKEND_URL}/cron/trigger`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showStatus('success', 'Cron reconciliation complete. Check database lists for updates!');
      } else {
        showStatus('error', `Cron failed: ${data.error}`);
      }
    } catch (err: any) {
      showStatus('error', `Cron network error: ${err.message}`);
    } finally {
      setIsLoading(false);
      fetchDashboardData();
    }
  };

  // 4. Simulate Webhook (Tests Raw body check, out-of-order check, orphan detection, idempotency)
  const handleSimulateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      const res = await fetch(`${BACKEND_URL}/webhooks/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: simEvent,
          orderId: simOrderId || undefined,
          paymentId: simPaymentId || undefined,
          amountRupees: simAmount,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        showStatus('success', `Simulated webhook ${simEvent} dispatched successfully!`);
      } else {
        showStatus('error', `Webhook simulation failed: ${data.error}`);
      }
    } catch (err: any) {
      showStatus('error', `Simulation exception: ${err.message}`);
    } finally {
      setIsLoading(false);
      fetchDashboardData();
    }
  };

  return (
    <div className="container">
      {/* Header */}
      <header style={{ marginBottom: '2.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1.5rem' }}>
        <h1>Razorpay Secure Payment Integration</h1>
        <p>Next.js & Node.js checkout flow with signature check, Webhook parser, cron sync and safety overrides.</p>
      </header>

      {/* Warning/Alert banners */}
      {adBlockerActive && (
        <div className="alert-banner">
          <div style={{ fontSize: '1.5rem' }}>🛡️</div>
          <div>
            <div className="alert-title">Ad Blocker Detected</div>
            <p style={{ fontSize: '0.85rem', color: '#f59e0b' }}>
              We detected that the Razorpay checkout script failed to load. Please disable ad-blocking extensions (like uBlock Origin, AdBlock) for this page to checkout.
            </p>
          </div>
        </div>
      )}

      {statusMessage && (
        <div 
          className="alert-banner" 
          style={{ 
            background: statusMessage.type === 'success' ? 'var(--success-bg)' : statusMessage.type === 'error' ? 'var(--danger-bg)' : 'var(--warning-bg)',
            borderColor: statusMessage.type === 'success' ? 'var(--success)' : statusMessage.type === 'error' ? 'var(--danger)' : 'var(--warning)'
          }}
        >
          <div>{statusMessage.type === 'success' ? '✅' : statusMessage.type === 'error' ? '❌' : 'ℹ️'}</div>
          <div style={{ color: statusMessage.type === 'success' ? 'var(--success)' : statusMessage.type === 'error' ? 'var(--danger)' : 'var(--warning)', fontWeight: 600 }}>
            {statusMessage.text}
          </div>
        </div>
      )}

      {activePaymentStep && (
        <div className="alert-banner" style={{ background: 'rgba(59, 130, 246, 0.1)', borderColor: 'var(--primary)' }}>
          <div className="spinner" style={{ border: '3px solid rgba(255,255,255,0.1)', borderTop: '3px solid var(--primary)', borderRadius: '50%', width: '20px', height: '20px', animation: 'spin 1s linear infinite' }} />
          <style dangerouslySetInnerHTML={{__html: `
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          `}} />
          <div style={{ color: 'var(--primary)', fontWeight: 600 }}>
            Active Payment Step: {activePaymentStep}
          </div>
        </div>
      )}

      {/* Main Grid layout */}
      <div className="dashboard-grid">
        
        {/* Left Side: Store Front & Admin Actions */}
        <div className="sub-grid" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          {/* Store Catalog */}
          <div className="card">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>🛒 Store Catalog</h2>
            <p style={{ fontSize: '0.85rem', marginBottom: '1.5rem' }}>
              Select a product. Price calculation is verified solely on the server side in Paise.
            </p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {ITEMS.map((item) => (
                <div key={item.id} className="card product-card" style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)' }}>
                  <div>
                    <h3>{item.name}</h3>
                    <p style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>{item.desc}</p>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem' }}>
                    <div className="price-tag" style={{ margin: 0, fontSize: '1.5rem' }}>
                      ₹{item.price}<span>INR</span>
                    </div>
                    <button 
                      className="btn btn-primary" 
                      style={{ width: 'auto', padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                      onClick={() => handlePay(item.id)}
                      disabled={isLoading || adBlockerActive}
                    >
                      Buy Now
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Admin Actions */}
          <div className="card">
            <h2>⚙️ System Controls</h2>
            <p style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
              Reconcile order state differences (e.g. if webhooks failed or payments are authorized but uncaptured).
            </p>
            <button 
              className="btn btn-secondary" 
              onClick={handleTriggerCron}
              disabled={isLoading}
              style={{ display: 'flex', gap: '0.5rem', fontWeight: 'bold' }}
            >
              🔄 Trigger Cron Sync Job
            </button>
          </div>

          {/* Refund Admin */}
          <div className="card">
            <h2>💸 Issue Refund</h2>
            <form onSubmit={handleRequestRefund} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div>
                <label>Order ID (rzp_order_*)</label>
                <input 
                  type="text" 
                  className="input-field" 
                  placeholder="e.g. order_OPBszpW283" 
                  value={refundOrderId}
                  onChange={(e) => setRefundOrderId(e.target.value)}
                  required
                />
              </div>
              <div>
                <label>Refund Amount (Rupees)</label>
                <input 
                  type="number" 
                  step="0.01"
                  className="input-field" 
                  placeholder="e.g. 99"
                  value={refundAmount || ''}
                  onChange={(e) => setRefundAmount(parseFloat(e.target.value) || 0)}
                  required
                />
              </div>
              <button className="btn btn-secondary" type="submit" disabled={isLoading} style={{ border: '1px solid rgba(239, 68, 68, 0.4)', color: '#ef4444' }}>
                Process Refund
              </button>
            </form>
          </div>

        </div>

        {/* Right Side: Database Monitor & Webhook Simulator */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          {/* Webhook Simulator Card */}
          <div className="card" style={{ border: '1px dashed var(--primary)' }}>
            <h2 style={{ color: 'var(--primary)' }}>🤖 Webhook Event Simulator</h2>
            <p style={{ fontSize: '0.85rem', marginBottom: '1.25rem' }}>
              Simulate signed Razorpay webhook payloads. Useful to test <strong>idempotency, orphan order handling, and out-of-order logs</strong> locally.
            </p>
            
            <form onSubmit={handleSimulateWebhook} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
              <div>
                <label>Webhook Event Type</label>
                <select className="input-field" value={simEvent} onChange={(e) => setSimEvent(e.target.value)}>
                  <option value="payment.captured">payment.captured</option>
                  <option value="payment.failed">payment.failed</option>
                  <option value="refund.created">refund.created (Simulates refund update)</option>
                </select>
              </div>
              <div>
                <label>Razorpay Order ID</label>
                <input 
                  type="text" 
                  className="input-field" 
                  placeholder="Leave blank for orphan simulation"
                  value={simOrderId}
                  onChange={(e) => setSimOrderId(e.target.value)}
                />
              </div>
              <div>
                <label>Payment ID</label>
                <input 
                  type="text" 
                  className="input-field" 
                  placeholder="Leave blank to auto-generate"
                  value={simPaymentId}
                  onChange={(e) => setSimPaymentId(e.target.value)}
                />
              </div>
              <div>
                <label>Amount (Rupees)</label>
                <input 
                  type="number" 
                  className="input-field" 
                  placeholder="99"
                  value={simAmount}
                  onChange={(e) => setSimAmount(parseFloat(e.target.value) || 0)}
                />
              </div>
              <div style={{ gridColumn: '1 / -1', marginTop: '0.5rem' }}>
                <button type="submit" className="btn btn-secondary" style={{ borderColor: 'var(--primary)', color: 'var(--primary)' }} disabled={isLoading}>
                  ⚡ Dispatch Signature-Verified Webhook
                </button>
              </div>
            </form>
          </div>

          {/* Database & Logs Monitor */}
          <div className="card">
            <h2>🖥️ Live Database Monitor</h2>
            <p style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
              Inspects MongoDB collections. Updates live every 4 seconds.
            </p>

            <div className="tab-headers">
              <button className={`tab-btn ${activeTab === 'orders' ? 'active' : ''}`} onClick={() => setActiveTab('orders')}>Orders ({orders.length})</button>
              <button className={`tab-btn ${activeTab === 'payments' ? 'active' : ''}`} onClick={() => setActiveTab('payments')}>Payment Attempts ({payments.length})</button>
              <button className={`tab-btn ${activeTab === 'webhooks' ? 'active' : ''}`} onClick={() => setActiveTab('webhooks')}>Webhook Log ({webhooks.length})</button>
              <button className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>Audit Logs ({logs.length})</button>
            </div>

            {/* Tab content */}
            {activeTab === 'orders' && (
              <div className="data-table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Order ID</th>
                      <th>Product</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Refunded</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.length === 0 ? (
                      <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No orders in MongoDB yet.</td></tr>
                    ) : (
                      orders.map((o) => (
                        <tr key={o._id}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{o.orderId}</td>
                          <td>{o.itemId}</td>
                          <td>₹{(o.amount / 100).toFixed(2)}</td>
                          <td>
                            <span className={`badge badge-${
                              o.status === 'captured' ? 'success' : o.status === 'created' ? 'warning' : 'danger'
                            }`}>
                              {o.status}
                            </span>
                          </td>
                          <td>₹{(o.amountRefunded / 100).toFixed(2)}</td>
                          <td>
                            {(o.status === 'captured' || o.status === 'partially_refunded') && (
                              <button 
                                className="btn btn-secondary" 
                                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', width: 'auto', color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.2)' }}
                                onClick={() => {
                                  setRefundOrderId(o.orderId);
                                  setRefundAmount(o.amount / 100 - o.amountRefunded / 100);
                                }}
                              >
                                Refund
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'payments' && (
              <div className="data-table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Payment ID</th>
                      <th>Order ID</th>
                      <th>Amount</th>
                      <th>Method</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.length === 0 ? (
                      <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No payment attempts logged.</td></tr>
                    ) : (
                      payments.map((p) => (
                        <tr key={p._id}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{p.paymentId}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{p.orderId}</td>
                          <td>₹{(p.amount / 100).toFixed(2)}</td>
                          <td>{p.method}</td>
                          <td>
                            <span className={`badge badge-${
                              p.status === 'captured' ? 'success' : p.status === 'authorized' ? 'warning' : 'danger'
                            }`}>
                              {p.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'webhooks' && (
              <div className="data-table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Webhook Event ID (Idempotency Key)</th>
                      <th>Status</th>
                      <th>Received At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {webhooks.length === 0 ? (
                      <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No webhook events recorded.</td></tr>
                    ) : (
                      webhooks.map((w) => (
                        <tr key={w._id}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{w.eventId}</td>
                          <td><span className="badge badge-success">Processed</span></td>
                          <td style={{ color: 'var(--text-muted)' }}>{new Date(w.receivedAt).toLocaleTimeString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'logs' && (
              <div className="console">
                {logs.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)' }}>Console buffer is empty. Start transactions to generate logs.</div>
                ) : (
                  logs.map((l) => (
                    <div key={l._id} className="console-entry">
                      <span className="console-timestamp">[{new Date(l.timestamp).toLocaleTimeString()}]</span>
                      <span className={`console-level-${l.level}`} style={{ fontWeight: 'bold', marginRight: '0.5rem' }}>
                        {l.level.toUpperCase()}
                      </span>
                      <span>{l.message}</span>
                      {l.meta && Object.keys(l.meta).length > 0 && (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                          (Meta: {JSON.stringify(l.meta)})
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

          </div>

        </div>

      </div>
    </div>
  );
}
