import type Stripe from 'stripe';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { MAX_EXTRA_SEATS, type PlanId, trialEndFromNow } from '../../lib/plans.js';
import {
  billingConfigured,
  extraSeatPriceId,
  mapStatus,
  periodEndOf,
  priceIdFor,
  stripe,
  trialEndParam,
} from '../../lib/stripe.js';
import { env } from '../../lib/env.js';
import { accessFrom, type Access } from './access.js';

/* Subscriptions.

   The order of events is the thing to hold on to, because it is not the order
   most SaaS products use:

     1. Signup starts a 14 day trial here, with no Stripe involvement at all.
        Everything works immediately, and it works with no keys configured.
     2. At some point the owner adds a card through Stripe Checkout. The trial
        end we already recorded is handed to Stripe as `trial_end`, so Stripe
        picks up the same deadline rather than starting a second trial.
     3. On that date Stripe charges, and tells us through a webhook.

   Doing it the other way round, taking the card before the trial starts, would
   mean nobody could use the product until Stripe was configured. */

/* Called inside the signup transaction, so an account cannot exist without the
   row that decides whether it may write. */
export const trialCreateData = (): Prisma.SubscriptionCreateWithoutBusinessInput => ({
  plan: 'ESSENTIAL',
  status: 'TRIALING',
  trialEndsAt: trialEndFromNow(),
});

export async function getAccess(businessId: string): Promise<Access> {
  const sub = await prisma.subscription.findUnique({ where: { businessId } });
  return accessFrom(sub);
}

async function requireSubscription(businessId: string) {
  const sub = await prisma.subscription.findUnique({ where: { businessId } });
  if (!sub) throw new ApiError(404, 'This account has no subscription record.', 'no_subscription');
  return sub;
}

function requireStripe(): void {
  if (!billingConfigured()) {
    throw new ApiError(
      503,
      'Card payments are not switched on yet. Your trial is unaffected.',
      'billing_unconfigured',
    );
  }
}

/* The plan and the seat count can be changed at any point during the trial,
   because until a card exists neither costs anything. Once there is a live
   Stripe subscription the same change has to be pushed to Stripe too, or the
   customer is shown one price and charged another. */
export async function choosePlan(
  businessId: string,
  plan: PlanId,
  extraSeats: number,
): Promise<Access> {
  if (extraSeats < 0 || extraSeats > MAX_EXTRA_SEATS) {
    throw new ApiError(
      400,
      `You can add up to ${MAX_EXTRA_SEATS} people besides yourself.`,
      'seat_limit',
    );
  }

  const sub = await requireSubscription(businessId);

  /* Removing seats below the number of people already using them would leave
     someone signed in to a seat nobody is paying for. The member has to be
     removed first, which is a deliberate action with its own confirmation. */
  const members = await prisma.user.count({
    where: { businessId, role: 'MEMBER', deletedAt: null },
  });
  if (extraSeats < members) {
    throw new ApiError(
      409,
      `You have ${members} other ${members === 1 ? 'person' : 'people'} on the account. Remove someone before reducing the seats.`,
      'seats_in_use',
    );
  }

  if (sub.stripeSubscriptionId) await pushToStripe(sub.id, plan, extraSeats);

  const updated = await prisma.subscription.update({
    where: { businessId },
    data: { plan, extraSeats },
  });
  return accessFrom(updated);
}

/* Mirrors a plan or seat change into the live Stripe subscription.

   Proration is left on, which is Stripe's default and the right behaviour: a
   person added on the 20th is charged for the eleven days they had, not for a
   whole month. */
async function pushToStripe(
  subscriptionRowId: string,
  plan: PlanId,
  extraSeats: number,
): Promise<void> {
  requireStripe();
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionRowId } });
  if (!sub.stripeSubscriptionId) return;

  const items: Stripe.SubscriptionUpdateParams.Item[] = [];

  if (sub.stripeBaseItemId) {
    items.push({ id: sub.stripeBaseItemId, price: priceIdFor(plan) });
  }

  const seatPrice = extraSeatPriceId();
  if (seatPrice) {
    if (sub.stripeSeatItemId) {
      /* Stripe has no quantity of zero. Dropping to nobody means deleting the
         line, and adding the first person means creating it again. */
      items.push(
        extraSeats === 0
          ? { id: sub.stripeSeatItemId, deleted: true }
          : { id: sub.stripeSeatItemId, quantity: extraSeats },
      );
    } else if (extraSeats > 0) {
      items.push({ price: seatPrice, quantity: extraSeats });
    }
  }

  if (!items.length) return;

  const updated = await stripe().subscriptions.update(sub.stripeSubscriptionId, {
    items,
    proration_behavior: 'create_prorations',
  });

  await syncFromStripe(updated);
}

