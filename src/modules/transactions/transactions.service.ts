import type { Prisma, TransactionType } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { toCents } from '../../lib/money.js';
import { liveEntries, amend, record, reverse, type EntryInput } from '../../lib/ledger.js';
import { taxFor } from '../../lib/tax.js';
import type { ListQuery } from './transactions.schemas.js';
import { briefAttachment, liveAttachments } from '../receipts/receipts.service.js';

/* Reading and writing money.

   Every write here goes through lib/ledger.ts and does nothing to the
   transaction table itself. Every read builds on `liveEntries`, the one filter
   that decides which rows count, so the list, the totals and the export can
   never disagree about what is in a period. That is the same rule that keeps
   the dashboard honest in Phase 7: one derivation, several callers. */

type Ctx = { businessId: string; userId: string };

async function contextFor(businessId: string) {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { province: true, currency: true, dateFormat: true },
  });
  return business;
}

/* ---------------------------------------------------------------- filter --- */

function whereFor(businessId: string, type: TransactionType | 'MONEY_OUT', q: ListQuery) {
  const where: Prisma.TransactionWhereInput = { ...liveEntries(businessId) };

  if (type === 'MONEY_OUT') {
    /* Expenses and drawings share a screen, because there is one place money
       goes out and two things it can be. The Show filter narrows it. */
    where.type =
      q.show === 'expenses' ? 'EXPENSE' : q.show === 'drawings' ? 'DRAWING' : { in: ['EXPENSE', 'DRAWING'] };
  } else {
    where.type = type;
  }

  if (q.from || q.to) {
    where.date = {
      ...(q.from ? { gte: new Date(`${q.from}T00:00:00.000Z`) } : {}),
      ...(q.to ? { lte: new Date(`${q.to}T00:00:00.000Z`) } : {}),
    };
  }

  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.vendorId) where.vendorId = q.vendorId;
  if (q.clientId) where.clientId = q.clientId;
  if (q.paymentMethod) where.paymentMethod = q.paymentMethod;

  if (q.search) {
    /* Description, reference and the name of whoever was on the other side.
       Case insensitive, because nobody remembers whether they typed Hydro or
       hydro nine months ago. */
    const contains = { contains: q.search, mode: 'insensitive' as const };
    where.OR = [
      { description: contains },
      { reference: contains },
      { purpose: contains },
      { vendor: { name: contains } },
      { client: { name: contains } },
    ];
  }

  return where;
}

const shape = {
  category: { select: { id: true, name: true } },
  vendor: { select: { id: true, name: true } },
  client: { select: { id: true, name: true } },
  /* Whether anything has cancelled this row. Fetching one entry by id can
     reach a reversed one, which is deliberate: an old link and the history
     view both need to read it. What it must not do is look current. */
  reversal: { select: { id: true } },
  /* The invoice this income was posted by, if any. An entry with one of these
     belongs to that invoice and cannot be edited here: changing it would move
     the money without moving the invoice balance. */
  invoicePayment: { select: { invoice: { select: { id: true, number: true } } } },
  /* The receipts behind it, which is what the clip in each row shows. */
  attachments: liveAttachments,
} satisfies Prisma.TransactionInclude;

type Row = Prisma.TransactionGetPayload<{ include: typeof shape }>;

const publicRow = (t: Row) => ({
  id: t.id,
  type: t.type,
  /* Date only, as the column stores it. Sliced rather than converted, because
     toISOString on a date column in a timezone behind UTC would move the entry
     back a day on the way out. */
  date: t.date.toISOString().slice(0, 10),
  description: t.description,
  category: t.category,
  vendor: t.vendor,
  client: t.client,
  subtotalCents: t.subtotalCents,
  taxCents: t.taxCents,
  totalCents: t.totalCents,
  taxMode: t.taxMode,
  taxRateBp: t.taxRateBp,
  taxLabel: t.taxLabel,
  paymentMethod: t.paymentMethod,
  reference: t.reference,
  purpose: t.purpose,
  /* True once this entry has been corrected at least once. The screen says so,
     because "this figure has changed since it was entered" is the kind of
     thing an accountant wants to see rather than discover. */
  amended: t.replacesId !== null,
  /* Set when this entry was posted by a payment on an invoice. The screen
     shows it as coming from there and offers a link instead of an edit
     button, because the invoice is where it can actually be changed. */
  fromInvoice: t.invoicePayment?.invoice ?? null,
  /* This row has been corrected or removed since it was written, so it is no
     longer part of the books. It stays readable because the ledger is append
     only, and saying so is the difference between history and a stale form. */
  superseded: t.reversal !== null,
  attachments: t.attachments.map(briefAttachment),
  createdAt: t.createdAt.toISOString(),
});

export type PublicTransaction = ReturnType<typeof publicRow>;

/* ------------------------------------------------------------------ list --- */

