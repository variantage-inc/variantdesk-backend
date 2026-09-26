import type { Prisma, TaxMode, TransactionType } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { taxFor } from '../../lib/tax.js';
import { toCents } from '../../lib/money.js';
import { parseSpokenEntry } from '../../lib/gemini.js';
import * as transactions from '../transactions/transactions.service.js';
import {
  geminiReplySchema,
  looksLikeInjection,
  sanitiseText,
  type ConfirmInput,
  type GeminiReply,
} from './voice.schemas.js';

/* Voice entry.

   THE RULE THIS WHOLE MODULE EXISTS TO KEEP: nothing reaches the ledger from
   speech. A clip is parsed into a DRAFT, the draft is shown to a person, and
   only when that person presses Save does anything become money, through the
   same service the typed form uses. A draft is a proposal. It is counted
   nowhere, appears on no report, and if nobody confirms it, nothing happened.

   That was the client's own requirement and it is what makes dictating money
   safe. The worst a misheard word can do is waste a few seconds.

   Three consequences worth knowing before changing anything here:

   NOTHING IS CREATED FROM SPEECH. A category, a vendor or a client that the
   business has not already got is not invented because somebody said a name.
   The spoken name is kept, the id stays null, and the confirmation screen asks.
   Otherwise a mumbled word becomes a vendor nobody can find later.

   THE MODEL'S ANSWER IS NOT CONSULTED AT SAVE TIME. Whatever the person has on
   screen is what is written, validated exactly as a typed entry is. The draft
   is provenance, not input.

   AN AMOUNT IS NEVER INVENTED. A sentence with no figure in it produces a
   FAILED draft that says what it heard and saves nothing. Refusing is cheap;
   a wrong number waved through is not. */

type Ctx = { businessId: string; userId: string };

/* ------------------------------------------------------------------ reading --- */

const shape = {
  category: { select: { id: true, name: true, kind: true } },
  vendor: { select: { id: true, name: true } },
  client: { select: { id: true, name: true } },
} satisfies Prisma.VoiceEntryInclude;

type Row = Prisma.VoiceEntryGetPayload<{ include: typeof shape }>;

export function publicDraft(row: Row) {
  return {
    id: row.id,
    status: row.status,
    transcript: row.transcript,
    /* Null on a failure, which is the honest answer to "what kind of entry is
       this" when the sentence was not about one. */
    type: row.kind,
    amountCents: row.amountCents,
    taxMode: row.taxMode,
    date: row.entryDate ? row.entryDate.toISOString().slice(0, 10) : null,
    description: row.description,
    purpose: row.purpose,
    /* Both halves of every reference: the name as spoken, and the row it was
       matched to if there was one. The screen shows the name either way and
       says when nothing matched. */
    party: row.party,
    category: row.category,
    vendor: row.vendor,
    client: row.client,
    guesses: (row.guesses ?? []) as { field: string; reason: string }[],
    model: row.model,
    transactionId: row.transactionId,
    createdAt: row.createdAt.toISOString(),
  };
}

export type PublicDraft = ReturnType<typeof publicDraft>;

export async function one(businessId: string, id: string): Promise<PublicDraft> {
  const row = await prisma.voiceEntry.findFirst({ where: { id, businessId }, include: shape });
  if (!row) throw new ApiError(404, 'That voice entry no longer exists.', 'not_found');
  return publicDraft(row);
}

/* ------------------------------------------------------------------ matching --- */

/* A spoken name against a list this business already has.

   Exact first, then a contained match, both case insensitive. Deliberately not
   fuzzy: "Petro-Canada" heard as "Petro Canada" should match, and "Bennett
   Digital" heard as "Bennett" should match, but a scoring function that pairs
   "Staples" with "Maples" would file an expense against the wrong company and
   nobody would notice until a reconciliation. Where there is no confident
   match there is no match, and the screen asks. */
function matchName<T extends { id: string; name: string }>(
  spoken: string | null,
  rows: T[],
): T | null {
  if (!spoken) return null;

  const normal = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = normal(spoken);
  if (!wanted) return null;

  const exact = rows.find((r) => normal(r.name) === wanted);
  if (exact) return exact;

  const contains = rows.filter(
    (r) => normal(r.name).includes(wanted) || wanted.includes(normal(r.name)),
  );
  /* One candidate is a match. Several is an ambiguity, and guessing between
     them is the same mistake as guessing an amount. */
  return contains.length === 1 ? contains[0]! : null;
}