/* Stripe Checkout, hosted by Stripe.

   `client_reference_id` carries our business id through the redirect, and the
   customer metadata carries it back on every later webhook, so an event can
   always be attributed without a lookup table. */
export async function startCheckout(
  businessId: string,
  email: string,
  returnPath: string,
): Promise<{ url: string }> {
  requireStripe();
  const sub = await requireSubscription(businessId);

  if (sub.stripeSubscriptionId) {
    throw new ApiError(
      409,
      'This account already has a card on file. Use Manage billing to change it.',
      'already_subscribed',
    );
  }

  const customerId = sub.stripeCustomerId ?? (await createCustomer(businessId, email));

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: priceIdFor(sub.plan), quantity: 1 },
  ];
  const seatPrice = extraSeatPriceId();
  if (seatPrice && sub.extraSeats > 0) {
    lineItems.push({ price: seatPrice, quantity: sub.extraSeats });
  }

  const trialEnd = trialEndParam(sub.trialEndsAt);

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: businessId,
    line_items: lineItems,
    /* Always take a card, even though nothing is charged today. That is the
       whole point of the model: day 15 is a silent renewal rather than a
       dunning email that gets ignored. */
    payment_method_collection: 'always',
    subscription_data: {
      /* The trial we already started, not a new one. Without this Stripe would
         add its own 14 days on top of the ones already used. */
      ...(trialEnd ? { trial_end: trialEnd } : {}),
      metadata: { businessId },
    },
    /* Canadian sales tax on our own invoice. Requires tax registrations in the
       Stripe dashboard; without them Stripe simply charges no tax, which is
       the correct behaviour until Variantage is registered. */
    automatic_tax: { enabled: true },
    customer_update: { address: 'auto' },
    success_url: `${env.APP_URL}${returnPath}?billing=done`,
    cancel_url: `${env.APP_URL}${returnPath}?billing=cancelled`,
  });

  if (!session.url) {
    throw new ApiError(502, 'Stripe did not return a checkout page. Try again.', 'no_checkout_url');
  }
  return { url: session.url };
}

async function createCustomer(businessId: string, email: string): Promise<string> {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });

  const customer = await stripe().customers.create({
    email,
    name: business.legalName ?? business.name,
    /* Read back on every webhook, so an event about a customer can be routed
       to the right business without a database scan. */
    metadata: { businessId },
  });

  await prisma.subscription.update({
    where: { businessId },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

/* The Stripe billing portal: change the card, see invoices, cancel. All of it
   is Stripe's own interface, which is why none of those screens exist here. */
export async function billingPortal(
  businessId: string,
  returnPath: string,
): Promise<{ url: string }> {
  requireStripe();
  const sub = await requireSubscription(businessId);
  if (!sub.stripeCustomerId) {
    throw new ApiError(409, 'There is no card on this account yet.', 'no_customer');
  }

  const session = await stripe().billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${env.APP_URL}${returnPath}`,
  });
  return { url: session.url };
}

/* One place writes Stripe's answer into our row, whether it came from a
   webhook or from a call we made ourselves. Everything about the subscription
   that we hold locally is derived here and nowhere else. */
export async function syncFromStripe(sub: Stripe.Subscription): Promise<void> {
  const businessId = sub.metadata?.businessId;
  const where = businessId
    ? { businessId }
    : { stripeSubscriptionId: sub.id };

  const existing = await prisma.subscription.findFirst({ where });
  if (!existing) return;

  const items = sub.items?.data ?? [];
  const seatPrice = extraSeatPriceId();
  const seatItem = seatPrice ? items.find((i) => i.price?.id === seatPrice) : undefined;
  const baseItem = items.find((i) => i !== seatItem);

  /* The plan is read back from the price Stripe is actually billing, not from
     what we asked for. If somebody changes the plan inside the Stripe
     dashboard, this is what makes the product agree with the invoice. */
  const plan =
    baseItem?.price?.id === priceIdFor('SOLUTIONS_360') ? 'SOLUTIONS_360' : existing.plan;

  await prisma.subscription.update({
    where: { id: existing.id },
    data: {
      status: mapStatus(sub.status),
      plan,
      extraSeats: seatItem?.quantity ?? (seatItem ? 1 : 0),
      stripeSubscriptionId: sub.id,
      stripeBaseItemId: baseItem?.id ?? existing.stripeBaseItemId,
      stripeSeatItemId: seatItem?.id ?? null,
      currentPeriodEnd: periodEndOf(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      /* Stripe's trial end wins once Stripe is in charge of the clock. */
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : existing.trialEndsAt,
    },
  });
}

export async function listPayments(businessId: string) {
  const rows = await prisma.payment.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: 24,
  });
  return rows.map((p) => ({
    id: p.id,
    amountCents: p.amountCents,
    currency: p.currency,
    status: p.status,
    description: p.description,
    paidAt: p.paidAt?.toISOString() ?? null,
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
  }));
}
