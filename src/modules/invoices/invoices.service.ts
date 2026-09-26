import type { Business, Client, Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { toCents, taxOn } from '../../lib/money.js';
import { taxFor } from '../../lib/tax.js';

/* Invoicing.

   Three rules shape everything here, and each one is a bug waiting to happen
   if it is done the obvious way instead.

   STATUS IS NEVER STORED. It is worked out from the payments and the due date
   every time it is asked for. A stored status is a second copy of something
   the payments already say, and the two drift the first time a payment is
   reversed or a due date passes at midnight without anybody visiting the page.

   AN INVOICE IS A DOCUMENT, NOT A VIEW. The seller's name, address and
   registration number, the terms, the footer and the tax rate are copied onto
   it when it is created. Rendering from today's settings would mean a business
   that moved premises silently reprinting last year's invoices with the new
   address, and the copy the client is holding would stop matching ours.

   INCOME IS POSTED WHEN PAID, NOT WHEN SENT. Sending an invoice creates a
   debt, not revenue. The income entry is written by the payment, in
   payments.service.ts, and there is no second place to record it. That is what
   stops the same money being counted twice, which is the most common error in
   small business books. */

/* ------------------------------------------------------------ arithmetic --- */

export type LineInput = { description: string; quantity: number; unitPrice: number };

export type InvoiceInput = {
  clientId: string;
  issueDate: Date;
  paymentTermsDays: number;
  lines: LineInput[];
  discountMode: 'AMOUNT' | 'PERCENT';
  discountValue: number;
  chargeTax: boolean;
  notes?: string | null;
};

/* Quantities are thousandths, so 7.5 hours is 7500. An integer for the same
   reason money is: 0.1 has no exact binary form, and a quantity that drifts
   makes a line total that does not match its own rate. */
const toMilli = (quantity: number): number => Math.round(quantity * 1000);

const lineTotal = (quantityMilli: number, unitPriceCents: number): number =>
  Math.round((quantityMilli * unitPriceCents) / 1000);

/* Everything about the money on one invoice, worked out in one place.

   Used by create, by update, and by the preview the builder shows while it is
   being typed, so the running total on screen and the figure that is stored
   cannot disagree. */
export function priceInvoice(input: InvoiceInput, province: string) {
  const rate = taxFor(province);

  const items = input.lines.map((line, i) => {
    const quantityMilli = toMilli(line.quantity);
    const unitPriceCents = toCents(line.unitPrice);
    return {
      description: line.description,
      quantityMilli,
      unitPriceCents,
      lineTotalCents: lineTotal(quantityMilli, unitPriceCents),
      sortOrder: i,
    };
  });

  const subtotalCents = items.reduce((n, i) => n + i.lineTotalCents, 0);

  /* The discount comes off BEFORE tax, which is how the CRA expects it and
     what the screen says. Percent is held in basis points so 12.5% is exact. */
  const discountCents =
    input.discountMode === 'PERCENT'
      ? Math.round((subtotalCents * Math.round(input.discountValue * 100)) / 10000)
      : toCents(input.discountValue);

  if (discountCents < 0) {
    throw new ApiError(400, 'A discount cannot be negative.', 'bad_discount');
  }
  if (discountCents > subtotalCents) {
    throw new ApiError(
      400,
      'The discount is more than the invoice is worth.',
      'discount_too_large',
    );
  }

  const taxableCents = subtotalCents - discountCents;
  /* Rounded once, at the end, on the discounted figure. Working tax out per
     line and adding it up is what makes a total disagree with its own lines. */
  const taxCents = input.chargeTax ? taxOn(taxableCents, rate.totalBp) : 0;

  return {
    items,
    subtotalCents,
    discountMode: input.discountMode,
    discountValue:
      input.discountMode === 'PERCENT'
        ? Math.round(input.discountValue * 100)
        : toCents(input.discountValue),
    discountCents,
    taxableCents,
    taxCents,
    totalCents: taxableCents + taxCents,
    chargeTax: input.chargeTax,
    taxRateBp: input.chargeTax ? rate.totalBp : 0,
    taxLabel: input.chargeTax ? rate.label : 'No tax',
  };
}

/* ---------------------------------------------------------------- status --- */

export type InvoiceStatus = 'draft' | 'sent' | 'part' | 'paid' | 'overdue';

/* The five statuses from the reviewed screens. There is deliberately no
   Cancelled: the September review removed it, and a voided invoice is not
   shown at all rather than shown as a status. */
export function statusOf(
  invoice: { sentAt: Date | null; dueDate: Date; totalCents: number },
  paidCents: number,
): InvoiceStatus {
  if (!invoice.sentAt) return 'draft';
  if (paidCents >= invoice.totalCents) return 'paid';
  if (paidCents > 0) return 'part';

  /* Compared at date level, not by instant. An invoice due today is not late
     until tomorrow, and comparing timestamps would make it late at midnight in
     a timezone the customer does not live in. */
  const today = new Date();
  const dueDay = invoice.dueDate.toISOString().slice(0, 10);
  const nowDay = today.toISOString().slice(0, 10);
  return dueDay < nowDay ? 'overdue' : 'sent';
}

/* ------------------------------------------------------------- rendering --- */

const shape = {
  client: { select: { id: true, name: true } },
  items: { orderBy: { sortOrder: 'asc' as const } },
  payments: {
    /* A payment counts only while its ledger entry is live. Reversing the
       entry removes the payment from the invoice automatically, so there is
       one truth about whether money arrived rather than two. */
    where: { transaction: { reversal: { is: null } } },
    orderBy: { date: 'asc' as const },
    include: { createdBy: { select: { firstName: true, lastName: true } } },
  },
} satisfies Prisma.InvoiceInclude;

type Row = Prisma.InvoiceGetPayload<{ include: typeof shape }>;

const daysBetween = (from: Date, to: Date): number =>
  Math.round((Date.parse(to.toISOString().slice(0, 10)) - Date.parse(from.toISOString().slice(0, 10))) / 86_400_000);

export function publicInvoice(inv: Row) {
  const paidCents = inv.payments.reduce((n, p) => n + p.amountCents, 0);
  const status = statusOf(inv, paidCents);

  return {
    id: inv.id,
    number: inv.number,
    client: inv.client,
    issueDate: inv.issueDate.toISOString().slice(0, 10),
    dueDate: inv.dueDate.toISOString().slice(0, 10),
    paymentTermsDays: inv.paymentTermsDays,
    /* Negative once it is late. The list turns this into "12 days late" or
       "in 5 days" rather than making the reader do the subtraction. */
    daysToDue: daysBetween(new Date(), inv.dueDate),
    status,
    subtotalCents: inv.subtotalCents,
    discountMode: inv.discountMode,
    discountValue: inv.discountValue,
    discountCents: inv.discountCents,
    taxableCents: inv.taxableCents,
    taxCents: inv.taxCents,
    totalCents: inv.totalCents,
    paidCents,
    balanceCents: inv.totalCents - paidCents,
    chargeTax: inv.chargeTax,
    taxLabel: inv.taxLabel,
    notes: inv.notes,
    sentAt: inv.sentAt?.toISOString() ?? null,
    seller: {
      name: inv.sellerName,
      address: inv.sellerAddress,
      email: inv.sellerEmail,
      phone: inv.sellerPhone,
      gstHstNumber: inv.gstHstNumber,
    },
    billTo: {
      name: inv.billToName,
      contact: inv.billToContact,
      address: inv.billToAddress,
    },
    terms: inv.invoiceTerms,
    footer: inv.invoiceFooter,
    payTo: inv.invoicePayTo,
    items: inv.items.map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantityMilli / 1000,
      unitPriceCents: i.unitPriceCents,
      lineTotalCents: i.lineTotalCents,
    })),
    payments: inv.payments.map((p) => ({
      id: p.id,
      date: p.date.toISOString().slice(0, 10),
      amountCents: p.amountCents,
      method: p.method,
      reference: p.reference,
      by: `${p.createdBy.firstName} ${p.createdBy.lastName}`.trim(),
      at: p.createdAt.toISOString(),
      transactionId: p.transactionId,
    })),
    createdAt: inv.createdAt.toISOString(),
  };
}

