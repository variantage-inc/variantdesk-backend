import type { Plan, Subscription, SubscriptionStatus } from '../../generated/prisma/client.js';
import { MAX_EXTRA_SEATS, PLANS, monthlyTotalCents } from '../../lib/plans.js';

/* Whether this business may write to its books right now.

   This is the whole of the entitlement system, and it is deliberately one
   boolean. Both plans unlock the same software, so there is no feature matrix,
   no per feature check and no upgrade prompt inside the application. Adding
   one later would mean the plans had stopped being what the client agreed.

   Losing access is read only, not locked out. The customer keeps every screen
   and every export and cannot add anything new. Two reasons, and both matter
   more than the pressure a hard lock would apply: the CRA requires them to
   keep six years of records, and a customer who cannot get their data out is
   a customer who tells other people so. */

export type AccessState = 'trial' | 'active' | 'expired' | 'past_due' | 'cancelled' | 'none';

export type Access = {
  state: AccessState;
  /* The only question the rest of the API asks. */
  canWrite: boolean;
  plan: Plan;
  planName: string;
  status: SubscriptionStatus;
  extraSeats: number;
  maxExtraSeats: number;
  trialEndsAt: string | null;
  /* Whole days, rounded up, so the last partial day still reads as 1 rather
     than 0. Nobody wants to be told they have no days left on the morning of
     the day they still have. */
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /* What the bill becomes when the trial ends, in cents. */
  monthlyCents: number;
  /* Whether a card has ever been given. Drives the wording rather than any
     permission: "add a card" against "update your card". */
  hasCard: boolean;
};

const daysLeft = (until: Date | null): number | null => {
  if (!until) return null;
  const ms = until.getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
};

export function accessFrom(sub: Subscription | null): Access {
  /* No subscription row at all. Only reachable for an account created before
     this phase existed, and the safe answer for a books application is read
     only rather than open. */
  if (!sub) {
    return {
      state: 'none',
      canWrite: false,
      plan: 'ESSENTIAL',
      planName: PLANS.ESSENTIAL.name,
      status: 'CANCELED',
      extraSeats: 0,
      maxExtraSeats: MAX_EXTRA_SEATS,
      trialEndsAt: null,
      trialDaysLeft: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      monthlyCents: PLANS.ESSENTIAL.monthlyCents,
      hasCard: false,
    };
  }

  const trialLive = sub.status === 'TRIALING' && !!sub.trialEndsAt && sub.trialEndsAt > new Date();

  /* The trial is checked against our own clock, not against Stripe's status
     alone. An account that never went to checkout has no Stripe subscription
     to move out of `trialing`, so without this the trial would never end. */
  let state: AccessState;
  if (trialLive) state = 'trial';
  else if (sub.status === 'ACTIVE') state = 'active';
  else if (sub.status === 'PAST_DUE' || sub.status === 'UNPAID') state = 'past_due';
  else if (sub.status === 'TRIALING') state = 'expired';
  else state = 'cancelled';

  return {
    state,
    canWrite: state === 'trial' || state === 'active',
    plan: sub.plan,
    planName: PLANS[sub.plan].name,
    status: sub.status,
    extraSeats: sub.extraSeats,
    maxExtraSeats: MAX_EXTRA_SEATS,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    trialDaysLeft: sub.status === 'TRIALING' ? daysLeft(sub.trialEndsAt) : null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    monthlyCents: monthlyTotalCents(sub.plan, sub.extraSeats),
    hasCard: Boolean(sub.stripeSubscriptionId),
  };
}
