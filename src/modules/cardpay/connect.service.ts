import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { stripe } from '../../lib/stripe.js';
import { ApiError } from '../../middleware/error.js';

/* Linking a business's own Stripe account.

   A client paying an invoice pays the BUSINESS, never Variantage. So each
   business connects its own Stripe account (Connect, Standard) and every card
   payment is created on that account: the money lands in their balance, the
   fee comes out of it, and refunds and disputes are theirs. Variantage never
   holds a client's money and takes nothing from it.

   Onboarding is hosted by Stripe. We create the account, hand the owner a
   one-time link, and read back whether Stripe will let it take cards. */

export const cardPaymentsConfigured = (): boolean => Boolean(env.STRIPE_SECRET_KEY);

function ensureConfigured(): void {
  if (!cardPaymentsConfigured()) {
    throw new ApiError(503, 'Card payments are not switched on yet.', 'stripe_unconfigured');
  }
}

type Flags = { stripeChargesEnabled: boolean; stripeDetailsSubmitted: boolean };

/* Stripe's word on the account, copied locally. Called on return from
   onboarding and by the account.updated webhook. */
export async function syncAccount(accountId: string): Promise<Flags> {
  const account = await stripe().accounts.retrieve(accountId);
  const flags = {
    stripeChargesEnabled: account.charges_enabled === true,
    stripeDetailsSubmitted: account.details_submitted === true,
  };
  await prisma.business.updateMany({ where: { stripeAccountId: accountId }, data: flags });
  return flags;
}

export async function status(businessId: string, refresh = false) {
  const b = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { stripeAccountId: true, stripeChargesEnabled: true, stripeDetailsSubmitted: true },
  });

  let flags: Flags = b;
  /* Asked again only while it is not yet ready, or when the owner has just
     come back from Stripe. Once charges are on, the webhook keeps it true. */
  if (b.stripeAccountId && cardPaymentsConfigured() && (refresh || !b.stripeChargesEnabled)) {
    flags = await syncAccount(b.stripeAccountId);
  }

  return {
    configured: cardPaymentsConfigured(),
    connected: Boolean(b.stripeAccountId),
    chargesEnabled: flags.stripeChargesEnabled,
    detailsSubmitted: flags.stripeDetailsSubmitted,
  };
}

/* The one-time onboarding link. Creates the account the first time; after
   that the same account is resumed, so leaving halfway and coming back does
   not leave a trail of half made Stripe accounts. */
export async function onboardingLink(businessId: string, email: string) {
  ensureConfigured();

  const b = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { stripeAccountId: true, name: true, legalName: true },
  });

  let accountId = b.stripeAccountId;
  if (!accountId) {
    const account = await stripe().accounts.create({
      type: 'standard',
      country: 'CA',
      email,
      business_profile: { name: b.legalName ?? b.name },
      metadata: { businessId },
    });
    /* Only if nobody got there first. A double click must not give one
       business two Stripe accounts. */
    const claimed = await prisma.business.updateMany({
      where: { id: businessId, stripeAccountId: null },
      data: { stripeAccountId: account.id },
    });
    accountId = claimed.count
      ? account.id
      : (await prisma.business.findUniqueOrThrow({
          where: { id: businessId },
          select: { stripeAccountId: true },
        })).stripeAccountId!;
  }

  const link = await stripe().accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${env.APP_URL}/settings?stripe=retry#invoice`,
    return_url: `${env.APP_URL}/settings?stripe=back#invoice`,
  });
  return { url: link.url };
}
