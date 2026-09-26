import { z } from 'zod';

/* The provinces the product supports. A code rather than free text, because
   the province decides the tax rate and a typo would mean the wrong rate on
   every invoice. */
export const PROVINCES = [
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
] as const;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address.')
  .email('That does not look like an email address. Check for a missing @ or a typo.');

/* Ten characters, matching what the sign up screen tells the user. Length is
   what actually makes a password hard to crack; forcing symbols mostly makes
   people write them on a note by the monitor. */
const password = z
  .string()
  .min(10, 'Passwords must be at least 10 characters long.')
  .max(200, 'That password is too long.');

const name = (label: string) =>
  z.string().trim().min(1, `Enter your ${label}.`).max(80);

export const signupSchema = z.object({
  firstName: name('first name'),
  lastName: name('last name'),
  email,
  password,
  businessName: z.string().trim().min(1, 'Enter your business name.').max(120),
  province: z.enum(PROVINCES, { message: 'Choose your province.' }),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'This reset link is not valid.'),
  password,
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
