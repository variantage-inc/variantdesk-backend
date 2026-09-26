import type { Prisma, TaxMode, Transaction, TransactionType } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { ApiError } from '../middleware/error.js';
import { splitInclusive, taxOn } from './money.js';
import { taxFor } from './tax.js';

/* The financial ledger service.

   Rule 1 of the financial architecture: every change to money passes through
   here. A Prisma write to the transaction table from anywhere else in this
   codebase is a bug, not a shortcut, and the reason is that all four of the
   rules below live in this file and nowhere else. Bypass it and you get none
   of them.

   Rule 2, atomic. Every write below runs inside prisma.$transaction, so an
   edit that writes a reversal and then fails writing the replacement leaves
   the books exactly as they were rather than half corrected.

   Rule 3, exact precision. Money is whole cents in Int columns, and tax is
   worked out once, on the cent amount, and rounded once. Rounding each line
   separately is what makes a total disagree with the sum of its lines.

   Rule 5, append only. Nothing here UPDATEs or DELETEs a transaction row.
   Editing writes a REVERSAL of the original and then a fresh ENTRY; deleting
   writes the REVERSAL alone. So the sum of every row in a period is always the
   true figure, whatever happened along the way, and what the books looked like
   last March is still a question the database can answer. */

/* One filter, used by the list, the totals and the export, so the three can
   never disagree about which rows count.

   Live entries are the ones with no reversal pointing at them. Reversals
   themselves are excluded from both sides: an ENTRY and its REVERSAL sum to
   zero, so leaving both in gives the same total as leaving both out, and
   leaving both out is what the customer expects to see on screen. */
export const liveEntries = (businessId: string): Prisma.TransactionWhereInput => ({
  businessId,
  kind: 'ENTRY',
  reversal: { is: null },
});

/* ------------------------------------------------------------------ tax ---

   The rate is never asked for. It follows from the province on the business,
   and the words that go with it are stored on the row alongside the number,
   because a rate is a fact about a day rather than a fact about a business. */

export type TaxSplit = {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxRateBp: number;
  taxLabel: string;
};

export function splitTax(amountCents: number, mode: TaxMode, province: string): TaxSplit {
  const rate = taxFor(province);

  if (mode === 'NONE') {
    return {
      subtotalCents: amountCents,
      taxCents: 0,
      totalCents: amountCents,
      /* Zero, not the province rate. The row has to be able to say "no tax was
         charged here", and storing 13% next to a tax of nothing would read as
         a bug to whoever finds it in three years. */
      taxRateBp: 0,
      taxLabel: 'No tax',
    };
  }

  if (mode === 'INCLUSIVE') {
    const { subtotal, tax } = splitInclusive(amountCents, rate.totalBp);
    return {
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: amountCents,
      taxRateBp: rate.totalBp,
      taxLabel: rate.label,
    };
  }

  const tax = taxOn(amountCents, rate.totalBp);
  return {
    subtotalCents: amountCents,
    taxCents: tax,
    totalCents: amountCents + tax,
    taxRateBp: rate.totalBp,
    taxLabel: rate.label,
  };
}

/* --------------------------------------------------------------- writes --- */

export type EntryInput = {
  type: TransactionType;
  date: Date;
  description: string;
  amountCents: number;
  taxMode: TaxMode;
  categoryId?: string | null;
  vendorId?: string | null;
  clientId?: string | null;
  paymentMethod?: Prisma.TransactionCreateInput['paymentMethod'];
  reference?: string | null;
  purpose?: string | null;
};

type Ctx = { businessId: string; userId: string; province: string };

/* Everything the shape of an entry has to satisfy before it reaches the
   ledger. Checked here rather than only in the route schema, because a voice
   entry in Phase 10 and an invoice payment in Phase 6 will both post through
   this service without going near that schema. */
async function validate(
  tx: Prisma.TransactionClient,
  ctx: Ctx,
  input: EntryInput,
): Promise<void> {
  if (input.amountCents <= 0) {
    throw new ApiError(400, 'An amount has to be more than zero.', 'bad_amount');
  }

  /* A drawing is money the owner took out for themselves. It is not a business
     expense, it carries no input tax credit, and the note is what makes it
     comprehensible at year end. */
  if (input.type === 'DRAWING') {
    if (!input.purpose?.trim()) {
      throw new ApiError(400, 'Say what the drawing was for.', 'purpose_required');
    }
    if (input.taxMode !== 'NONE') {
      throw new ApiError(
        400,
        'There is no tax on an owner drawing, and none can be claimed back on it.',
        'drawing_has_no_tax',
      );
    }
    if (input.vendorId) {
      throw new ApiError(400, 'A drawing goes to the owner, not to a vendor.', 'drawing_vendor');
    }
  }

  if (input.type === 'INCOME' && input.vendorId) {
    throw new ApiError(400, 'Money coming in has a client, not a vendor.', 'income_vendor');
  }
  if (input.type === 'EXPENSE' && input.clientId) {
    throw new ApiError(400, 'Money going out has a vendor, not a client.', 'expense_client');
  }

  /* Every reference is checked against this business. An id alone would let
     one business file an expense under another's category by guessing, which
     is exactly the class of bug multi-tenancy exists to prevent. */
  if (input.categoryId) {
    const wanted =
      input.type === 'INCOME' ? 'INCOME' : input.type === 'DRAWING' ? 'DRAWINGS' : 'EXPENSE';
    const category = await tx.category.findFirst({
      where: { id: input.categoryId, businessId: ctx.businessId, archivedAt: null },
    });
    if (!category) throw new ApiError(400, 'That category does not exist.', 'bad_category');
    if (category.kind !== wanted) {
      throw new ApiError(400, 'That category is for a different kind of entry.', 'wrong_category');
    }
  }
  if (input.vendorId) {
    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, businessId: ctx.businessId, archivedAt: null },
    });
    if (!vendor) throw new ApiError(400, 'That vendor does not exist.', 'bad_vendor');
  }
  if (input.clientId) {
    const client = await tx.client.findFirst({
      where: { id: input.clientId, businessId: ctx.businessId, archivedAt: null },
    });
    if (!client) throw new ApiError(400, 'That client does not exist.', 'bad_client');
  }
}

