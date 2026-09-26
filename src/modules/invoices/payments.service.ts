import type { PaymentMethod } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { toCents } from '../../lib/money.js';
import { recordIn, reverseIn, splitTax, type TaxSplit } from '../../lib/ledger.js';
import { one, statusOf, type PublicInvoice } from './invoices.service.js';

/* Recording a payment on an invoice.

   This is the join between invoicing and the books, and it carries the single
   most important rule in the product: A PAYMENT WRITES ONE LINKED INCOME
   ENTRY.

   Not two. Not zero. One, written when the money arrives, joined to the
   payment so each can find the other. That is what stops revenue being counted
   twice, which is the most common error in small business books: the invoice
   is recorded as income when it is sent, and the deposit is recorded again
   when it lands.

   Everything else follows from it:

     the income screen shows the entry, marked as coming from the invoice
     that entry cannot be edited or removed from there, only from the invoice
     removing the payment reverses the entry, so the books follow the invoice
     a payment counts only while its entry is live, so there is one truth

   The entry is written through the ledger service, in the same database
   transaction as the payment, so a failure leaves neither. */

type Ctx = { businessId: string; userId: string };

export type PaymentInput = {
  date: Date;
  amount: number;
  method?: PaymentMethod | null;
  reference?: string | null;
};

export async function record(
  ctx: Ctx,
  invoiceId: string,
  input: PaymentInput,
): Promise<PublicInvoice> {
  const amountCents = toCents(input.amount);
  if (amountCents <= 0) {
    throw new ApiError(400, 'A payment has to be more than zero.', 'bad_amount');
  }

  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, businessId: ctx.businessId, voidedAt: null },
      include: {
        client: true,
        payments: { where: { transaction: { reversal: { is: null } } } },
      },
    });
    if (!invoice) throw new ApiError(404, 'That invoice no longer exists.', 'not_found');

    /* A draft is not a debt yet. Taking money against one would put income on
       the books for a document the client has never seen. */
    if (!invoice.sentAt) {
      throw new ApiError(
        409,
        'Mark the invoice as sent before recording a payment against it.',
        'invoice_is_draft',
      );
    }

    const alreadyPaid = invoice.payments.reduce((n, p) => n + p.amountCents, 0);
    const balance = invoice.totalCents - alreadyPaid;

    /* Overpayment is refused rather than absorbed. A credit balance is a
       different thing with different accounting, and quietly swallowing the
       difference would hide a typo in the amount. */
    if (amountCents > balance) {
      throw new ApiError(
        400,
        `That is more than is owed. The balance is ${(balance / 100).toFixed(2)}.`,
        'overpayment',
      );
    }

    const business = await tx.business.findUniqueOrThrow({
      where: { id: ctx.businessId },
      select: { province: true },
    });

    const split = invoice.chargeTax
      ? shareOfInvoiceTax(amountCents, invoice)
      : splitTax(amountCents, 'NONE', business.province);

    /* Through the ledger, not around it. recordIn takes this transaction, so
       the payment and its entry are written together or not at all. */
    const entry = await recordIn(
      tx,
      { ...ctx, province: business.province },
      {
        type: 'INCOME',
        date: input.date,
        description: `${invoice.number} · ${invoice.client.name}`,
        amountCents,
        /* Inclusive: the figure that arrived is the total and the tax is
           inside it, which is what a bank deposit is. */
        taxMode: invoice.chargeTax ? 'INCLUSIVE' : 'NONE',
        clientId: invoice.clientId,
        paymentMethod: input.method ?? null,
        reference: input.reference ?? null,
        split,
      },
    );

    await tx.invoicePayment.create({
      data: {
        businessId: ctx.businessId,
        invoiceId: invoice.id,
        date: input.date,
        amountCents,
        method: input.method ?? null,
        reference: input.reference ?? null,
        transactionId: entry.id,
        createdById: ctx.userId,
      },
    });
  });

  return one(ctx.businessId, invoiceId);
}

/* A part payment carries a proportional share of the invoice's own tax.

   Half of a $1,130 invoice is $565, of which $65 is tax, not $565 of revenue
   with the tax settled later. Worked out from the invoice's stored totals
   rather than re-derived from the rate, for two reasons: the parts then always
   add back up to the whole, and an invoice issued at 15% keeps being split at
   15% after the province changes it. */
function shareOfInvoiceTax(
  amountCents: number,
  invoice: { taxableCents: number; taxCents: number; taxRateBp: number; taxLabel: string },
): TaxSplit {
  const totalCents = invoice.taxableCents + invoice.taxCents;
  const taxCents = totalCents === 0 ? 0 : Math.round((amountCents * invoice.taxCents) / totalCents);

  return {
    subtotalCents: amountCents - taxCents,
    taxCents,
    totalCents: amountCents,
    taxRateBp: invoice.taxRateBp,
    taxLabel: invoice.taxLabel,
  };
}

/* Removing a payment reverses its income entry.

   The payment row stays, because it is the link and the audit trail, and it
   stops counting the moment its entry is reversed. One truth about whether the
   money arrived, in the ledger, where every other money truth lives. */
export async function remove(
  ctx: Ctx,
  invoiceId: string,
  paymentId: string,
): Promise<PublicInvoice> {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.invoicePayment.findFirst({
      where: { id: paymentId, invoiceId, businessId: ctx.businessId },
      include: { transaction: { include: { reversal: { select: { id: true } } } } },
    });
    if (!payment) throw new ApiError(404, 'That payment no longer exists.', 'not_found');
    if (payment.transaction.reversal) {
      throw new ApiError(409, 'That payment has already been removed.', 'already_removed');
    }

    const business = await tx.business.findUniqueOrThrow({
      where: { id: ctx.businessId },
      select: { province: true },
    });

    /* The last argument says this reversal is coming FROM the invoice, which
       is the one place allowed to touch an entry a payment created. */
    await reverseIn(
      tx,
      { ...ctx, province: business.province },
      payment.transactionId,
      'Payment removed',
      true,
    );
  });

  return one(ctx.businessId, invoiceId);
}

/* What the payment drawer needs before anything is typed: the balance, and
   what taking this payment would do. */
export async function paymentContext(businessId: string, invoiceId: string) {
  const invoice = await one(businessId, invoiceId);
  return {
    number: invoice.number,
    clientName: invoice.client.name,
    totalCents: invoice.totalCents,
    paidCents: invoice.paidCents,
    balanceCents: invoice.balanceCents,
    subtotalCents: invoice.taxableCents,
    taxCents: invoice.taxCents,
    taxLabel: invoice.taxLabel,
    chargeTax: invoice.chargeTax,
    statusIfSettled: statusOf(
      {
        sentAt: invoice.sentAt ? new Date(invoice.sentAt) : null,
        dueDate: new Date(invoice.dueDate),
        totalCents: invoice.totalCents,
      },
      invoice.totalCents,
    ),
  };
}
