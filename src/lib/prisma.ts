/* One Prisma client for the process.

   Prisma 7 connects through a driver adapter rather than its own engine, so
   the pg Pool below is the real connection pool. `tsx watch` re-evaluates
   modules on every save, so without the global cache a long dev session opens
   a new pool per reload and eventually exhausts Postgres. */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env, isDev } from './env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter, log: isDev ? ['warn', 'error'] : ['error'] });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (isDev) globalForPrisma.prisma = prisma;
