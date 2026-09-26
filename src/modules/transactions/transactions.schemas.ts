import { z } from 'zod';
import { money, shortText } from '../../lib/validation.js';

/* What the API will accept for a row of money.

   Amounts arrive as dollars, because that is what the person typed, and are
   converted to cents once, at the edge, by the service. Nothing downstream
   ever sees a float. */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'That is not a real date.')
  /* Parsed at UTC midnight and stored in a date only column, so an entry made
     at 9pm in Toronto does not land on tomorrow. */
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

/* Optional means all three of these: the field is absent, it is an empty
   string because a select is on its blank option, or it is null because the
   client is being explicit that there is nobody to attach. All three mean the
   same thing to the ledger, so all three are normalised to null here rather
   than each caller having to remember which one this API wants. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional())
    .transform((v) => (v ?? null) as z.infer<T> | null);

const optionalId = optional(z.string().max(40));

export const paymentMethod = z
  .enum(['BANK_TRANSFER', 'E_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'PRE_AUTHORISED', 'OTHER'])
  .optional()
  .nullable();

const base = {
  date: isoDate,
  /* Dollars in, cents out. `money` caps the value so a pasted number that has
     stopped meaning anything cannot reach the ledger. */
  amount: money,
  description: z
    .string()
    .trim()
    .min(1, 'Say what this was for.')
    .max(200, 'That description is too long.'),
  categoryId: optionalId,
  paymentMethod,
  reference: optional(shortText('The reference', 60)),
};

export const incomeSchema = z.object({
  ...base,
  taxMode: z.enum(['ADD', 'INCLUSIVE', 'NONE']),
  clientId: optionalId,
});

export const expenseSchema = z.object({
  ...base,
  taxMode: z.enum(['ADD', 'INCLUSIVE', 'NONE']),
  vendorId: optionalId,
});

/* A drawing is not an expense with a different label, so it does not take a
   tax mode and it does take a purpose. Both of those are enforced again in the
   ledger service, because a voice entry in Phase 10 will post through the
   service without ever seeing this schema. */
export const drawingSchema = z.object({
  ...base,
  purpose: z
    .string()
    .trim()
    .min(1, 'Say what the drawing was for.')
    .max(150, 'Keep the note to 150 characters.'),
});

/* --------------------------------------------------------------- filters --- */

const optionalIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export const listQuerySchema = z.object({
  from: optionalIsoDate,
  to: optionalIsoDate,
  search: z.string().trim().max(80).optional(),
  categoryId: z.string().max(40).optional(),
  vendorId: z.string().max(40).optional(),
  clientId: z.string().max(40).optional(),
  paymentMethod: z
    .enum(['BANK_TRANSFER', 'E_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'PRE_AUTHORISED', 'OTHER'])
    .optional(),
  /* Expenses only: business expenses, drawings, or both. */
  show: z.enum(['all', 'expenses', 'drawings']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const clientSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the client a name.')
    .max(120, 'That name is too long.')
    .regex(/\p{L}/u, 'A client name needs at least one letter.'),
  email: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .regex(/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/, 'That does not look like an email address.'),
  ),
  phone: optional(shortText('The phone number', 30)),
});
