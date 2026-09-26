import { z } from 'zod';
import { money, province, shortText } from '../../lib/validation.js';

/* What the API accepts for an invoice and its payments.

   Amounts and quantities arrive as the numbers a person typed, and are turned
   into integers once, in the service. Nothing downstream sees a float. */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'That is not a real date.')
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional())
    .transform((v) => (v ?? null) as z.infer<T> | null);

const lineSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, 'Say what this line is for.')
    .max(200, 'That description is too long.'),
  /* Three decimal places, because 7.5 hours and 0.25 of a day are both real.
     More than that is a typo rather than a quantity. */
  quantity: z
    .number()
    .finite('Enter a quantity.')
    .positive('A quantity has to be more than zero.')
    .max(1_000_000, 'That quantity is too large.'),
  unitPrice: money,
});

export const invoiceSchema = z
  .object({
    clientId: z.string().min(1, 'Choose a client.'),
    issueDate: isoDate,
    paymentTermsDays: z.coerce.number().int().min(0).max(180),
    lines: z.array(lineSchema).min(1, 'An invoice needs at least one line.').max(60),
    discountMode: z.enum(['AMOUNT', 'PERCENT']).default('AMOUNT'),
    discountValue: z.coerce.number().finite().min(0).default(0),
    chargeTax: z.boolean().default(true),
    notes: optional(shortText('The note', 500)),
  })
  /* A percentage over 100 would take more off than the invoice is worth, which
     the service refuses anyway. Caught here so the message lands on the field
     the person is looking at. */
  .refine((v) => v.discountMode !== 'PERCENT' || v.discountValue <= 100, {
    path: ['discountValue'],
    message: 'A discount cannot be more than 100%.',
  });

export const paymentSchema = z.object({
  date: isoDate,
  amount: money,
  method: z
    .enum(['BANK_TRANSFER', 'E_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'PRE_AUTHORISED', 'OTHER'])
    .optional()
    .nullable(),
  reference: optional(shortText('The reference', 60)),
});

export const invoiceListQuerySchema = z.object({
  status: z.enum(['all', 'draft', 'sent', 'part', 'paid', 'overdue']).optional(),
  clientId: z.string().max(40).optional(),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
});

export const clientSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the client a name.')
    .max(120, 'That name is too long.')
    .regex(/\p{L}/u, 'A client name needs at least one letter.'),
  contactName: optional(shortText('The contact name', 80)),
  email: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .regex(/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/, 'That does not look like an email address.'),
  ),
  phone: optional(shortText('The phone number', 30)),
  addressLine1: optional(shortText('The address', 160)),
  addressLine2: optional(shortText('The address', 160)),
  city: optional(shortText('The city', 80)),
  province: optional(province),
  postalCode: optional(
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/, 'That is not a Canadian postal code.'),
  ),
  /* Null means use the business default rather than "no terms", which is why
     it is nullable instead of defaulting to zero. */
  paymentTermsDays: optional(z.coerce.number().int().min(0).max(180)),
  notes: optional(shortText('The note', 500)),
});