export async function list(
  businessId: string,
  type: TransactionType | 'MONEY_OUT',
  q: ListQuery,
) {
  const where = whereFor(businessId, type, q);
  const [business, rows, total] = await Promise.all([
    contextFor(businessId),
    prisma.transaction.findMany({
      where,
      include: shape,
      /* Newest first, and the id as a tiebreaker so two entries on the same day
         keep a stable order between pages rather than swapping around. */
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (q.page - 1) * q.perPage,
      take: q.perPage,
    }),
    prisma.transaction.count({ where }),
  ]);

  return {
    entries: rows.map(publicRow),
    page: q.page,
    perPage: q.perPage,
    total,
    /* Totals for the WHOLE filtered period, not for the page. A footer that
       added up one page of a three page list would be a wrong number in a
       bookkeeping product, which is worse than no number. */
    summary: await summarise(businessId, type, q),
    tax: taxFor(business.province),
    currency: business.currency,
    dateFormat: business.dateFormat,
  };
}

/* The figures at the top of the screen, worked out from the same filter as the
   list below them. */
async function summarise(
  businessId: string,
  type: TransactionType | 'MONEY_OUT',
  q: ListQuery,
) {
  const sumFor = async (t: TransactionType) => {
    const where = { ...whereFor(businessId, type, q), type: t };
    const agg = await prisma.transaction.aggregate({
      where,
      _sum: { subtotalCents: true, taxCents: true, totalCents: true },
      _count: true,
    });
    return {
      subtotalCents: agg._sum.subtotalCents ?? 0,
      taxCents: agg._sum.taxCents ?? 0,
      totalCents: agg._sum.totalCents ?? 0,
      count: agg._count,
    };
  };

  if (type === 'INCOME') {
    const income = await sumFor('INCOME');

    /* How much of that income was posted by a payment on an invoice rather
       than typed in by hand. Worth showing on its own, because those entries
       are the ones nobody has to remember to record, and a customer who can
       see the figure trusts that the two halves of the product are joined. */
    const fromInvoices = await prisma.transaction.aggregate({
      where: { ...whereFor(businessId, type, q), type: 'INCOME', invoicePayment: { isNot: null } },
      _sum: { totalCents: true },
      _count: true,
    });

    return {
      income,
      expense: null,
      drawing: null,
      entries: income.count,
      fromInvoicesCents: fromInvoices._sum.totalCents ?? 0,
      fromInvoicesCount: fromInvoices._count,
    };
  }

  /* Expenses and drawings are summed separately even when both are on screen,
     because they are not the same kind of number. Adding a drawing into
     expenses is exactly the error the whole type flag exists to prevent. */
  const [expense, drawing] = await Promise.all([sumFor('EXPENSE'), sumFor('DRAWING')]);
  return {
    income: null,
    expense,
    drawing,
    entries: expense.count + drawing.count,
    fromInvoicesCents: 0,
    fromInvoicesCount: 0,
  };
}

/* --------------------------------------------------------------- writes --- */

type WriteInput = {
  date: Date;
  amount: number;
  description: string;
  categoryId: string | null;
  paymentMethod?: EntryInput['paymentMethod'];
  reference: string | null;
  taxMode?: 'ADD' | 'INCLUSIVE' | 'NONE';
  clientId?: string | null;
  vendorId?: string | null;
  purpose?: string;
};

async function toEntry(
  ctx: Ctx,
  type: TransactionType,
  input: WriteInput,
): Promise<{ ctx: Parameters<typeof record>[0]; entry: EntryInput }> {
  const business = await contextFor(ctx.businessId);

  return {
    ctx: { ...ctx, province: business.province },
    entry: {
      type,
      date: input.date,
      description: input.description,
      /* The one conversion from dollars to cents in the whole write path. */
      amountCents: toCents(input.amount),
      /* A drawing carries no tax, and the ledger refuses one that claims to. */
      taxMode: type === 'DRAWING' ? 'NONE' : (input.taxMode ?? 'NONE'),
      categoryId: input.categoryId,
      vendorId: input.vendorId ?? null,
      clientId: input.clientId ?? null,
      paymentMethod: input.paymentMethod,
      reference: input.reference,
      purpose: input.purpose ?? null,
    },
  };
}

export async function create(ctx: Ctx, type: TransactionType, input: WriteInput) {
  const { ctx: full, entry } = await toEntry(ctx, type, input);
  const created = await record(full, entry);
  return one(ctx.businessId, created.id);
}

export async function update(ctx: Ctx, id: string, type: TransactionType, input: WriteInput) {
  const { ctx: full, entry } = await toEntry(ctx, type, input);
  const created = await amend(full, id, entry);
  return one(ctx.businessId, created.id);
}

export async function remove(ctx: Ctx, id: string): Promise<void> {
  const business = await contextFor(ctx.businessId);
  await reverse({ ...ctx, province: business.province }, id);
}

export async function one(businessId: string, id: string) {
  const row = await prisma.transaction.findFirst({
    where: { id, businessId, kind: 'ENTRY' },
    include: shape,
  });
  if (!row) throw new ApiError(404, 'That entry no longer exists.', 'not_found');
  return publicRow(row);
}
