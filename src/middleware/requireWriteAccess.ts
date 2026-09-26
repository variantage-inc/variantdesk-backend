import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { accessFrom } from '../modules/billing/access.js';
import { ApiError } from './error.js';

/* The paywall, and it is one line of logic.

   Put on every route that creates or changes a customer's records. Reads are
   deliberately never guarded: when a trial ends or a subscription lapses the
   account goes read only, not dark. They keep every screen and every export.

   That is a considered softening of "everything is disabled". Locking an owner
   out of their own books is not an option, because the CRA requires them to
   keep six years of records, and because a customer who cannot get their data
   out does not come back.

   Security, billing and the sign out routes are exempt for the same reason in
   reverse: someone must always be able to secure their account and pay us. */
export async function requireWriteAccess(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) return next(new ApiError(401, 'You need to sign in.', 'unauthenticated'));

    const sub = await prisma.subscription.findUnique({
      where: { businessId: req.auth.businessId },
    });
    const access = accessFrom(sub);

    if (access.canWrite) return next();

    const message =
      access.state === 'past_due'
        ? 'Your last payment did not go through, so the account is read only until it is settled. Everything you have is still here to view and export.'
        : 'Your free trial has ended, so the account is read only. Choose a plan to start adding again. Everything you have is still here to view and export.';

    next(new ApiError(402, message, 'read_only'));
  } catch (err) {
    next(err);
  }
}
