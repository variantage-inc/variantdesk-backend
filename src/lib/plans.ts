/* The price list, in one place.

   Two plans that unlock exactly the same software, and a per person line at $5
   a month. The difference between Essential and 360 Solutions is a human being
   doing the bookkeeping, which is a service Variantage delivers, not a feature
   the code switches on. So nothing anywhere in this codebase branches on the
   plan, and nothing should start to.

   Prices are held in cents, like every other amount in the system, and are
   used for two things only: showing the customer what they will pay, and
   working out revenue for the admin panel. What Stripe actually charges comes
   from the Price objects in the Stripe dashboard, referenced by the ids in the
   environment. If the two ever disagree, Stripe is right and this file is
   stale. */

export type PlanId = 'ESSENTIAL' | 'SOLUTIONS_360';

export const TRIAL_DAYS = 14;

/* The owner, plus at most two other people. Both the seat stepper and the
   invite endpoint read this, so the screen cannot offer a number the billing
   will not accept. */
export const MAX_EXTRA_SEATS = 2;

export const EXTRA_SEAT_CENTS = 500;

export const PLANS: Record<PlanId, { name: string; monthlyCents: number; humanSupport: boolean }> =
  {
    ESSENTIAL: { name: 'Essential', monthlyCents: 2000, humanSupport: false },
    SOLUTIONS_360: { name: '360 Solutions', monthlyCents: 4000, humanSupport: true },
  };

/* What this account will be charged each month once the trial ends. The most
   any account can reach is $50: 360 Solutions with two extra people. */
export const monthlyTotalCents = (plan: PlanId, extraSeats: number): number =>
  PLANS[plan].monthlyCents + extraSeats * EXTRA_SEAT_CENTS;

export const trialEndFromNow = (): Date =>
  new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
