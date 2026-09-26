import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { param } from '../../lib/params.js';
import { requireAuth, requireOwner } from '../../middleware/requireAuth.js';
import { requireWriteAccess } from '../../middleware/requireWriteAccess.js';
import { validate } from '../../middleware/validate.js';
import { moneyWriteLimit, rateLimit } from '../../middleware/rateLimit.js';
import { ensureLink } from '../invoices/invoices.service.js';
import * as connect from './connect.service.js';
import * as pay from './pay.service.js';

export const cardpayRouter: Router = Router();

/* ------------------------------------------------ the owner's side --- */

cardpayRouter.get('/card-payments/status', requireAuth, async (req, res, next) => {
  try {
    res.json(await connect.status(req.auth!.businessId, req.query.refresh === '1'));
  } catch (err) {
    next(err);
  }
});

/* Owner only: it links a bank account to the business. Not behind write
   access, for the same reason billing is not: a lapsed account must still be
   able to get paid. */
cardpayRouter.post('/card-payments/connect', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.auth!.userId },
      select: { email: true },
    });
    res.json(await connect.onboardingLink(req.auth!.businessId, user.email));
  } catch (err) {
    next(err);
  }
});

const linkSchema = z.object({ replace: z.boolean().default(false) });

cardpayRouter.post(
  '/invoices/:id/link',
  requireAuth,
  requireWriteAccess,
  moneyWriteLimit,
  validate(linkSchema),
  async (req, res, next) => {
    try {
      res.json(await ensureLink(req.auth!.businessId, param(req, 'id')!, req.body.replace));
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------- the client's side ---

   The only routes in the product with no session. Rate limited per address,
   never cached, and kept out of search engines: a link somebody pasted into
   the wrong chat should not also be findable. */

const privately = (res: Response): void => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
};

cardpayRouter.get(
  '/public/invoices/:token',
  rateLimit(120, 15 * 60 * 1000),
  async (req, res, next) => {
    try {
      privately(res);
      res.json({ invoice: await pay.view(param(req, 'token')!) });
    } catch (err) {
      next(err);
    }
  },
);

cardpayRouter.post(
  '/public/invoices/:token/checkout',
  rateLimit(10, 15 * 60 * 1000),
  async (req, res, next) => {
    try {
      privately(res);
      res.json(await pay.checkout(param(req, 'token')!));
    } catch (err) {
      next(err);
    }
  },
);
