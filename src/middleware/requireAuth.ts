import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../lib/tokens.js';
import { ApiError } from './error.js';

/* The only place a request becomes authenticated. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, 'You need to sign in.', 'unauthenticated'));

  const claims = verifyAccessToken(token);
  if (!claims) return next(new ApiError(401, 'Your session has expired.', 'token_expired'));

  req.auth = claims;
  next();
}

/* Owner only actions: billing, plan changes, adding and removing members.
   A member can run the business day to day but cannot cancel the subscription
   or remove the person paying for it. */
export function requireOwner(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(new ApiError(401, 'You need to sign in.', 'unauthenticated'));
  if (req.auth.role !== 'OWNER') {
    return next(new ApiError(403, 'Only the account owner can do that.', 'forbidden'));
  }
  next();
}

/* Variantage staff only. Deliberately checks the platform role, which no
   customer can grant, rather than anything inside a business. */
export function requireSuperadmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth?.platformRole !== 'SUPERADMIN') {
    return next(new ApiError(404, 'Not found.', 'not_found'));
  }
  next();
}
