import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './error.js';

/* A fixed window limiter, in memory.

   Good enough for one API process, which is what we run now. It does not
   survive a restart and does not coordinate across instances, so when the API
   is scaled horizontally this moves to Redis. Noted rather than hidden, because
   an in memory limiter on three instances allows three times the traffic. */
type Hit = { count: number; resetAt: number };
const hits = new Map<string, Hit>();

/* Stop the map growing without bound on a long running process. */
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of hits) if (hit.resetAt <= now) hits.delete(key);
}, 60_000).unref();

/* By address and path unless told otherwise. Signed out routes have nothing
   better to go on; signed in ones pass `keyOf` and are counted per person. */
export function rateLimit(
  max: number,
  windowMs: number,
  keyOf: (req: Request) => string = (req) => `${req.ip}:${req.path}`,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyOf(req);
    const now = Date.now();
    const hit = hits.get(key);

    if (!hit || hit.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('RateLimit-Remaining', String(max - 1));
      return next();
    }

    hit.count += 1;
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - hit.count)));
    if (hit.count > max) {
      const seconds = Math.ceil((hit.resetAt - now) / 1000);
      return next(
        new ApiError(429, `Too many attempts. Try again in ${seconds} seconds.`, 'rate_limited'),
      );
    }
    next();
  };
}

/* Every write that touches money, counted together per signed in person,
   whichever route it comes through: income, expenses, drawings, invoices,
   payments, clients, voice confirmations.

   Three hundred in fifteen minutes is a bookkeeper working through a shoebox
   of receipts at speed, with room to spare. It is not a script in a loop, and
   a stolen session spraying entries into somebody's books stops here. Keyed by
   user, not address, so an office behind one IP is not one person. Runs after
   requireAuth, so the user is known. */
export const moneyWriteLimit = rateLimit(
  300,
  15 * 60 * 1000,
  (req) => `money:${req.auth?.userId ?? req.ip}`,
);
