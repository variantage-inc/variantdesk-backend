import type { Prisma, TransactionType } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { liveEntries } from '../../lib/ledger.js';
import { taxFor } from '../../lib/tax.js';
import { publicInvoice } from '../invoices/invoices.service.js';

/* The derivation.

   Every figure the dashboard shows, and every figure the reports will show in
   Phase 9, is worked out here. One function, several callers, which is the
   only way the two can be guaranteed to agree: a second copy of this
   arithmetic somewhere else is a second answer waiting to be different.

   Nothing on the dashboard is stored. Net profit, tax owed and what is left in
   the business are all computed from the ledger rows every time they are
   asked for, so a figure on screen can always be tied back to the entries
   underneath it.

   Three rules that shape what comes out:

   DRAWINGS ARE NEVER IN PROFIT. A drawing is money the owner took for
   themselves. It is not a cost of running the business, it carries no input
   tax credit, and it has its own figure and its own chart. It never appears in
   money out, in the expense breakdown, or on the same axis as income.

   NO PERCENTAGE FOR A PERIOD THAT IS STILL RUNNING. Forty days into a
   ninety-two day quarter, comparing against a finished quarter prints a
   collapse for a business that is doing perfectly well. A period that includes
   today gets a plain sentence instead of a number.

   WHAT YOU ARE OWED IS A POSITION, NOT A TOTAL. It is what is outstanding
   today, not what was invoiced in the chosen period, so it does not move with
   the period control and the screen says so. */

export type Period = { from: Date; to: Date };

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const DAY = 86_400_000;

/* ------------------------------------------------------------- the money --- */

type Bucket = { subtotalCents: number; taxCents: number; totalCents: number; count: number };

const EMPTY: Bucket = { subtotalCents: 0, taxCents: 0, totalCents: 0, count: 0 };

async function bucketsFor(businessId: string, period: Period) {
  const rows = await prisma.transaction.groupBy({
    by: ['type'],
    where: { ...liveEntries(businessId), date: { gte: period.from, lte: period.to } },
    _sum: { subtotalCents: true, taxCents: true, totalCents: true },
    _count: true,
  });

  const pick = (type: TransactionType): Bucket => {
    const row = rows.find((r) => r.type === type);
    if (!row) return { ...EMPTY };
    return {
      subtotalCents: row._sum.subtotalCents ?? 0,
      taxCents: row._sum.taxCents ?? 0,
      totalCents: row._sum.totalCents ?? 0,
      count: row._count,
    };
  };

  return { income: pick('INCOME'), expenses: pick('EXPENSE'), drawings: pick('DRAWING') };
}

/* The three headline figures, from the three buckets. Written once, here, so
   that "profit" means the same thing on the dashboard, in the reports and in
   anything built later. */
function headline(b: Awaited<ReturnType<typeof bucketsFor>>) {
  return {
    /* Before tax on both sides. Tax collected is not earnings and tax paid is
       not a cost: both are money in transit to or from the CRA. */
    netProfitCents: b.income.subtotalCents - b.expenses.subtotalCents,
    /* What is owed to the CRA: tax collected on sales, less the input tax
       credit on purchases. Negative means they owe you a refund, which is
       ordinary for a business that has spent more than it has billed. */
    taxOwedCents: b.income.taxCents - b.expenses.taxCents,
    leftInBusinessCents:
      b.income.subtotalCents - b.expenses.subtotalCents - b.drawings.totalCents,
  };
}

/* ------------------------------------------------------ the period itself --- */

const isFirstOfMonth = (d: Date): boolean => d.getUTCDate() === 1;

const isLastOfMonth = (d: Date): boolean =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() === d.getUTCDate();

/* The period immediately before this one, to compare against.

   A range that covers whole calendar months shifts by whole months, so
   September compares against August rather than against "the thirty days
   before September", which would start on the 2nd. Anything else shifts by its
   own length in days, which is the only sensible answer for an arbitrary
   custom range. */
