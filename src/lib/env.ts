/* Environment, validated once at boot. A missing DATABASE_URL should stop the
   process with a sentence you can act on, not surface as a null three files
   deep at the first query. */
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /* Pooled. Neon's PgBouncer endpoint, which is what the running app must use. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is not set. Copy .env.example to .env'),
  /* Direct. Used by migrations only, which need a real session. */
  DATABASE_URL_UNPOOLED: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  /* Where reset and invite links point. */
  APP_URL: z.string().url().default('http://localhost:3000'),

  /* Optional so the API still boots without it. Without a key nothing sends,
     and in development the link is logged instead. */
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('onboarding@resend.dev'),

  /* Continue with Google. Optional so the API boots without it; the routes
     answer 503 rather than crashing when it is not configured. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:4000/api/auth/google/callback'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`);
  console.error('Environment is not usable:\n' + lines.join('\n'));
  process.exit(1);
}

export const env = parsed.data;
export const isDev = env.NODE_ENV === 'development';
