import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from './env.js';

/* Two tokens, doing two different jobs.

   The ACCESS token is a short lived JWT the client sends on every request. It
   carries the identity claims so a request needs no database lookup.

   The REFRESH token is a long lived random string kept in an httpOnly cookie.
   It is stored hashed, and rotated on every use, so a stolen one is good for
   at most a single refresh before it stops working. */

export type AccessClaims = {
  userId: string;
  businessId: string;
  role: 'OWNER' | 'MEMBER';
  platformRole: 'SUPERADMIN' | 'CUSTOMER';
};

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: 'variantage',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    return jwt.verify(token, env.JWT_SECRET, { issuer: 'variantage' }) as AccessClaims;
  } catch {
    return null;
  }
}

/* SHA-256, not bcrypt, and deliberately.

   Bcrypt is slow on purpose, which is right for passwords because people pick
   guessable ones. A refresh token is 256 bits of randomness, so there is
   nothing to guess and no dictionary to try. It also has to be looked up by
   value on every refresh, and a slow hash would mean scanning every row. */
export const hashToken = (raw: string): string =>
  crypto.createHash('sha256').update(raw).digest('hex');

export function newRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

/* Password reset and member invite links. Same shape, different lifetimes. */
export function newLinkToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

/* A brand new Google user has an identity but no business, and we cannot make
   one up: without a province there is no tax rate, and every invoice they ever
   send would be wrong. So the identity is parked in a short lived token, the
   user is asked for their business, and the account is created after that.

   `purpose` keeps this token from being accepted anywhere an access token is,
   even though both are signed with the same secret. */
export type PendingSignup = {
  purpose: 'google_signup';
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
};

export function signPendingSignup(data: Omit<PendingSignup, 'purpose'>): string {
  return jwt.sign({ ...data, purpose: 'google_signup' }, env.JWT_SECRET, {
    expiresIn: '30m',
    issuer: 'variantage',
  });
}

export function verifyPendingSignup(token: string): PendingSignup | null {
  try {
    const claims = jwt.verify(token, env.JWT_SECRET, { issuer: 'variantage' }) as PendingSignup;
    return claims.purpose === 'google_signup' ? claims : null;
  } catch {
    return null;
  }
}
