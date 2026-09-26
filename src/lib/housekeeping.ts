import { prisma } from './prisma.js';

/* Things that would otherwise grow for ever.

   An idempotency key exists to catch a double click or a retry, which happens
   within seconds. A week is far longer than any retry and far shorter than
   the table becoming the biggest thing in the database. Nothing here touches
   money, sessions or anything a person would miss. */

const DAY = 24 * 60 * 60 * 1000;
const KEEP_KEYS_DAYS = 7;

export async function sweep(): Promise<void> {
  try {
    await prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - KEEP_KEYS_DAYS * DAY) } },
    });
  } catch (err) {
    /* A missed sweep costs nothing; tomorrow's does the same job. */
    console.error('Housekeeping failed:', err instanceof Error ? err.message : err);
  }
}

export function startHousekeeping(): void {
  setTimeout(() => void sweep(), 60_000).unref();
  setInterval(() => void sweep(), DAY).unref();
}
