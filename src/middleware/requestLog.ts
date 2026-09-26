import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { isDev } from '../lib/env.js';

/* One line per request in production, as JSON, which is what Railway's and
   every other log viewer can search.

   What is in it: when, which request, the route, the status, how long, and
   which business and person asked. What is never in it: bodies, query strings,
   cookies, tokens. The public invoice route carries its key in the path, so
   that segment is replaced before anything is written. Development keeps
   morgan's short coloured lines instead. */

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

export const redactPath = (path: string): string =>
  path.split('?')[0]!.replace(/\/public\/invoices\/[^/]+/, '/public/invoices/:token');

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);

  if (isDev) return next();

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        id: req.id,
        method: req.method,
        path: redactPath(req.originalUrl),
        status: res.statusCode,
        ms: Math.round(ms),
        business: req.auth?.businessId,
        user: req.auth?.userId,
        ip: req.ip,
      }),
    );
  });
  next();
}
