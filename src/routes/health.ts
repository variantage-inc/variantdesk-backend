/* The end-to-end proof: this route touches the database, so a 200 here means
   the frontend reached the API and the API reached Postgres. It is the first
   thing to check when something is not working. */
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

/* Prisma wraps driver failures several layers deep, and the outer message is
   often just "Invalid `prisma.$queryRaw()` invocation". The bottom of the chain
   is the part worth reading: ECONNREFUSED, password authentication failed,
   database does not exist. */
function rootCause(err: unknown, depth = 0): string | null {
  if (depth > 5 || !(err instanceof Error)) return null;
  const deeper = rootCause((err as { cause?: unknown }).cause, depth + 1);
  if (deeper) return deeper;
  const msg = err.message.replace(/\s+/g, ' ').trim();
  return msg.length > 0 ? msg : null;
}

export const healthRouter: Router = Router();

healthRouter.get('/', async (_req, res) => {
  const startedAt = Date.now();
  let database: { ok: boolean; latencyMs?: number; message?: string; hint?: string };

  try {
    await prisma.$queryRaw`SELECT 1`;
    database = { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    /* Prisma wraps driver failures, and its own message is often just
       "Invalid `prisma.$queryRaw()` invocation". The cause underneath is the
       part that tells you what is actually wrong: ECONNREFUSED, bad password,
       no such database. So unwrap it. */
    const detail = rootCause(err) ?? 'Could not reach the database';

    database = {
      ok: false,
      message: detail,
      hint: 'Is Postgres running? `docker compose up -d` from the project root.',
    };
  }

  res.status(database.ok ? 200 : 503).json({
    service: 'variantage-api',
    status: database.ok ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    database,
  });
});
