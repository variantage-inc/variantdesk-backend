import type Stripe from 'stripe';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { stripe } from '../../lib/stripe.js';
import { signedUrl, storageConfigured } from '../../lib/storage.js';
import { ApiError } from '../../middleware/error.js';
import { reverseIn } from '../../lib/ledger.js';
import { one } from '../invoices/invoices.service.js';
import * as payments from '../invoices/payments.service.js';

/* A client paying an invoice by card.

   Three rules, all of which already existed before this file did:

   THE WEBHOOK IS THE AUTHORITY on whether money arrived. The public page
   starts a Stripe Checkout and then waits; nothing is recorded until Stripe
   says the payment succeeded, and that event is claimed by id before it is
   acted on, so a redelivery cannot record it twice.

   THE PAYMENT GOES THROUGH payments.service.record, the same function the
   payment drawer calls. One linked income entry, a proportional share of the
   invoice's own tax, and no second way into the ledger.

   THE PUBLIC INVOICE IS THE ONLY ROUTE WITH NO SESSION. It is reached by an
   unguessable token, and it shows the document and nothing else: no ids, no
   payment history, no client list, no business settings. */

/* ------------------------------------------------------- the public page --- */

async function byToken(token: string) {
  /* The token's shape is checked before the database is asked, so a scanner
     throwing junk at this route costs nothing. */
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  return prisma.invoice.findFirst({
    where: { publicToken: token, voidedAt: null, sentAt: { not: null } },
    select: {
      id: true,
      businessId: true,
      business: {
        select: {
          currency: true,
          dateFormat: true,
          stripeAccountId: true,
          stripeChargesEnabled: true,
        },
      },
    },
  });
}

const notFound = () =>
  new ApiError(404, 'This invoice link is not valid any more. Ask for a new one.', 'not_found');

export async function view(token: string) {
  const found = await byToken(token);
  if (!found) throw notFound();

  const inv = await one(found.businessId, found.id);
  const b = found.business;

  /* A whitelist. Anything added to the owner's view of an invoice stays off
     this page unless it is added here on purpose. */
  return {
    number: inv.number,
    status: inv.status,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    paymentTermsDays: inv.paymentTermsDays,
    seller: inv.seller,
    billTo: inv.billTo,
    items: inv.items.map(({ description, quantity, unitPriceCents, lineTotalCents }) => ({
      description,
      quantity,
      unitPriceCents,
      lineTotalCents,
    })),
    subtotalCents: inv.subtotalCents,
    discountMode: inv.discountMode,
    discountValue: inv.discountValue,
    discountCents: inv.discountCents,
    taxCents: inv.taxCents,
    totalCents: inv.totalCents,
    paidCents: inv.paidCents,
    balanceCents: inv.balanceCents,
    chargeTax: inv.chargeTax,
    taxLabel: inv.taxLabel,
    notes: inv.notes,
    terms: inv.terms,
    footer: inv.footer,
    payTo: inv.payTo,
    logoUrl: inv.logoUrl,
    currency: b.currency,
    dateFormat: b.dateFormat,
    /* Pay Now is offered only when the business can actually take a card and
       there is something left to pay. */
    canPayByCard: Boolean(b.stripeAccountId && b.stripeChargesEnabled && inv.balanceCents > 0),
  };
}

/* Stripe Checkout, on the business's own account, for exactly what is owed.

   The balance is read here, at the moment the client presses Pay Now, not
   typed by anybody: a client cannot choose to pay a different figure. */
export async function checkout(token: string) {
  const found = await byToken(token);
  if (!found) throw notFound();
  const b = found.business;

  const inv = await one(found.businessId, found.id);
  if (!b.stripeAccountId || !b.stripeChargesEnabled) {
    throw new ApiError(409, 'This business does not take card payments online yet.', 'cards_off');
  }
  if (inv.balanceCents <= 0) {
    throw new ApiError(409, 'This invoice has already been paid in full.', 'already_paid');
  }

  const metadata = { kind: 'invoice', invoiceId: found.id, businessId: found.businessId };
  const back = `${env.APP_URL}/pay/${token}`;

  const session = await stripe().checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: b.currency.toLowerCase(),
            unit_amount: inv.balanceCents,
            product_data: {
              name: `Invoice ${inv.number}`,
              description: `${inv.seller.name}, ${inv.paidCents > 0 ? 'balance due' : 'amount due'}`,
            },
          },
        },
      ],
      /* On the PaymentIntent too, because that is the event the money is
         recorded from, and it is what arrives for every way of paying. */
      payment_intent_data: { metadata, description: `Invoice ${inv.number} · ${inv.billTo.name}` },
      metadata,
      success_url: `${back}?paid=1`,
      cancel_url: back,
    },
    { stripeAccount: b.stripeAccountId },
  );

  if (!session.url) throw new ApiError(502, 'Stripe did not return a payment page. Try again.', 'no_url');
  return { url: session.url };
}