function rowFor(ctx: Ctx, input: EntryInput): Prisma.TransactionUncheckedCreateInput {
  const split = splitTax(input.amountCents, input.taxMode, ctx.province);

  return {
    businessId: ctx.businessId,
    type: input.type,
    kind: 'ENTRY',
    date: input.date,
    description: input.description,
    categoryId: input.categoryId ?? null,
    vendorId: input.vendorId ?? null,
    clientId: input.clientId ?? null,
    subtotalCents: split.subtotalCents,
    taxCents: split.taxCents,
    totalCents: split.totalCents,
    taxMode: input.taxMode,
    taxRateBp: split.taxRateBp,
    taxLabel: split.taxLabel,
    paymentMethod: input.paymentMethod ?? null,
    reference: input.reference ?? null,
    purpose: input.purpose ?? null,
    createdById: ctx.userId,
  };
}

export async function record(ctx: Ctx, input: EntryInput): Promise<Transaction> {
  return prisma.$transaction(async (tx) => {
    await validate(tx, ctx, input);
    return tx.transaction.create({ data: rowFor(ctx, input) });
  });
}

/* Finds the one live entry with this id, or explains why there is not one.

   Scoped by businessId, and it refuses a row that has already been reversed:
   an entry can be corrected once, and the correction is then the thing you
   correct next time. Without that, two people editing the same row at once
   would both reverse it and the money would come off twice. */
async function liveEntry(
  tx: Prisma.TransactionClient,
  businessId: string,
  id: string,
): Promise<Transaction> {
  const entry = await tx.transaction.findFirst({
    where: { id, businessId, kind: 'ENTRY' },
    include: { reversal: { select: { id: true } } },
  });

  if (!entry) throw new ApiError(404, 'That entry no longer exists.', 'not_found');
  if (entry.reversal) {
    throw new ApiError(
      409,
      'That entry has already been changed. Refresh and try again.',
      'already_reversed',
    );
  }
  return entry;
}

/* The reversal row: the same entry with every figure negated.

   It carries the original's date, not today's, so a July entry corrected in
   September leaves July's totals right. Correcting the past should fix the
   past, not move money into the month somebody noticed. */
const reversalFor = (
  entry: Transaction,
  userId: string,
  why: string,
): Prisma.TransactionUncheckedCreateInput => ({
  businessId: entry.businessId,
  type: entry.type,
  kind: 'REVERSAL',
  date: entry.date,
  description: `${why}: ${entry.description}`,
  categoryId: entry.categoryId,
  vendorId: entry.vendorId,
  clientId: entry.clientId,
  subtotalCents: -entry.subtotalCents,
  taxCents: -entry.taxCents,
  totalCents: -entry.totalCents,
  taxMode: entry.taxMode,
  taxRateBp: entry.taxRateBp,
  taxLabel: entry.taxLabel,
  paymentMethod: entry.paymentMethod,
  reference: entry.reference,
  purpose: entry.purpose,
  reversesId: entry.id,
  createdById: userId,
});

export async function amend(ctx: Ctx, id: string, input: EntryInput): Promise<Transaction> {
  return prisma.$transaction(async (tx) => {
    const original = await liveEntry(tx, ctx.businessId, id);
    await validate(tx, ctx, input);

    await tx.transaction.create({ data: reversalFor(original, ctx.userId, 'Corrected') });

    return tx.transaction.create({
      data: { ...rowFor(ctx, input), replacesId: original.id },
    });
  });
}

export async function reverse(ctx: Ctx, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const original = await liveEntry(tx, ctx.businessId, id);
    await tx.transaction.create({ data: reversalFor(original, ctx.userId, 'Removed') });
  });
}

/* The full history of one entry, including the corrections that replaced it.

   This is what makes the append only ledger worth having rather than merely
   correct: the customer can be shown what an entry used to say and when it
   changed, which is the question an accountant asks and a soft delete cannot
   answer. */
export async function history(businessId: string, id: string) {
  const chain: Transaction[] = [];
  let cursor: string | null = id;

  while (cursor) {
    const row: Transaction | null = await prisma.transaction.findFirst({
      where: { id: cursor, businessId },
    });
    if (!row) break;
    chain.push(row);
    cursor = row.replacesId;
  }

  return chain;
}