export type PublicInvoice = ReturnType<typeof publicInvoice>;

/* ------------------------------------------------------------------ list --- */

export type ListQuery = {
  status?: InvoiceStatus | 'all';
  clientId?: string;
  search?: string;
  page: number;
  perPage: number;
};

export async function list(businessId: string, q: ListQuery) {
  const where: Prisma.InvoiceWhereInput = {
    businessId,
    voidedAt: null,
    ...(q.clientId ? { clientId: q.clientId } : {}),
    ...(q.search
      ? {
          OR: [
            { number: { contains: q.search, mode: 'insensitive' } },
            { billToName: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [business, rows] = await Promise.all([
    prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { currency: true, dateFormat: true },
    }),
    prisma.invoice.findMany({
      where,
      include: shape,
      orderBy: [{ numberValue: 'desc' }],
    }),
  ]);

  /* Filtered and paged in memory, deliberately.

     Status is derived from the payments and today's date, so the database
     cannot filter on it without either storing a copy, which is the thing
     this design refuses, or a query that recomputes it in SQL and then
     disagrees with the TypeScript that does the same job. A small business
     has hundreds of invoices, not millions. When that stops being true the
     answer is a materialised view refreshed from the payments, not a status
     column somebody can write to. */
  const all = rows.map(publicInvoice);
  const filtered = q.status && q.status !== 'all' ? all.filter((i) => i.status === q.status) : all;

  const counts = {
    all: all.length,
    draft: all.filter((i) => i.status === 'draft').length,
    sent: all.filter((i) => i.status === 'sent').length,
    part: all.filter((i) => i.status === 'part').length,
    overdue: all.filter((i) => i.status === 'overdue').length,
    paid: all.filter((i) => i.status === 'paid').length,
  };

  const open = all.filter((i) => i.status !== 'draft' && i.status !== 'paid');
  const late = all.filter((i) => i.status === 'overdue');
  const drafts = all.filter((i) => i.status === 'draft');

  const start = (q.page - 1) * q.perPage;

  return {
    invoices: filtered.slice(start, start + q.perPage),
    total: filtered.length,
    page: q.page,
    perPage: q.perPage,
    counts,
    summary: {
      owedCents: open.reduce((n, i) => n + i.balanceCents, 0),
      owedCount: open.length,
      lateCents: late.reduce((n, i) => n + i.balanceCents, 0),
      lateCount: late.length,
      /* The oldest thing outstanding, which is the one worth chasing. */
      oldestLateDays: late.length ? Math.min(...late.map((i) => i.daysToDue)) : 0,
      draftCents: drafts.reduce((n, i) => n + i.totalCents, 0),
      draftCount: drafts.length,
    },
    currency: business.currency,
    dateFormat: business.dateFormat,
  };
}

export async function one(businessId: string, id: string): Promise<PublicInvoice> {
  const inv = await prisma.invoice.findFirst({
    where: { id, businessId, voidedAt: null },
    include: shape,
  });
  if (!inv) throw new ApiError(404, 'That invoice no longer exists.', 'not_found');
  return publicInvoice(inv);
}

/* ---------------------------------------------------------------- writes --- */

const addressOf = (b: Business): string | null =>
  [b.addressLine1, b.addressLine2, [b.city, b.province, b.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join('\n') || null;

const clientAddressOf = (c: Client): string | null =>
  [c.addressLine1, c.addressLine2, [c.city, c.province, c.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join('\n') || null;

const dueFrom = (issueDate: Date, days: number): Date =>
  new Date(issueDate.getTime() + days * 86_400_000);

type Ctx = { businessId: string; userId: string };

export async function create(ctx: Ctx, input: InvoiceInput): Promise<PublicInvoice> {
  if (!input.lines.length) {
    throw new ApiError(400, 'An invoice needs at least one line.', 'no_lines');
  }

  const created = await prisma.$transaction(async (tx) => {
    const business = await tx.business.findUniqueOrThrow({ where: { id: ctx.businessId } });
    const client = await tx.client.findFirst({
      where: { id: input.clientId, businessId: ctx.businessId, archivedAt: null },
    });
    if (!client) throw new ApiError(400, 'That client does not exist.', 'bad_client');

    const priced = priceInvoice(input, business.province);

    /* The number is taken and the counter moved in the same transaction, so
       two invoices created at the same moment cannot be given the same one.
       The unique index on (businessId, numberValue) is the real guarantee;
       this is what stops it firing in ordinary use. */
    const numberValue = business.nextInvoiceNumber;
    await tx.business.update({
      where: { id: ctx.businessId },
      data: { nextInvoiceNumber: numberValue + 1 },
    });

    const number = `${business.invoicePrefix}${
      business.invoiceNumberPad > 0
        ? String(numberValue).padStart(business.invoiceNumberPad, '0')
        : String(numberValue)
    }`;

    return tx.invoice.create({
      data: {
        businessId: ctx.businessId,
        clientId: client.id,
        number,
        numberValue,
        issueDate: input.issueDate,
        dueDate: dueFrom(input.issueDate, input.paymentTermsDays),
        paymentTermsDays: input.paymentTermsDays,

        /* Copied, not referenced. This is the document. */
        sellerName: business.legalName ?? business.name,
        sellerAddress: addressOf(business),
        sellerEmail: business.email,
        sellerPhone: business.phone,
        gstHstNumber: business.gstRegistered ? business.gstHstNumber : null,
        billToName: client.name,
        billToContact: client.contactName,
        billToAddress: clientAddressOf(client),
        invoiceTerms: business.invoiceTerms,
        invoiceFooter: business.invoiceFooter,
        invoicePayTo: business.invoicePayTo,

        subtotalCents: priced.subtotalCents,
        discountMode: priced.discountMode,
        discountValue: priced.discountValue,
        discountCents: priced.discountCents,
        taxableCents: priced.taxableCents,
        taxCents: priced.taxCents,
        totalCents: priced.totalCents,
        chargeTax: priced.chargeTax,
        taxRateBp: priced.taxRateBp,
        taxLabel: priced.taxLabel,

        notes: input.notes ?? null,
        createdById: ctx.userId,
        items: { create: priced.items },
      },
      include: shape,
    });
  });

  return publicInvoice(created);
}

export async function update(ctx: Ctx, id: string, input: InvoiceInput): Promise<PublicInvoice> {
  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findFirst({
      where: { id, businessId: ctx.businessId, voidedAt: null },
      include: { payments: { where: { transaction: { reversal: { is: null } } } } },
    });
    if (!existing) throw new ApiError(404, 'That invoice no longer exists.', 'not_found');

    /* Once money has arrived against it, the invoice is evidence of what was
       agreed. Changing the total underneath a payment would leave a balance
       that never matched anything either side is holding. */
    if (existing.payments.length) {
      throw new ApiError(
        409,
        'This invoice has been paid against, so it cannot be changed. Remove the payment first, or issue a new invoice.',
        'invoice_has_payments',
      );
    }

    const business = await tx.business.findUniqueOrThrow({ where: { id: ctx.businessId } });
    const client = await tx.client.findFirst({
      where: { id: input.clientId, businessId: ctx.businessId, archivedAt: null },
    });
    if (!client) throw new ApiError(400, 'That client does not exist.', 'bad_client');

    const priced = priceInvoice(input, business.province);

    /* Lines are replaced rather than reconciled. They are the contents of one
       document, not a ledger, and matching them up by id would be work in
       exchange for nothing anybody can see. */
    await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });

    return tx.invoice.update({
      where: { id },
      data: {
        clientId: client.id,
        issueDate: input.issueDate,
        dueDate: dueFrom(input.issueDate, input.paymentTermsDays),
        paymentTermsDays: input.paymentTermsDays,
        billToName: client.name,
        billToContact: client.contactName,
        billToAddress: clientAddressOf(client),
        subtotalCents: priced.subtotalCents,
        discountMode: priced.discountMode,
        discountValue: priced.discountValue,
        discountCents: priced.discountCents,
        taxableCents: priced.taxableCents,
        taxCents: priced.taxCents,
        totalCents: priced.totalCents,
        chargeTax: priced.chargeTax,
        taxRateBp: priced.taxRateBp,
        taxLabel: priced.taxLabel,
        notes: input.notes ?? null,
        items: { create: priced.items },
      },
      include: shape,
    });
  });

  return publicInvoice(updated);
}

/* Marking it sent is what turns it from a draft into a debt the client owes.
   It posts no income: that happens when the money arrives. */
export async function send(businessId: string, id: string): Promise<PublicInvoice> {
  const invoice = await prisma.invoice.findFirst({
    where: { id, businessId, voidedAt: null },
  });
  if (!invoice) throw new ApiError(404, 'That invoice no longer exists.', 'not_found');
  if (invoice.sentAt) return one(businessId, id);

  await prisma.invoice.update({ where: { id }, data: { sentAt: new Date() } });
  return one(businessId, id);
}

/* Voided, not deleted. An invoice number is never reissued, so the row has to
   stay in the sequence even when the invoice does not stand. */
export async function voidInvoice(businessId: string, id: string): Promise<void> {
  const invoice = await prisma.invoice.findFirst({
    where: { id, businessId, voidedAt: null },
    include: { payments: { where: { transaction: { reversal: { is: null } } } } },
  });
  if (!invoice) throw new ApiError(404, 'That invoice no longer exists.', 'not_found');

  if (invoice.payments.length) {
    throw new ApiError(
      409,
      'This invoice has payments against it. Remove those first, so the income comes off your books with it.',
      'invoice_has_payments',
    );
  }

  await prisma.invoice.update({ where: { id }, data: { voidedAt: new Date() } });
}

/* What the builder needs before anybody types anything: the number this
   invoice will get, the terms, and the wording the template adds. */
export async function draftDefaults(businessId: string) {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  const rate = taxFor(business.province);

  const number = `${business.invoicePrefix}${
    business.invoiceNumberPad > 0
      ? String(business.nextInvoiceNumber).padStart(business.invoiceNumberPad, '0')
      : String(business.nextInvoiceNumber)
  }`;

  return {
    /* The number is shown, not reserved. Reserving it would burn a number
       every time somebody opened the builder and changed their mind, and the
       sequence has to be unbroken. */
    nextNumber: number,
    paymentTermsDays: business.paymentTermsDays,
    terms: business.invoiceTerms,
    footer: business.invoiceFooter,
    payTo: business.invoicePayTo,
    gstHstNumber: business.gstRegistered ? business.gstHstNumber : null,
    gstRegistered: business.gstRegistered,
    sellerName: business.legalName ?? business.name,
    sellerAddress: addressOf(business),
    tax: rate,
    currency: business.currency,
    dateFormat: business.dateFormat,
  };
}
