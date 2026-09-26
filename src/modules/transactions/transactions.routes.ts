import { Router } from 'express';
import { param } from '../../lib/params.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireWriteAccess } from '../../middleware/requireWriteAccess.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import * as transactions from './transactions.service.js';
import * as historyView from './history.service.js';
import {
  activityQuerySchema,
  clientSchema,
  drawingSchema,
  expenseSchema,
  incomeSchema,
  listQuerySchema,
} from './transactions.schemas.js';

export const transactionsRouter: Router = Router();

/* Money in and out.

   Reading is open to anyone signed in, including a read only account whose
   trial has ended: they keep every screen and every export, and can add
   nothing new. Writing needs `requireWriteAccess`, and carries `idempotent`,
   so a double clicked Save cannot post the same money twice.

   Every handler is thin on purpose. The rules live in the ledger service,
   because Phase 6 will post an income entry when an invoice is paid and Phase
   10 will post one from a spoken sentence, and neither will come through
   here. */

const write = [requireAuth, requireWriteAccess, idempotent] as const;

/* ---------------------------------------------------------------- income --- */

transactionsRouter.get('/income', requireAuth, async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    res.json(await transactions.list(req.auth!.businessId, 'INCOME', q));
  } catch (err) {
    next(err);
  }
});

transactionsRouter.post('/income', ...write, validate(incomeSchema), async (req, res, next) => {
  try {
    const entry = await transactions.create(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      'INCOME',
      req.body,
    );
    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.put(
  '/income/:id',
  ...write,
  validate(incomeSchema),
  async (req, res, next) => {
    try {
      const entry = await transactions.update(
        { businessId: req.auth!.businessId, userId: req.auth!.userId },
        param(req, 'id'),
        'INCOME',
        req.body,
      );
      res.json({ entry });
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------- expenses and drawings --- */

/* One list for both, because there is one place money goes out. The Show
   filter decides which of the two is on screen. */
transactionsRouter.get('/expenses', requireAuth, async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    res.json(await transactions.list(req.auth!.businessId, 'MONEY_OUT', q));
  } catch (err) {
    next(err);
  }
});

transactionsRouter.post('/expenses', ...write, validate(expenseSchema), async (req, res, next) => {
  try {
    const entry = await transactions.create(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      'EXPENSE',
      req.body,
    );
    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.put(
  '/expenses/:id',
  ...write,
  validate(expenseSchema),
  async (req, res, next) => {
    try {
      const entry = await transactions.update(
        { businessId: req.auth!.businessId, userId: req.auth!.userId },
        param(req, 'id'),
        'EXPENSE',
        req.body,
      );
      res.json({ entry });
    } catch (err) {
      next(err);
    }
  },
);

/* A drawing has its own routes rather than a flag on the expense ones. The
   difference is not cosmetic: no tax, no vendor, a purpose note, and it must
   never reach profit. Two doors make that hard to get wrong by accident. */
transactionsRouter.post('/drawings', ...write, validate(drawingSchema), async (req, res, next) => {
  try {
    const entry = await transactions.create(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      'DRAWING',
      req.body,
    );
    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.put(
  '/drawings/:id',
  ...write,
  validate(drawingSchema),
  async (req, res, next) => {
    try {
      const entry = await transactions.update(
        { businessId: req.auth!.businessId, userId: req.auth!.userId },
        param(req, 'id'),
        'DRAWING',
        req.body,
      );
      res.json({ entry });
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------- one entry --- */

transactionsRouter.get('/entries/:id', requireAuth, async (req, res, next) => {
  try {
    res.json({ entry: await transactions.one(req.auth!.businessId, param(req, 'id')) });
  } catch (err) {
    next(err);
  }
});

/* Every version this entry has had, what changed between them, and who
   changed it. Only answerable because the ledger is append only, and the
   reason it is worth being append only. */
transactionsRouter.get('/entries/:id/history', requireAuth, async (req, res, next) => {
  try {
    res.json(await historyView.versionsOf(req.auth!.businessId, param(req, 'id')));
  } catch (err) {
    next(err);
  }
});

/* The change log for a period: every correction and every removal.

   The per entry view answers "why does this row say that". This answers the
   other question, the one that is harder to chase down on your own: a total
   moved and nobody knows why. */
transactionsRouter.get('/activity', requireAuth, async (req, res, next) => {
  try {
    const q = activityQuerySchema.parse(req.query);
    res.json(await historyView.activity(req.auth!.businessId, q));
  } catch (err) {
    next(err);
  }
});

/* DELETE writes a reversal. Nothing is removed from the ledger, ever, which is
   both the CRA's six year rule and rule 5 of the financial architecture. The
   verb is DELETE because that is what the button means to the person pressing
   it. */
transactionsRouter.delete('/entries/:id', ...write, async (req, res, next) => {
  try {
    await transactions.remove(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      param(req, 'id'),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- clients --- */

/* Just enough for the income form to attribute a payment to somebody. The
   client screens, their terms and their invoice history are Phase 6. */
transactionsRouter.get('/clients', requireAuth, async (req, res, next) => {
  try {
    res.json({ clients: await transactions.listClients(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.post(
  '/clients',
  requireAuth,
  requireWriteAccess,
  validate(clientSchema),
  async (req, res, next) => {
    try {
      const client = await transactions.createClient(req.auth!.businessId, req.body);
      res.status(201).json({ client, clients: await transactions.listClients(req.auth!.businessId) });
    } catch (err) {
      next(err);
    }
  },
);
