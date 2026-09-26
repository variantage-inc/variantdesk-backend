import { z } from 'zod';
import {
  businessName,
  email,
  password,
  personName,
  province,
  PROVINCES,
} from '../../lib/validation.js';

/* Auth request shapes, built from the shared field rules in lib/validation.ts
   so that a name means the same thing here as it will on every later screen. */

export { PROVINCES };

export const signupSchema = z.object({
  firstName: personName('first name'),
  lastName: personName('last name'),
  email,
  password,
  businessName,
  province,
});

export const loginSchema = z.object({
  /* Not the full email rule. Someone signing in has an account already, and
     lecturing them about the format of an address they have used for a year
     just gets in the way. A wrong address fails on the credentials instead. */
  email: z.string().trim().toLowerCase().min(1, 'Enter your email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'This reset link is not valid.'),
  password,
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
