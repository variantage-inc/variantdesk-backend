import { z } from 'zod';

/* Shared field rules.

   Every schema in the API builds from these, so a rule is written once and
   every screen that touches the same kind of field behaves the same way. When
   a new module needs a person's name or an email, it imports from here rather
   than writing another regex.

   The frontend mirrors this file. The two must change together, and the API is
   the authority: anything the browser checks is a courtesy, and anything that
   matters is checked again here. */

/* Deliberately not \w or [a-z]. Real customers are called Renée, O'Brien,
   Jean-Luc and St. John, and a Canadian product that rejects accents would be
   embarrassing. What it does refuse is digits, because a first name is not 89. */
const NAME = /^\p{L}[\p{L}\p{M}'’.\- ]*$/u;

/* Local part, @, domain, dot, and a real suffix. Zod alone accepts a@b, which
   is valid by RFC and useless as a customer's address. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export const personName = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter your ${label}.`)
    .max(80, `That ${label} is too long.`)
    .regex(NAME, `A ${label} cannot contain numbers or symbols.`);

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .regex(EMAIL, 'That does not look like an email address. Check for a missing @ or a typo.');

/* Ten characters, matching what the sign up screen tells the user. Length is
   what makes a password hard to crack; forcing symbols mostly makes people
   write them on a note stuck to the monitor. */
export const password = z
  .string()
  .min(10, 'Passwords must be at least 10 characters long.')
  .max(200, 'That password is too long.');

/* A business name is not a person's name. "123 Plumbing" and "A&W" are real,
   so digits and symbols are fine. What is refused is a name with no letter in
   it at all, which is always a mistake or a test entry. */
export const businessName = z
  .string()
  .trim()
  .min(2, 'Enter your business name.')
  .max(120, 'That business name is too long.')
  .regex(/\p{L}/u, 'A business name needs at least one letter.');

export const PROVINCES = [
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
] as const;

export const province = z.enum(PROVINCES, { message: 'Choose your province.' });

/* Free text a customer types about their own records. Trimmed and capped so a
   runaway paste cannot fill a column, but otherwise left alone: it is their
   description of their own expense, not ours to police. */
export const shortText = (label: string, max = 200) =>
  z.string().trim().max(max, `${label} cannot be longer than ${max} characters.`);

export const money = z
  .number()
  .finite('Enter a valid amount.')
  .nonnegative('An amount cannot be negative.')
  /* Guards against a pasted value that no longer means anything once it is
     converted to cents. */
  .max(99_999_999, 'That amount is too large.');
