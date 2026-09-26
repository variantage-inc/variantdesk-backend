/* Prisma 7 keeps CLI configuration here rather than in the schema. This is what
   `prisma migrate`, `prisma db push` and `prisma studio` read; the running
   application connects through the pg adapter in src/lib/prisma.ts instead.

   Migrations deliberately use the UNPOOLED connection. Neon's pooled endpoint
   runs PgBouncer in transaction mode, which does not hold a session across
   statements, and migrations need exactly that for advisory locks and DDL.
   The application keeps the pooled URL, because serverless needs the pooling. */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const migrationUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: migrationUrl,
  },
});
