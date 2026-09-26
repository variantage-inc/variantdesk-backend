import Stripe from 'stripe';
import { env } from './env.js';
import type { PlanId } from './plans.js';

/* Stripe, wired but not yet keyed.

   The keys do not exist yet, and the rest of the product should not wait for
   them. So the client is built lazily and `billingConfigured()` says whether it
   can be used. Everything below is written against the real API rather than a
   stub, so switching it on is putting five values in .env and nothing else.

   Two rules that are easy to get wrong and expensive to find out about in
   production:

   Card data never touches this server. Checkout and the billing portal are
   hosted by Stripe, which is what keeps card handling out of PCI scope.

   Stripe is the authority on what has been paid; this API is the authority on
   what has been granted. They are kept in step by webhooks, never by asking
   Stripe during a request. A customer must not lose access to their own books
   because Stripe had a slow minute. */

let client: Stripe | null = null;

export const billingConfigured = (): boolean =>
  Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ESSENTIAL && env.STRIPE_PRICE_SOLUTIONS_360);

/* Throws rather than returning null, so a caller cannot accidentally treat an
   unconfigured Stripe as a Stripe that answered. Routes check
   `billingConfigured()` first and return a 503 the interface can explain. */
export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured. STRIPE_SECRET_KEY is missing.');
  }
  /* The API version is not passed. The SDK pins the one it was generated
     against, and overriding it with a date the installed types do not know
     about is how an integration ends up calling fields that no longer exist.
     Upgrading the version means upgrading the package. */
  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    /* Shows against every request in the Stripe dashboard, which is what makes
       a support conversation about one failed charge tractable. */
    appInfo: { name: 'Variantage Finance', version: '0.1.0' },
    /* Stripe retries idempotently on network errors. Two rides out a blip
       without turning a real outage into a long hang for the customer. */
    maxNetworkRetries: 2,
  });
  return client;
}

export const priceIdFor = (plan: PlanId): string =>
  plan === 'SOLUTIONS_360' ? env.STRIPE_PRICE_SOLUTIONS_360! : env.STRIPE_PRICE_ESSENTIAL!;

export const extraSeatPriceId = (): string | undefined => env.STRIPE_PRICE_EXTRA_USER;

/* Stripe refuses a trial_end nearer than 48 hours, and counts in whole seconds
   from the epoch. Anything closer than that, or already past, means the trial
   is effectively over and checkout should charge straight away. */
const TWO_DAYS_MS = 48 * 60 * 60 * 1000;

export function trialEndParam(trialEndsAt: Date | null): number | undefined {
  if (!trialEndsAt) return undefined;
  const ms = trialEndsAt.getTime();
  if (ms - Date.now() < TWO_DAYS_MS) return undefined;
  return Math.floor(ms / 1000);
}

export type LocalStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'UNPAID'
  | 'CANCELED'
  | 'INCOMPLETE';

/* Stripe's statuses arrive as lowercase strings. They are mapped into our own
   enum at the boundary, so a typo further in is a compile error rather than a
   subscription that silently never grants access.

   `incomplete_expired` and `paused` mean the same thing to us as cancelled:
   there is no live subscription, so the account is read only. */
const STATUS: Record<string, LocalStatus> = {
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  unpaid: 'UNPAID',
  canceled: 'CANCELED',
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'CANCELED',
  paused: 'CANCELED',
};

export const mapStatus = (stripeStatus: string): LocalStatus => STATUS[stripeStatus] ?? 'CANCELED';

/* Where the billing period ends.

   Stripe moved current_period_end off the subscription and onto each
   subscription item, because a subscription with several items can bill them
   on different schedules. Ours all share one cycle, so the first item is the
   answer, but the old top level field is read as a fallback for older API
   versions rather than assumed gone. */
export function periodEndOf(sub: Stripe.Subscription): Date | null {
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  const seconds =
    item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

/* Which subscription an invoice belongs to.

   Also moved: it used to be `invoice.subscription`, and is now reached through
   `invoice.parent.subscription_details`. Both are read, for the same reason as
   above. */
export function subscriptionIdOf(invoice: Stripe.Invoice): string | null {
  const parent = (
    invoice as unknown as {
      parent?: { subscription_details?: { subscription?: string | { id: string } } };
      subscription?: string | { id: string };
    }
  ).parent;

  const raw =
    parent?.subscription_details?.subscription ??
    (invoice as unknown as { subscription?: string | { id: string } }).subscription;

  if (!raw) return null;
  return typeof raw === 'string' ? raw : raw.id;
}
