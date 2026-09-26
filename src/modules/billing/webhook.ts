import type Stripe from 'stripe';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { stripe, subscriptionIdOf } from '../../lib/stripe.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { syncFromStripe } from './billing.service.js';
import * as pay from '../cardpay/pay.service.js';

/* The Stripe webhook.

   This is the only unauthenticated route in the API that changes anything, so
   three things have to be true and all three are easy to leave out:

   The signature is verified against the raw request body. Not the parsed JSON,
   which is why app.ts hands this path express.raw before express.json ever
   sees it. Re-serialising a parsed body changes the bytes and every signature
   fails, which is the single most common way this integration breaks.

   Every event is recorded by id before it is acted on. Stripe guarantees
   at-least-once delivery, so duplicates are ordinary rather than exceptional,
   and without this a redelivered invoice.paid would write a second payment.

   A 200 is returned for anything we understood, including events we ignore.
   Stripe retries on any other status, with backoff, for three days. Answering
   500 to an event type we simply do not handle would produce three days of
   pointless retries. */

const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  /* From businesses' own connected accounts: a client paying an invoice. */
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'account.updated',
]);

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['stripe-signature'];

  if (!env.STRIPE_WEBHOOK_SECRET || typeof signature !== 'string') {
    /* No secret configured means we cannot tell Stripe from anyone else, and
       an unverified webhook is a stranger claiming somebody has paid. */
    res.status(503).json({ error: { code: 'webhook_unconfigured', message: 'Not configured.' } });
    return;
  }

  let event: Stripe.Event;
  try {
    event = verify(req.body as Buffer, signature);
  } catch (err) {
    console.error('Stripe webhook signature failed:', err instanceof Error ? err.message : err);
    res.status(400).json({ error: { code: 'bad_signature', message: 'Signature check failed.' } });
    return;
  }

  /* Claim the event before doing the work. A duplicate delivery collides on the
     primary key and is acknowledged without being processed twice. */
  try {
    await prisma.webhookEvent.create({ data: { id: event.id, type: event.type } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.json({ received: true, duplicate: true });
      return;
    }
    throw err;
  }

  try {
    if (HANDLED.has(event.type)) await process(event);
  } catch (err) {
    /* The event row stays, so a retry would be skipped as a duplicate. Delete
       it so Stripe's retry gets a real second attempt, then fail loudly. */
    await prisma.webhookEvent.delete({ where: { id: event.id } }).catch(() => undefined);
    console.error(`Stripe webhook ${event.type} failed:`, err);
    res.status(500).json({ error: { code: 'webhook_failed', message: 'Try again.' } });
    return;
  }

  res.json({ received: true });
}

/* The platform secret first, then the Connect endpoint's, if one is set. */
function verify(body: Buffer, signature: string): Stripe.Event {
  try {
    return stripe().webhooks.constructEvent(body, signature, env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) throw err;
    return stripe().webhooks.constructEvent(body, signature, env.STRIPE_CONNECT_WEBHOOK_SECRET);
  }
}

async function process(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    /* A client paying one of a business's invoices, on that business's own
       Stripe account. `event.account` says which; the platform's own payments
       carry none and are ignored by these handlers. */
    case 'payment_intent.succeeded':
      await pay.paymentSucceeded(event.data.object, event.account);
      return;

    case 'payment_intent.payment_failed':
      await pay.paymentFailed(event.data.object, event.account);
      return;

    case 'charge.refunded':
      await pay.chargeRefunded(event.data.object, event.account);
      return;

    case 'account.updated': {
      const account = event.data.object;
      await prisma.business.updateMany({
        where: { stripeAccountId: account.id },
        data: {
          stripeChargesEnabled: account.charges_enabled === true,
          stripeDetailsSubmitted: account.details_submitted === true,
        },
      });
      return;
    }

    /* Checkout finished. The subscription itself arrives in its own event, so
       all this has to do is make sure we hold the customer id even if the
       subscription event lands first. */
    case 'checkout.session.completed': {
      const session = event.data.object;
      const businessId = session.client_reference_id;
      const customerId = typeof session.customer === 'string' ? session.customer : null;
      if (businessId && customerId) {
        await prisma.subscription.updateMany({
          where: { businessId },
          data: { stripeCustomerId: customerId },
        });
      }
      return;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncFromStripe(event.data.object);
      return;

    case 'invoice.paid':
      await recordPayment(event.data.object, 'PAID');
      return;

    case 'invoice.payment_failed':
      await recordPayment(event.data.object, 'FAILED');
      return;

    default:
      return;
  }
}

/* A local copy of what Stripe charged, so the billing history and the admin
   panel render from our own database rather than from a Stripe call on every
   page load. Stripe stays the authority; this is a cache with a receipt. */
async function recordPayment(invoice: Stripe.Invoice, status: 'PAID' | 'FAILED'): Promise<void> {
  const businessId = await businessFor(invoice);
  if (!businessId) return;

  const paid = status === 'PAID';

  await prisma.payment.upsert({
    where: { stripeInvoiceId: invoice.id ?? `no-id-${Date.now()}` },
    create: {
      businessId,
      stripeInvoiceId: invoice.id,
      /* Stripe already works in the smallest currency unit, so this is cents
         with no conversion and no rounding. */
      amountCents: paid ? (invoice.amount_paid ?? 0) : (invoice.amount_due ?? 0),
      currency: invoice.currency ?? 'cad',
      status,
      description: invoice.number ?? invoice.description ?? null,
      paidAt: paid && invoice.status_transitions?.paid_at
        ? new Date(invoice.status_transitions.paid_at * 1000)
        : null,
      failureReason: paid ? null : 'The card was declined or the payment could not be taken.',
    },
    update: {
      status,
      amountCents: paid ? (invoice.amount_paid ?? 0) : (invoice.amount_due ?? 0),
      paidAt: paid && invoice.status_transitions?.paid_at
        ? new Date(invoice.status_transitions.paid_at * 1000)
        : null,
    },
  });
}

/* Which business an invoice belongs to. The customer metadata is the direct
   route; the subscription id is the fallback for an invoice raised before the
   metadata was set. */
async function businessFor(invoice: Stripe.Invoice): Promise<string | null> {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : null;

  if (customerId) {
    const byCustomer = await prisma.subscription.findUnique({
      where: { stripeCustomerId: customerId },
      select: { businessId: true },
    });
    if (byCustomer) return byCustomer.businessId;
  }

  const subscriptionId = subscriptionIdOf(invoice);
  if (subscriptionId) {
    const bySub = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId: subscriptionId },
      select: { businessId: true },
    });
    if (bySub) return bySub.businessId;
  }

  return null;
}