function previousPeriod(period: Period): Period {
  if (isFirstOfMonth(period.from) && isLastOfMonth(period.to)) {
    const months =
      (period.to.getUTCFullYear() - period.from.getUTCFullYear()) * 12 +
      (period.to.getUTCMonth() - period.from.getUTCMonth()) +
      1;
    const from = new Date(
      Date.UTC(period.from.getUTCFullYear(), period.from.getUTCMonth() - months, 1),
    );
    const to = new Date(
      Date.UTC(period.from.getUTCFullYear(), period.from.getUTCMonth(), 0),
    );
    return { from, to };
  }

  const length = period.to.getTime() - period.from.getTime() + DAY;
  return { from: new Date(period.from.getTime() - length), to: new Date(period.from.getTime() - DAY) };
}

/* Has this period finished?

   The single most important guard on the whole screen. A period that includes
   today is still running, so anything compared against it is comparing a part
   with a whole. */
function periodState(period: Period) {
  const today = new Date();
  const todayIso = iso(today);
  const complete = iso(period.to) < todayIso;

  const totalDays = Math.round((period.to.getTime() - period.from.getTime()) / DAY) + 1;
  const elapsedDays = complete
    ? totalDays
    : Math.min(
        totalDays,
        Math.max(0, Math.round((Date.parse(todayIso) - period.from.getTime()) / DAY) + 1),
      );

  return { complete, totalDays, elapsedDays };
}

/* ------------------------------------------------------ where it all went --- */

async function byCategory(businessId: string, period: Period) {
  const rows = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: {
      ...liveEntries(businessId),
      /* Business expenses only. A drawing is not a cost and must never appear
         in this list, which is why the type is filtered rather than the
         category being excluded by name. */
      type: 'EXPENSE',
      date: { gte: period.from, lte: period.to },
    },
    _sum: { subtotalCents: true },
    _count: true,
  });

  const ids = rows.map((r) => r.categoryId).filter((v): v is string => v !== null);
  const names = await prisma.category.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(names.map((c) => [c.id, c.name]));

  const total = rows.reduce((n, r) => n + (r._sum.subtotalCents ?? 0), 0);

  return rows
    .map((r) => ({
      id: r.categoryId,
      name: r.categoryId ? (nameOf.get(r.categoryId) ?? 'Uncategorised') : 'Uncategorised',
      cents: r._sum.subtotalCents ?? 0,
      count: r._count,
      /* Basis points of the total, so the bar widths are exact rather than
         each one rounded to a percent and adding up to 99. */
      shareBp: total === 0 ? 0 : Math.round(((r._sum.subtotalCents ?? 0) * 10000) / total),
    }))
    .filter((c) => c.cents > 0)
    .sort((a, b) => b.cents - a.cents);
}

/* -------------------------------------------------------- month by month --- */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Twelve months ending with the month the period ends in, so the chosen period
   always has context either side of it rather than sitting alone. */
async function monthly(businessId: string, period: Period) {
  const end = new Date(Date.UTC(period.to.getUTCFullYear(), period.to.getUTCMonth() + 1, 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));

  /* Grouped by exact date and type, then rolled up to months here.

     Prisma cannot group by a truncated date without raw SQL, and raw SQL would
     mean a second place that knows what a live entry is. A year of a small
     business is a few hundred distinct dates, so rolling up in memory costs
     nothing and keeps one definition of the filter. */
  const rows = await prisma.transaction.groupBy({
    by: ['date', 'type'],
    where: { ...liveEntries(businessId), date: { gte: start, lte: end } },
    _sum: { subtotalCents: true, totalCents: true },
  });

  const months: {
    key: string;
    label: string;
    year: number;
    from: string;
    to: string;
    incomeCents: number;
    expensesCents: number;
    drawingsCents: number;
  }[] = [];

  for (let i = 0; i < 12; i += 1) {
    const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    months.push({
      key: iso(first).slice(0, 7),
      label: MONTH_NAMES[first.getUTCMonth()]!,
      year: first.getUTCFullYear(),
      from: iso(first),
      to: iso(last),
      incomeCents: 0,
      expensesCents: 0,
      drawingsCents: 0,
    });
  }

  const index = new Map(months.map((m, i) => [m.key, i]));

  for (const row of rows) {
    const at = index.get(iso(row.date).slice(0, 7));
    if (at === undefined) continue;
    const month = months[at]!;
    /* Income and expenses are compared BEFORE tax, because that is what the
       business earned and spent. Drawings have no tax at all, so the total is
       the figure. */
    if (row.type === 'INCOME') month.incomeCents += row._sum.subtotalCents ?? 0;
    else if (row.type === 'EXPENSE') month.expensesCents += row._sum.subtotalCents ?? 0;
    else month.drawingsCents += row._sum.totalCents ?? 0;
  }

  return months;
}

