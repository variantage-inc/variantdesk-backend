import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { isDev } from '../../lib/env.js';
import { billingConfigured } from '../../lib/stripe.js';
import { MAX_EXTRA_SEATS, PLANS, EXTRA_SEAT_CENTS, TRIAL_DAYS } from '../../lib/plans.js';
import { requireAuth, requireOwner } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { ApiError } from '../../middleware/error.js';
import * as billing from './billing.service.js';
import { isStaffBusiness } from '../../lib/staff.js';
import type { RequestHandler } from 'express';

export const billingRouter: Router = Router();

/* The staff business is never billed, so nothing here may start a checkout,
   change its plan or open a card portal for it. */
const notStaff: RequestHandler = (req, _res, next) =>
  isStaffBusiness(req.auth!.businessId)
    ? next(new ApiError(403, 'The Variantage staff account is not billed.', 'staff_not_billed'))
    : next();

/* Everything below is owner only except the status read.

   A member can see that the account is on its trial, because that changes what
   the screen tells them. They cannot change the plan, the seats or the card:
   the person paying decides that, and a member who could cancel could lock the
   owner out of their own books. */

billingRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    res.json({
      access: await billing.getAccess(req.auth!.businessId),
      /* The interface needs to know whether to offer a card at all. Without
         this it would show a button that always fails. */
      billingConfigured: billingConfigured(),
      catalogue: {
        trialDays: TRIAL_DAYS,
        maxExtraSeats: MAX_EXTRA_SEATS,
        extraSeatCents: EXTRA_SEAT_CENTS,
        plans: Object.entries(PLANS).map(([id, p]) => ({
          id,
          name: p.name,
          monthlyCents: p.monthlyCents,
          humanSupport: p.humanSupport,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

const planSchema = z.object({
  plan: z.enum(['ESSENTIAL', 'SOLUTIONS_360'], { message: 'Choose a plan.' }),
  extraSeats: z.coerce
    .number()
    .int('Choose a whole number of people.')
    .min(0, 'That cannot be negative.')
    .max(MAX_EXTRA_SEATS, `You can add up to ${MAX_EXTRA_SEATS} people besides yourself.`)
    .default(0),
});

billingRouter.put(
  '/plan',
  requireAuth,
  requireOwner,
  notStaff,
  validate(planSchema),
  async (req, res, next) => {
    try {
      res.json({ access: await billing.choosePlan(req.auth!.businessId, req.body.plan, req.body.extraSeats) });
    } catch (err) {
      next(err);
    }
  },
);

/* Where to come back to after Stripe. Constrained to a path on our own site,
   because a full URL here would be an open redirect: anyone could send someone
   a checkout link that returns them to a page the attacker controls. */
/* Where to send somebody back to once Stripe has finished with them.

   A path on this site, and nothing else: no scheme, no host, no protocol
   relative `//evil.example`, which is how a return URL becomes an open
   redirect. The fragment IS allowed, because the settings screen chooses its
   tab from it and the real call is `/settings#billing`. */
const returnSchema = z.object({
  returnPath: z
    .string()
    .regex(/^\/[A-Za-z0-9\-._~/]*(#[A-Za-z0-9\-._~]*)?$/, 'That is not a page on this site.')
    .max(120)
    .default('/settings'),
});

billingRouter.post(
  '/checkout',
  requireAuth,
  requireOwner,
  notStaff,
  validate(returnSchema),
  async (req, res, next) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: req.auth!.userId },
        select: { email: true },
      });
      res.json(
        await billing.startCheckout(req.auth!.businessId, user.email, req.body.returnPath),
      );
    } catch (err) {
      next(err);
    }
  },
);

billingRouter.post(
  '/portal',
  requireAuth,
  requireOwner,
  notStaff,
  validate(returnSchema),
  async (req, res, next) => {
    try {
      res.json(await billing.billingPortal(req.auth!.businessId, req.body.returnPath));
    } catch (err) {
      next(err);
    }
  },
);

billingRouter.get('/payments', requireAuth, requireOwner, async (req, res, next) => {
  try {
    res.json({ payments: await billing.listPayments(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------- development only --

   Day 15 is the interesting day, and waiting fourteen of them to see what it
   looks like is not a test plan. This moves the trial end so the read only
   state can be checked in a browser now.

   It is unreachable outside development: the route is not registered when
   NODE_ENV is anything else, so it cannot be left on by an environment
   variable somebody forgot. */
if (isDev) {
  const simulateSchema = z.object({
    state: z.enum(['trial', 'expired', 'active', 'past_due', 'cancelled']),
  });

  billingRouter.post(
    '/simulate',
    requireAuth,
    requireOwner,
    notStaff,
    validate(simulateSchema),
    async (req, res, next) => {
      try {
        const businessId = req.auth!.businessId;
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;

        const shapes = {
          trial: { status: 'TRIALING' as const, trialEndsAt: new Date(now + TRIAL_DAYS * day) },
          expired: { status: 'TRIALING' as const, trialEndsAt: new Date(now - day) },
          active: { status: 'ACTIVE' as const, currentPeriodEnd: new Date(now + 30 * day) },
          past_due: { status: 'PAST_DUE' as const },
          cancelled: { status: 'CANCELED' as const },
        };

        const shape = shapes[req.body.state as keyof typeof shapes];
        if (!shape) throw new ApiError(400, 'Unknown state.', 'bad_state');

        await prisma.subscription.update({ where: { businessId }, data: shape });
        res.json({ access: await billing.getAccess(businessId) });
      } catch (err) {
        next(err);
      }
    },
  );
}
