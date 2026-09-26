import type { Request } from 'express';

/* One route parameter, as a string.

   Express 5 types a path parameter as `string | string[] | undefined`, because
   a pattern like `/:id+` can legitimately match several segments. None of ours
   do, so rather than repeat the same narrowing in every handler it happens
   once here. An array or a missing value becomes an empty string, which every
   service below already treats as "no such row" and answers with a 404. */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return typeof value === 'string' ? value : '';
}

/* A query string value, trimmed and capped. Anything repeated or missing
   becomes undefined rather than an array, so a caller cannot smuggle a shape
   the handler was not expecting into a database query. */
export function query(req: Request, name: string, max = 120): string | undefined {
  const value = req.query[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed || undefined;
}
