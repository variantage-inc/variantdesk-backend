import { Router } from 'express';
import { healthRouter } from './health.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { billingRouter } from '../modules/billing/billing.routes.js';
import { teamRouter } from '../modules/team/team.routes.js';
import { settingsRouter } from '../modules/settings/settings.routes.js';
import { adminRouter } from '../modules/admin/admin.routes.js';
import { transactionsRouter } from '../modules/transactions/transactions.routes.js';
import { invoicesRouter } from '../modules/invoices/invoices.routes.js';
import { reportingRouter } from '../modules/reporting/reporting.routes.js';
import { voiceRouter } from '../modules/voice/voice.routes.js';

export const api: Router = Router();

api.use('/health', healthRouter);
api.use('/auth', authRouter);
api.use('/billing', billingRouter);
api.use('/team', teamRouter);
api.use('/settings', settingsRouter);
api.use('/admin', adminRouter);

/* Money in and out. Mounted at the root of the API rather than under a
   /transactions prefix, so the paths read as /api/income and /api/expenses,
   which is what the screens are called. */
api.use('/', transactionsRouter);

/* Clients and invoicing. Also mounted at the root, so the paths read as
   /api/clients and /api/invoices. */
api.use('/', invoicesRouter);

/* The dashboard, and the reports it will share its arithmetic with. */
api.use('/', reportingRouter);

/* Dictating an entry. Mounted at the root so the paths read as /api/voice,
   and note that the clip arrives as a raw body: express.json never sees it,
   because the route declares its own parser for audio content types. */
api.use('/', voiceRouter);

/* Later phases add their routers here: receipts. */
