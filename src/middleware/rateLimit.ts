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

export function rateLimit(max: number, windowMs: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const hit = hits.get(key);

    if (!hit || hit.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    hit.count += 1;
    if (hit.count > max) {
      const seconds = Math.ceil((hit.resetAt - now) / 1000);
      return next(
        new ApiError(429, `Too many attempts. Try again in ${seconds} seconds.`, 'rate_limited'),
      );
    }
    next();
  };
}