/* --------------------------------------------------- what Stripe tells us --- */

/* Webhook writes have no signed in person. They are recorded against the
   owner, which is also who the payment belongs to, and the payment row says
   it came from Stripe. */
async function ownerOf(businessId: string): Promise<string> {
  const owner = await prisma.user.findFirst({
    where: { businessId, role: 'OWNER', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!owner) throw new Error(`Business ${businessId} has no owner to record a card payment against.`);
  return owner.id;
}

/* The invoice a Stripe object is about, if it is one of ours and it came from
   the account that business actually connected. A payment claiming to be for
   an invoice on some other account is ignored. */
async function invoiceFor(metadata: Stripe.Metadata | null, accountId: string | undefined) {
  if (metadata?.kind !== 'invoice' || !metadata.invoiceId || !accountId) return null;
  return prisma.invoice.findFirst({
    where: { id: metadata.invoiceId, business: { stripeAccountId: accountId } },
    select: { id: true, businessId: true },
  });
}

/* The day the money moved, in Canada. A payment at 9pm in Toronto is that
   day's income, not tomorrow's, which is what UTC would make it. */
const torontoDay = (seconds: number): Date => {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(seconds * 1000));
  return new Date(`${day}T00:00:00.000Z`);
};

export async function paymentSucceeded(pi: Stripe.PaymentIntent, accountId: string | undefined) {
  const invoice = await invoiceFor(pi.metadata, accountId);
  if (!invoice) return;

  /* Recorded once per charge, whatever else happens. The event claim already
     stops a redelivered event; this stops a second event about the same money. */
  const seen = await prisma.invoicePayment.count({ where: { stripePaymentIntentId: pi.id } });
  if (seen) return;

  /* The fee is on the balance transaction behind the charge, on the
     connected account, so it is fetched from there. */
  const full = await stripe().paymentIntents.retrieve(
    pi.id,
    { expand: ['latest_charge.balance_transaction'] },
    { stripeAccount: accountId },
  );
  const charge = typeof full.latest_charge === 'object' ? full.latest_charge : null;
  const txn =
    charge && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;

  await payments.record(
    { businessId: invoice.businessId, userId: await ownerOf(invoice.businessId) },
    invoice.id,
    {
      date: torontoDay(charge?.created ?? full.created),
      amount: full.amount_received / 100,
      method: 'CARD',
      reference: pi.id,
    },
    { paymentIntentId: pi.id, chargeId: charge?.id ?? null, feeCents: txn?.fee ?? null },
  );
}

export async function paymentFailed(pi: Stripe.PaymentIntent, accountId: string | undefined) {
  const invoice = await invoiceFor(pi.metadata, accountId);
  if (!invoice) return;
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      cardFailedAt: new Date(),
      cardFailure: (pi.last_payment_error?.message ?? 'The card was declined.').slice(0, 300),
    },
  });
}

/* A refund, whole or in part, made in the business's Stripe dashboard.

   The ledger is append only, so a refund cannot shrink the payment. It
   reverses it, and if part of the money was kept, records that part again
   against the same charge. Written so that running it twice lands in the same
   place: it compares what is recorded with what Stripe says was kept, and only
   acts on the difference. */
export async function chargeRefunded(charge: Stripe.Charge, accountId: string | undefined) {
  const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId || !accountId) return;

  const recorded = await prisma.invoicePayment.findMany({
    where: { stripePaymentIntentId: piId, business: { stripeAccountId: accountId } },
    include: { transaction: { include: { reversal: { select: { id: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  const first = recorded[0];
  if (!first) return;

  const live = recorded.filter((p) => !p.transaction.reversal);
  const kept = charge.amount - charge.amount_refunded;
  const liveCents = live.reduce((n, p) => n + p.amountCents, 0);
  if (liveCents === kept) return;

  const ctx = { businessId: first.businessId, userId: await ownerOf(first.businessId) };

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: first.businessId },
    select: { province: true },
  });
  await prisma.$transaction(async (tx) => {
    for (const p of live) {
      await reverseIn(tx, { ...ctx, province: business.province }, p.transactionId, 'Refunded by card', true);
    }
  });

  if (kept > 0) {
    await payments.record(
      ctx,
      first.invoiceId,
      {
        date: first.date,
        amount: kept / 100,
        method: 'CARD',
        reference: `${piId} (after a refund of ${(charge.amount_refunded / 100).toFixed(2)})`,
      },
      { paymentIntentId: piId, chargeId: first.stripeChargeId, feeCents: first.stripeFeeCents },
    );
  }
}