/* ----------------------------------------------------------------- capturing --- */

const todayIso = (): string => new Date().toISOString().slice(0, 10);

async function contextFor(businessId: string) {
  const [business, categories, vendors, clients] = await Promise.all([
    prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { province: true, currency: true, dateFormat: true },
    }),
    prisma.category.findMany({
      where: { businessId, archivedAt: null },
      select: { id: true, name: true, kind: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.vendor.findMany({
      where: { businessId, archivedAt: null },
      select: { id: true, name: true },
    }),
    prisma.client.findMany({
      where: { businessId, archivedAt: null },
      select: { id: true, name: true },
    }),
  ]);

  return { business, categories, vendors, clients };
}

/* The tax mode a draft is proposed with.

   The figure somebody says out loud is what changed hands, so it is treated as
   the total and the tax is worked back out of it. That is the same assumption
   the reviewed screen makes, and it is the right one: a receipt shows the
   total, and so does a bank line. "Plus tax" is the only thing that changes it,
   and a drawing carries no tax at all whatever was said. */
function taxModeFor(kind: TransactionType, reply: GeminiReply): TaxMode {
  if (kind === 'DRAWING') return 'NONE';
  if (reply.taxTreatment === 'ADD') return 'ADD';
  if (reply.taxTreatment === 'NONE') return 'NONE';
  return 'INCLUSIVE';
}

export async function capture(
  ctx: Ctx,
  audio: Buffer,
  mimeType: string,
): Promise<PublicDraft> {
  const { business, categories, vendors, clients } = await contextFor(ctx.businessId);
  const rate = taxFor(business.province);

  const { raw, model } = await parseSpokenEntry(audio, mimeType, {
    categories: {
      income: categories.filter((c) => c.kind === 'INCOME').map((c) => c.name),
      expense: categories.filter((c) => c.kind === 'EXPENSE').map((c) => c.name),
    },
    today: todayIso(),
    province: rate.name,
    taxLabel: rate.label,
  });

  /* Rules document 6.3: validated before it reaches anything else, and
     rejected rather than repaired if it does not fit. */
  const parsed = geminiReplySchema.safeParse(raw);
  if (!parsed.success) {
    console.error('Gemini answered outside the schema:', parsed.error.issues.slice(0, 3));
    throw new ApiError(
      502,
      'We could not read that clip. Try again, or type the entry in.',
      'voice_bad_shape',
    );
  }
  const reply = parsed.data;

  /* Flagged, not blocked. The sentence is still stored and still shown, because
     the person about to approve it is the control that matters, and hiding the
     words would take away the thing they need to see. */
  if (looksLikeInjection(reply.transcript)) {
    console.warn(`Voice transcript reads like an instruction, business ${ctx.businessId}`);
  }

  const usable = reply.kind !== 'UNKNOWN' && reply.amount !== null;
  const guesses = [...reply.guesses];

  if (!usable) {
    /* A failure is a row too. It is what makes "it did not understand me"
       answerable a week later, and it is the list Phase 12 will use to find out
       which sentences the product is bad at. */
    const row = await prisma.voiceEntry.create({
      data: {
        businessId: ctx.businessId,
        createdById: ctx.userId,
        status: 'FAILED',
        transcript: reply.transcript,
        model,
        guesses,
      },
      include: shape,
    });
    return publicDraft(row);
  }

  const kind = reply.kind as TransactionType;
  const taxMode = taxModeFor(kind, reply);

  /* The category. A drawing always goes to the system category, whatever was
     said, because that column is what keeps drawings out of profit. */
  const wantedKind = kind === 'INCOME' ? 'INCOME' : kind === 'DRAWING' ? 'DRAWINGS' : 'EXPENSE';
  const pool = categories.filter((c) => c.kind === wantedKind);
  const category =
    kind === 'DRAWING' ? (pool[0] ?? null) : matchName(reply.categoryName, pool);

  if (!category && kind !== 'DRAWING') {
    guesses.push({
      field: 'categoryName',
      reason: reply.categoryName
        ? `Nothing here is called ${reply.categoryName}, so choose a category`
        : 'No category was clear from what you said',
    });
  }

  /* The party, matched against rows this business already has. Never created. */
  const client = kind === 'INCOME' ? matchName(reply.party, clients) : null;
  const vendor = kind === 'EXPENSE' ? matchName(reply.party, vendors) : null;

  if (reply.party && kind !== 'DRAWING' && !client && !vendor) {
    guesses.push({
      field: 'party',
      reason: `${reply.party} is not on your list yet, so nobody is attached to this`,
    });
  }

  /* A date nobody said is today, and that is a guess like any other. */
  const date = reply.date ?? todayIso();
  if (!reply.date) {
    guesses.push({ field: 'date', reason: 'You did not say a date, so today is used' });
  }

  const row = await prisma.voiceEntry.create({
    data: {
      businessId: ctx.businessId,
      createdById: ctx.userId,
      status: 'DRAFT',
      transcript: reply.transcript,
      kind,
      amountCents: toCents(reply.amount!),
      taxMode,
      party: reply.party,
      /* A few words for the list, not the sentence. A drawing says what it
         was taken out for, which is the useful half of "took out two thousand
         for the household". */
      description:
        reply.description ??
        (kind === 'DRAWING' && reply.purpose
          ? reply.purpose
          : sanitiseText(reply.transcript, 140)),
      entryDate: new Date(`${date}T00:00:00.000Z`),
      purpose: kind === 'DRAWING' ? (reply.purpose ?? reply.description ?? 'Owner drawing') : null,
      categoryId: category?.id ?? null,
      clientId: client?.id ?? null,
      vendorId: vendor?.id ?? null,
      guesses,
      model,
    },
    include: shape,
  });

  return publicDraft(row);
}

/* ---------------------------------------------------------------- confirming --- */

/* The moment speech becomes money, and the only one.

   Everything arrives from the screen, including anything the owner corrected,
   and it is written through `transactions.create` exactly as the typed form
   writes it: same validation, same ledger, same tax arithmetic, same
   idempotency. There is no second path into the transaction table and this is
   not one. */
export async function confirm(
  ctx: Ctx,
  id: string,
  input: ConfirmInput,
): Promise<{ draft: PublicDraft; entryId: string }> {
  const draft = await prisma.voiceEntry.findFirst({
    where: { id, businessId: ctx.businessId },
  });
  if (!draft) throw new ApiError(404, 'That voice entry no longer exists.', 'not_found');

  if (draft.status === 'CONFIRMED') {
    throw new ApiError(
      409,
      'That has already been saved. It is on your income and expenses screens.',
      'already_confirmed',
    );
  }
  if (draft.status === 'DISCARDED') {
    throw new ApiError(409, 'That was discarded. Say it again.', 'already_discarded');
  }

  const entry = await transactions.create(ctx, input.type, {
    date: new Date(`${input.date}T00:00:00.000Z`),
    amount: input.amount,
    description: input.description,
    categoryId: input.categoryId,
    clientId: input.type === 'INCOME' ? (input.clientId ?? null) : null,
    vendorId: input.type === 'EXPENSE' ? (input.vendorId ?? null) : null,
    reference: null,
    taxMode: input.taxMode,
    ...(input.type === 'DRAWING' ? { purpose: input.purpose ?? 'Owner drawing' } : {}),
  });

  const row = await prisma.voiceEntry.update({
    where: { id },
    data: { status: 'CONFIRMED', transactionId: entry.id, settledAt: new Date() },
    include: shape,
  });

  return { draft: publicDraft(row), entryId: entry.id };
}

export async function discard(ctx: Ctx, id: string): Promise<PublicDraft> {
  const draft = await prisma.voiceEntry.findFirst({
    where: { id, businessId: ctx.businessId },
  });
  if (!draft) throw new ApiError(404, 'That voice entry no longer exists.', 'not_found');

  if (draft.status === 'CONFIRMED') {
    throw new ApiError(
      409,
      'That one was already saved. Remove it from the income or expenses screen instead.',
      'already_confirmed',
    );
  }

  const row = await prisma.voiceEntry.update({
    where: { id },
    data: { status: 'DISCARDED', settledAt: new Date() },
    include: shape,
  });
  return publicDraft(row);
}

/* What the screen needs to let somebody correct a draft: the lists to choose
   from, and the rate to show the tax with. The same lists the typed drawer
   uses, from the same place. */
export async function options(businessId: string) {
  const { business, categories, vendors, clients } = await contextFor(businessId);
  return {
    categories,
    vendors,
    clients,
    tax: taxFor(business.province),
    currency: business.currency,
    dateFormat: business.dateFormat,
    today: todayIso(),
  };
}
