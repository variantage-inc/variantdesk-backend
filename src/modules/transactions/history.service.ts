import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { formatCents } from '../../lib/money.js';

/* What changed, when, and who changed it.

   This is the payoff for the append only ledger. A figure that has moved is
   the single most common thing anybody asks about a set of books, and the
   answer is almost never "the software is wrong": it is somebody corrected an
   entry, or removed one, six weeks ago. A product that cannot show that turns
   a thirty second answer into an afternoon.

   Two views, because there are two ways the question arrives:

     "why does THIS entry say 1,500 when the receipt says 1,200"
        -> the version list for one entry

     "the total moved and I do not know why"
        -> the change log for the period

   Both read rows that are already in the ledger. Nothing here is a separate
   audit table that could drift out of step with the money, which is the usual
   way audit trails end up lying. */

const withNames = {
  category: { select: { name: true } },
  vendor: { select: { name: true } },
  client: { select: { name: true } },
  createdBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.TransactionInclude;

type Row = Prisma.TransactionGetPayload<{ include: typeof withNames }>;

const nameOf = (r: Row): string =>
  `${r.createdBy.firstName} ${r.createdBy.lastName}`.trim() || 'Somebody';

const partyOf = (r: Row): string | null => r.vendor?.name ?? r.client?.name ?? null;

/* The fields a person would recognise, in the order the form asks for them, so
   a diff reads in the same order as the screen it came from. */
function fieldsOf(r: Row, currency: string) {
  return {
    Date: r.date.toISOString().slice(0, 10),
    Amount: formatCents(r.totalCents, currency),
    'Before tax': formatCents(r.subtotalCents, currency),
    Tax: r.taxCents === 0 ? 'None' : `${formatCents(r.taxCents, currency)} (${r.taxLabel})`,
    Description: r.description,
    Category: r.category?.name ?? 'None',
    'Paid to or from': partyOf(r) ?? 'None',
    'Payment method': r.paymentMethod ? r.paymentMethod.replace(/_/g, ' ').toLowerCase() : 'None',
    Reference: r.reference ?? 'None',
    Purpose: r.purpose ?? 'None',
  } as Record<string, string>;
}

export type Change = { field: string; from: string; to: string };

/* Only what actually moved. A version list that repeated all ten fields every
   time would bury the one line somebody is looking for. */
function diff(before: Row | null, after: Row, currency: string): Change[] {
  if (!before) return [];
  const a = fieldsOf(before, currency);
  const b = fieldsOf(after, currency);
  return Object.keys(b)
    .filter((k) => a[k] !== b[k])
    .map((k) => ({ field: k, from: a[k]!, to: b[k]! }));
}

async function currencyOf(businessId: string): Promise<string> {
  const b = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { currency: true },
  });
  return b.currency;
}

/* --------------------------------------------------- one entry's history --- */

/* Walks the chain backwards through replacesId, then reads it forwards, so the
   list runs oldest to newest the way a person tells the story. */
export async function versionsOf(businessId: string, id: string) {
  const currency = await currencyOf(businessId);

  const chain: Row[] = [];
  let cursor: string | null = id;

  while (cursor) {
    const row: Row | null = await prisma.transaction.findFirst({
      where: { id: cursor, businessId },
      include: withNames,
    });
    if (!row) break;
    chain.push(row);
    cursor = row.replacesId;
  }

  if (!chain.length) throw new ApiError(404, 'That entry no longer exists.', 'not_found');

  /* Was the newest version itself cancelled? If so this entry has been
     removed, and the history has to say so rather than ending on a version
     that is no longer in the books. */
  const newest = chain[0]!;
  const removal = await prisma.transaction.findFirst({
    where: { businessId, kind: 'REVERSAL', reversesId: newest.id },
    include: withNames,
  });
  const replaced = await prisma.transaction.findFirst({
    where: { businessId, kind: 'ENTRY', replacesId: newest.id },
    select: { id: true },
  });

  const oldestFirst = [...chain].reverse();

  const versions = oldestFirst.map((row, i) => ({
    id: row.id,
    at: row.createdAt.toISOString(),
    by: nameOf(row),
    date: row.date.toISOString().slice(0, 10),
    description: row.description,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    taxLabel: row.taxLabel,
    category: row.category?.name ?? null,
    party: partyOf(row),
    reference: row.reference,
    purpose: row.purpose,
    /* Empty on the first version: there was nothing before it to differ from. */
    changed: diff(oldestFirst[i - 1] ?? null, row, currency),
    current: row.id === newest.id && !removal,
  }));

  return {
    versions,
    /* Removed, and by whom. A removal that is invisible is the one thing an
       append only ledger exists to prevent. */
    removed: removal
      ? { at: removal.createdAt.toISOString(), by: nameOf(removal) }
      : null,
    /* If this id has been superseded, where the live version now lives, so the
       screen can offer to open it. */
    supersededBy: replaced?.id ?? null,
    currency,
  };
}

/* ------------------------------------------------ the change log itself --- */

export type ActivityQuery = { from?: string; to?: string; page: number; perPage: number };

/* Every correction and removal in a period, newest first.

   Read from the REVERSAL rows, because a reversal is the only thing that is
   written when the books change after the fact. Whether it was a correction or
   a removal is decided by whether anything replaced the row it cancelled. */
export async function activity(businessId: string, q: ActivityQuery) {
  const currency = await currencyOf(businessId);

  const where: Prisma.TransactionWhereInput = {
    businessId,
    kind: 'REVERSAL',
    ...(q.from || q.to
      ? {
          date: {
            ...(q.from ? { gte: new Date(`${q.from}T00:00:00.000Z`) } : {}),
            ...(q.to ? { lte: new Date(`${q.to}T00:00:00.000Z`) } : {}),
          },
        }
      : {}),
  };

  const [reversals, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      include: { ...withNames, reverses: { include: withNames } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.perPage,
      take: q.perPage,
    }),
    prisma.transaction.count({ where }),
  ]);

  const cancelledIds = reversals.map((r) => r.reversesId).filter((v): v is string => v !== null);

  const replacements = await prisma.transaction.findMany({
    where: { businessId, kind: 'ENTRY', replacesId: { in: cancelledIds } },
    include: withNames,
  });
  const byReplaced = new Map(replacements.map((r) => [r.replacesId!, r]));

  const entries = reversals.map((rev) => {
    const original = rev.reverses;
    const replacement = rev.reversesId ? byReplaced.get(rev.reversesId) : undefined;

    return {
      id: rev.id,
      action: replacement ? ('corrected' as const) : ('removed' as const),
      at: rev.createdAt.toISOString(),
      by: nameOf(rev),
      type: rev.type,
      /* The date the money moved, which is the month the change affected. It
         is deliberately not the day the change was made: a July entry fixed in
         September changed July. */
      date: rev.date.toISOString().slice(0, 10),
      description: original?.description ?? rev.description,
      /* The id of the version that is live now, so the row can be opened. For
         a removal there is nothing to open. */
      entryId: replacement?.id ?? null,
      fromCents: original ? original.totalCents : -rev.totalCents,
      toCents: replacement ? replacement.totalCents : null,
      changed: original && replacement ? diff(original, replacement, currency) : [],
    };
  });

  return { entries, total, page: q.page, perPage: q.perPage, currency };
}
