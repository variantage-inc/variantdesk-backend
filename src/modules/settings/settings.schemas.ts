import { z } from 'zod';
import { businessName, email, password, province, shortText } from '../../lib/validation.js';

/* Settings is the screen every other screen quotes, which makes it the screen
   whose validation matters most. A bad GST number here prints on every invoice
   the business ever sends, and the client cannot claim the tax back from it.

   Everything builds on the shared rules in lib/validation.ts, so a name means
   the same thing here as it does at signup. */

/* Nine digits, RT, four digits. The CRA's format, and the whole reason it is
   checked: an invoice carrying a malformed registration number is an invoice
   the buyer's own accountant will send back. Spaces and hyphens are allowed on
   the way in and stripped, because that is how people copy it off a letter. */
const GST_NUMBER = /^\d{9}\s?-?\s?RT\s?-?\s?\d{4}$/i;

const optionalText = (label: string, max = 120) =>
  shortText(label, max).optional().or(z.literal('')).transform((v) => (v ? v : null));

export const businessProfileSchema = z.object({
  legalName: businessName,
  /* Blank means they trade under the legal name, which is the common case. */
  name: businessName.optional().or(z.literal('')),
  businessType: z.enum(['SOLE_PROPRIETOR', 'PARTNERSHIP', 'CORPORATION', 'CONTRACTOR']),
  addressLine1: optionalText('The address', 160),
  addressLine2: optionalText('The address', 160),
  city: optionalText('The city', 80),
  postalCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/, 'That is not a Canadian postal code.')
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : null)),
  email: email.optional().or(z.literal('')).transform((v) => (v ? v : null)),
  phone: optionalText('The phone number', 30),
  website: optionalText('The website', 120),
  businessNumber: optionalText('The business number', 20),
});

/* The province is not here. It is chosen at signup and fixed from then on:
   every tax figure already in the books was worked out from it, and a business
   that could switch province would have new entries and old ones taxed as if
   they were two different businesses. */
export const taxSchema = z
  .object({
    currency: z.enum(['CAD', 'USD'], { message: 'Choose Canadian or US dollars.' }),
    dateFormat: z.enum(['YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY']),
    fyStartMonth: z.coerce.number().int().min(1).max(12),
    gstRegistered: z.boolean(),
    gstHstNumber: z
      .string()
      .trim()
      .toUpperCase()
      .optional()
      .or(z.literal(''))
      .transform((v) => (v ? v.replace(/[\s-]/g, '') : null)),
  })
  /* A registered business without a number would print invoices that cannot be
     claimed against, so the two fields are checked together rather than
     separately. The error lands on the number, which is the field to fix. */
  .refine((v) => !v.gstRegistered || (v.gstHstNumber && GST_NUMBER.test(v.gstHstNumber)), {
    path: ['gstHstNumber'],
    message: 'Enter the registration number as nine digits, then RT and four more.',
  });

export const invoiceTemplateSchema = z.object({
  invoicePrefix: z.string().trim().max(12, 'Keep the prefix short.').default(''),
  /* The next number can be moved forward to continue an existing sequence, but
     the service refuses to move it backwards once invoices exist. An invoice
     number is never reissued. */
  nextInvoiceNumber: z.coerce
    .number()
    .int('Whole numbers only.')
    .min(1, 'Invoice numbers start at 1.')
    .max(9_999_999, 'That number is too large.'),
  invoiceNumberPad: z.coerce.number().int().min(0).max(6),
  paymentTermsDays: z.coerce.number().int().min(0).max(180),
  /* Basis points. 200 is 2% a month, and 0 is no interest charged. */
  lateInterestBp: z.coerce.number().int().min(0).max(1000),
  invoiceTerms: optionalText('The terms line', 160),
  invoiceFooter: optionalText('The footer', 240),
  invoicePayTo: optionalText('The payment details', 240),
});

export const securitySchema = z.object({
  idleTimeoutMinutes: z.coerce
    .number()
    .int()
    .min(5, 'Five minutes is the shortest we allow.')
    .max(60, 'An hour is the longest we allow.'),
  idleWarningSeconds: z.coerce.number().int().min(30).max(120),
});

export const changePasswordSchema = z.object({
  /* Optional, because an account created through Google has no current
     password to give. The service decides which of the two cases applies; it
     is not something the client gets to assert. */
  currentPassword: z.string().max(200).optional(),
  password,
});

export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the category a name.')
    .max(60, 'That name is too long.')
    .regex(/\p{L}/u, 'A category name needs at least one letter.'),
  kind: z.enum(['INCOME', 'EXPENSE', 'DRAWINGS']),
});

export const categoryUpdateSchema = categorySchema.partial().extend({
  archived: z.boolean().optional(),
});

export const vendorSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the vendor a name.')
    .max(80, 'That name is too long.')
    .regex(/\p{L}/u, 'A vendor name needs at least one letter.'),
  categoryId: z.string().min(1).optional().or(z.literal('')).transform((v) => (v ? v : null)),
});

export const vendorUpdateSchema = vendorSchema.partial().extend({
  archived: z.boolean().optional(),
});
