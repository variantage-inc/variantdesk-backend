import { z } from 'zod';

/* What the model is allowed to have said, checked before it reaches a service.

   Rules document section 6.3: every AI output is validated with Zod, and a
   payload that fails is REJECTED rather than patched. The response schema on
   the request already narrows what can come back, but that schema is enforced
   by somebody else's service. This is the check we control, and it is the one
   that decides whether a value is allowed anywhere near the rest of the code. */

const trimmed = (max: number) =>
  z
    .string()
    .transform((v) => sanitiseText(v, max))
    .nullish()
    .transform((v) => v || null);

/* Text that came out of a microphone, made safe to store and show.

   Control characters go because they are never spoken and are how a string
   escapes the box it is drawn in. Length is capped because a description is a
   few words and an unbounded one is a way to fill a database. Nothing is
   "cleaned" beyond that: changing the words somebody said would make the
   transcript a worse record of what happened, and the transcript exists
   precisely so a wrong entry can be explained. */
export function sanitiseText(value: string, max: number): string {
  return value
    /* Control characters, which are never spoken and are how a string escapes
       the box it is drawn in. */
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/* Phrases that are somebody talking to the model rather than about money.

   This does NOT block anything: the model has already answered, the schema has
   already constrained it, and nothing is written without a person approving it.
   It exists so a draft that smells like an injection attempt is flagged on the
   confirmation screen and logged, rather than passing unremarked. */
const INJECTION = [
  /ignore (all |any |your )?(previous|prior|above|earlier)/i,
  /disregard (all |any |your )?(previous|prior|above|earlier)/i,
  /system (prompt|instruction|message)/i,
  /you are now|act as|pretend to be/i,
  /new instructions?/i,
];

export const looksLikeInjection = (transcript: string): boolean =>
  INJECTION.some((pattern) => pattern.test(transcript));

export const geminiReplySchema = z.object({
  transcript: z.string().transform((v) => sanitiseText(v, 500)),
  kind: z.enum(['INCOME', 'EXPENSE', 'DRAWING', 'UNKNOWN']),
  /* Bounded on purpose. A spoken amount is a real transaction, and a figure
     outside this range is a misheard word rather than a payment: "a hundred
     and fifty" misheard as a hundred and fifty million should be refused here
     rather than shown to somebody at the end of a long day. */
  amount: z.number().positive().max(10_000_000).nullish().transform((v) => v ?? null),
  taxTreatment: z.enum(['INCLUSIVE', 'ADD', 'NONE']).nullish().transform((v) => v ?? null),
  party: trimmed(120),
  categoryName: trimmed(80),
  description: trimmed(140),
  /* A date the speaker actually said. Anything that is not a real calendar day
     is dropped rather than corrected. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), 'not a real date')
    .nullish()
    .transform((v) => v ?? null),
  purpose: trimmed(150),
  guesses: z
    .array(
      z.object({
        field: z.string().transform((v) => sanitiseText(v, 40)),
        reason: z.string().transform((v) => sanitiseText(v, 200)),
      }),
    )
    .max(8)
    .default([]),
});

export type GeminiReply = z.infer<typeof geminiReplySchema>;

/* What the browser sends back when a person presses Save.

   Deliberately the SAME shape the typed forms accept, because that is what it
   becomes. The draft is provenance; this is the entry, and it is validated and
   written exactly as a typed one is. Anything the owner corrected on screen
   arrives here and wins: the model's opinion is not consulted again. */
export const confirmSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE', 'DRAWING']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.'),
  amount: z.number().positive('An amount has to be more than zero.').max(10_000_000),
  description: z.string().trim().min(1, 'Say what it was for.').max(140),
  categoryId: z.string().max(40).nullable(),
  clientId: z.string().max(40).nullable().optional(),
  vendorId: z.string().max(40).nullable().optional(),
  taxMode: z.enum(['ADD', 'INCLUSIVE', 'NONE']),
  purpose: z.string().trim().max(150).optional(),
});

export type ConfirmInput = z.infer<typeof confirmSchema>;
