import { Router } from 'express';
import { param, query } from '../../lib/params.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireWriteAccess } from '../../middleware/requireWriteAccess.js';
import { idempotent } from '../../middleware/idempotency.js';
import { moneyWriteLimit } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as invoices from './invoices.service.js';
import * as payments from './payments.service.js';
import * as clients from './clients.service.js';
import {
  clientSchema,
  invoiceListQuerySchema,
  invoiceSchema,
  paymentSchema,
} from './invoices.schemas.js';

export const invoicesRouter: Router = Router();

/* Clients and invoicing.

   Reading is open to anyone signed in, including a read only account: they
   keep every screen and every export. Writing needs write access, and anything
   that touches money carries `idempotent`, so a double clicked Record payment
   cannot post the same deposit twice. */

/* moneyWriteLimit: every money write, counted per person across all routes. */
const write = [requireAuth, requireWriteAccess, moneyWriteLimit, idempotent] as const;

/* --------------------------------------------------------------- clients --- */

invoicesRouter.get('/clients', requireAuth, async (req, res, next) => {
  try {
    res.json(await clients.list(req.auth!.businessId, query(req, 'search', 80)));
  } catch (err) {
    next(err);
  }
});

invoicesRouter.get('/clients/:id', requireAuth, async (req, res, next) => {
  try {
    res.json(await clients.one(req.auth!.businessId, param(req, 'id')));
  } catch (err) {
    next(err);
  }
});

invoicesRouter.post(
  '/clients',
  requireAuth,
  requireWriteAccess,
  moneyWriteLimit,
  validate(clientSchema),
  async (req, res, next) => {
    try {
      const created = await clients.create(req.auth!.businessId, req.body);
      res.status(201).json(await clients.one(req.auth!.businessId, created.id));
    } catch (err) {
      next(err);
    }
  },
);

invoicesRouter.put(
  '/clients/:id',
  requireAuth,
  requireWriteAccess,
  moneyWriteLimit,
  validate(clientSchema),
  async (req, res, next) => {
    try {
      res.json(await clients.update(req.auth!.businessId, param(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

/* Archives. A client attached to past invoices has to go on existing for six
   years, and an invoice with no billed party is not a document anybody can
   defend. Refused while they still owe you. */
invoicesRouter.delete('/clients/:id', requireAuth, requireWriteAccess, moneyWriteLimit, async (req, res, next) => {
  try {
    await clients.archive(req.auth!.businessId, param(req, 'id'));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- invoices --- */

/* What the builder needs before anything is typed: the next number, the terms
   and the wording the template adds. */
invoicesRouter.get('/invoices/new', requireAuth, async (req, res, next) => {
  try {
    res.json(await invoices.draftDefaults(req.auth!.businessId));
  } catch (err) {
    next(err);
  }
});

invoicesRouter.get('/invoices', requireAuth, async (req, res, next) => {
  try {
    const q = invoiceListQuerySchema.parse(req.query);
    res.json(await invoices.list(req.auth!.businessId, q));
  } catch (err) {
    next(err);
  }
});

invoicesRouter.get('/invoices/:id', requireAuth, async (req, res, next) => {
  try {
    res.json({ invoice: await invoices.one(req.auth!.businessId, param(req, 'id')) });
  } catch (err) {
    next(err);
  }
});

invoicesRouter.post('/invoices', ...write, validate(invoiceSchema), async (req, res, next) => {
  try {
    const invoice = await invoices.create(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      req.body,
    );
    res.status(201).json({ invoice });
  } catch (err) {
    next(err);
  }
});

invoicesRouter.put('/invoices/:id', ...write, validate(invoiceSchema), async (req, res, next) => {
  try {
    const invoice = await invoices.update(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      param(req, 'id'),
      req.body,
    );
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

/* Turns a draft into a debt the client owes. It posts no income: that happens
   when the money arrives, which is the whole point of the split. */
invoicesRouter.post('/invoices/:id/send', ...write, async (req, res, next) => {
  try {
    res.json({ invoice: await invoices.send(req.auth!.businessId, param(req, 'id')) });
  } catch (err) {
    next(err);
  }
});

/* Voids. The number stays in the sequence, because an invoice number is never
   reissued. */
invoicesRouter.delete('/invoices/:id', ...write, async (req, res, next) => {
  try {
    await invoices.voidInvoice(req.auth!.businessId, param(req, 'id'));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- payments --- */

invoicesRouter.get('/invoices/:id/payment-context', requireAuth, async (req, res, next) => {
  try {
    res.json(await payments.paymentContext(req.auth!.businessId, param(req, 'id')));
  } catch (err) {
    next(err);
  }
});

/* The one place a payment is recorded, and the one place income is posted for
   an invoice. There is deliberately no second door. */
invoicesRouter.post(
  '/invoices/:id/payments',
  ...write,
  validate(paymentSchema),
  async (req, res, next) => {
    try {
      const invoice = await payments.record(
        { businessId: req.auth!.businessId, userId: req.auth!.userId },
        param(req, 'id'),
        req.body,
      );
      res.status(201).json({ invoice });
    } catch (err) {
      next(err);
    }
  },
);

/* Reverses the income entry the payment posted, so the books follow the
   invoice rather than being corrected separately. */
invoicesRouter.delete('/invoices/:id/payments/:paymentId', ...write, async (req, res, next) => {
  try {
    const invoice = await payments.remove(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      param(req, 'id'),
      param(req, 'paymentId'),
    );
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});
