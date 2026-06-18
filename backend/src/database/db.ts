import mongoose from 'mongoose';
import { AuditLog } from './models';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/razorpay_demo';

export async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Successfully connected to MongoDB.');
    
    // Log connection to AuditLog
    await AuditLog.create({
      level: 'info',
      message: 'Server started: Database connection established.',
      meta: { database: 'mongodb' }
    });
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
  }
}