/* ------------------------------------------------------------- invoicing --- */

const invoiceShape = {
  client: { select: { id: true, name: true } },
  items: { orderBy: { sortOrder: 'asc' as const } },
  payments: {
    where: { transaction: { reversal: { is: null } } },
    orderBy: { date: 'asc' as const },
    include: { createdBy: { select: { firstName: true, lastName: true } } },
  },
} satisfies Prisma.InvoiceInclude;

/* What is outstanding TODAY, not what was invoiced in the period.

   Deliberately not scoped to the date range. What a business is owed is a
   position on a date, and totalling it over a range would answer a question
   nobody asked. The screen says so rather than leaving it to be discovered. */
async function invoicePosition(businessId: string) {
  const rows = await prisma.invoice.findMany({
    where: { businessId, voidedAt: null, sentAt: { not: null } },
    include: invoiceShape,
  });

  const all = rows.map(publicInvoice);
  const open = all.filter((i) => i.status !== 'paid');
  const overdue = open.filter((i) => i.status === 'overdue');

  return {
    owedCents: open.reduce((n, i) => n + i.balanceCents, 0),
    owedCount: open.length,
    overdueCents: overdue.reduce((n, i) => n + i.balanceCents, 0),
    overdueCount: overdue.length,
    /* Overdue first and oldest first, because that is the order somebody
       chasing payment would work through them. */
    oldest: [...open]
      .sort((a, b) => a.daysToDue - b.daysToDue)
      .slice(0, 5)
      .map((i) => ({
        id: i.id,
        number: i.number,
        clientName: i.client.name,
        totalCents: i.totalCents,
        balanceCents: i.balanceCents,
        dueDate: i.dueDate,
        daysToDue: i.daysToDue,
        status: i.status,
      })),
  };
}

/* ---------------------------------------------------------- recent entries --- */

async function recent(businessId: string, period: Period) {
  const rows = await prisma.transaction.findMany({
    where: { ...liveEntries(businessId), date: { gte: period.from, lte: period.to } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: 12,
    include: {
      category: { select: { name: true } },
      vendor: { select: { name: true } },
      client: { select: { name: true } },
      invoicePayment: { select: { invoice: { select: { id: true, number: true } } } },
    },
  });

  return rows.map((t) => ({
    id: t.id,
    date: iso(t.date),
    type: t.type,
    description: t.description,
    party: t.vendor?.name ?? t.client?.name ?? null,
    category: t.category?.name ?? null,
    totalCents: t.totalCents,
    fromInvoice: t.invoicePayment?.invoice ?? null,
  }));
}

/* ------------------------------------------------------------------ all of it --- */

export async function derive(businessId: string, period: Period) {
  const state = periodState(period);
  const previous = previousPeriod(period);

  const [business, buckets, categories, months, invoices, entries, previousBuckets] =
    await Promise.all([
      prisma.business.findUniqueOrThrow({
        where: { id: businessId },
        select: { province: true, currency: true, dateFormat: true, gstRegistered: true },
      }),
      bucketsFor(businessId, period),
      byCategory(businessId, period),
      monthly(businessId, period),
      invoicePosition(businessId),
      recent(businessId, period),
      /* Only fetched when there is something honest to compare against. A
         running period is a part, and a part against a whole is not a
         comparison, it is a wrong number with a percent sign on it. */
      state.complete ? bucketsFor(businessId, previous) : null,
    ]);

  return {
    period: {
      from: iso(period.from),
      to: iso(period.to),
      ...state,
    },
    ...buckets,
    ...headline(buckets),
    byCategory: categories,
    months,
    invoices,
    recent: entries,
    previous: previousBuckets
      ? {
          from: iso(previous.from),
          to: iso(previous.to),
          ...previousBuckets,
          ...headline(previousBuckets),
        }
      : null,
    tax: taxFor(business.province),
    gstRegistered: business.gstRegistered,
    currency: business.currency,
    dateFormat: business.dateFormat,
  };
}

export type Derived = Awaited<ReturnType<typeof derive>>;
