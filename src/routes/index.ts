import { Router } from 'express';
import { healthRouter } from './health.js';
import { authRouter } from '../modules/auth/auth.routes.js';

export const api: Router = Router();

api.use('/health', healthRouter);
api.use('/auth', authRouter);

/* Later phases add their routers here: business, categories, vendors,
   transactions, clients, invoices, receipts, reports, voice. */
