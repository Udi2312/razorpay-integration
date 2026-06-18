import express from 'express';
import cors from 'cors';
import { PORT } from './config/config';
import { connectDB } from './database/db';
import paymentRouter from './routes/payment.routes';
import { startCronScheduler } from './cron/sync';

const app = express();

// Enable CORS
app.use(cors({
  origin: '*', // For local/demo purposes. Set to production domain in live.
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-razorpay-signature'],
}));

// CRITICAL MIDDLEWARE: Capture raw body bytes specifically for Webhooks signature validation
app.use('/api/webhooks', express.raw({ type: 'application/json' }), (req, res, next) => {
  (req as any).rawBody = req.body ? req.body.toString('utf8') : '';
  next();
});

// JSON parser for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log request info
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routing
app.use('/api', paymentRouter);

// Basic health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// Initialize DB, start server, and launch Cron Sync job
async function startServer() {
  await connectDB();
  
  app.listen(PORT, () => {
    console.log(`Node Express Server running on port ${PORT}`);
    
    // Start Cron scheduler
    startCronScheduler();
  });
}

startServer();
