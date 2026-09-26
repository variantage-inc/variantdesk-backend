import { Router } from 'express';
import { healthRouter } from './health.js';

export const api: Router = Router();

api.use('/health', healthRouter);

/* Phases add their routers here: auth, business, categories, vendors,
   transactions, clients, invoices, receipts, reports, voice. See PLAN.md. */
