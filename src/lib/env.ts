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

  /* Voice entry. Optional so the API boots without it; the voice routes answer
     503 rather than crashing, the same way billing does. Server side only: it
     is never sent to the browser and the browser never calls Gemini. */
  GEMINI_API_KEY: z.string().optional(),
  /* Pinned in lib/gemini.ts. This overrides it without a deploy, which is what
     you want at three in the morning when a model starts answering badly. */
  GEMINI_MODEL: z.string().optional(),

  /* Neon Object Storage, where receipts live from Phase 8.

     S3 compatible, so these are the AWS standard names and the AWS SDK reads
     them from the environment without being told. Optional like everything
     else here: the API boots without them and the receipt routes answer 503,
     rather than the whole product refusing to start because nobody has made a
     bucket yet.

     The credentials are BRANCH SCOPED. These belong to `development`, and
     production gets its own, which is the point of storage that branches with
     the database: a development upload can never appear in production. */
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_ENDPOINT_URL_S3: z.string().optional(),
  AWS_REGION: z.string().default('us-east-2'),
  /* The bucket itself. Named rather than derived, so a second bucket later is
     a setting and not a code change. */
  STORAGE_BUCKET: z.string().default('receipts'),

  /* Stripe. All optional, so the API boots and the whole product works on its
     14 day trial without a single key. Billing routes answer 503 until the
     secret key and the two plan prices are present. */
  STRIPE_SECRET_KEY: z.string().optional(),
  /* From the Stripe CLI in development, or the endpoint in the dashboard in
     production. Without it a webhook cannot be verified, and an unverified
     webhook is an unauthenticated stranger telling us someone has paid. */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /* Events from the businesses' own connected accounts (invoice payments). In
     production a Connect endpoint in the dashboard has its own signing secret;
     the Stripe CLI signs both kinds with STRIPE_WEBHOOK_SECRET, so in
     development this stays empty. */
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  /* Price ids, not amounts. Stripe owns what is charged; lib/plans.ts only
     holds what the customer is shown. */
  STRIPE_PRICE_ESSENTIAL: z.string().optional(),
  STRIPE_PRICE_SOLUTIONS_360: z.string().optional(),
  STRIPE_PRICE_EXTRA_USER: z.string().optional(),

  /* Error reporting. Optional: without it errors go to the log only. */
  SENTRY_DSN: z.string().url().optional(),

  /* The refresh cookie. `lax` works when the web app and the API share a
     parent domain (app.variantage.com and api.variantage.com), which is the
     deployment this is built for. Two unrelated domains, such as the default
     *.vercel.app and *.up.railway.app, need `none`, and browsers accept `none`
     only over HTTPS. */
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
}).superRefine((e, ctx) => {
  /* Production refuses to boot on settings that only make sense locally. */
  if (e.NODE_ENV !== 'production') return;
  const fail = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (!e.APP_URL.startsWith('https://')) fail('APP_URL', 'must be https in production');
  if (/localhost|127\.0\.0\.1/.test(e.CORS_ORIGIN)) fail('CORS_ORIGIN', 'still points at localhost');
  if (e.GOOGLE_CLIENT_ID && /localhost/.test(e.GOOGLE_REDIRECT_URI)) {
    fail('GOOGLE_REDIRECT_URI', 'still points at localhost');
  }
  if (e.STRIPE_SECRET_KEY && !e.STRIPE_WEBHOOK_SECRET) {
    fail('STRIPE_WEBHOOK_SECRET', 'is required when Stripe is on, or no payment is ever confirmed');
  }
  if (e.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
    fail('STRIPE_SECRET_KEY', 'is a test key, and production takes real payments');
  }
  if (e.EMAIL_FROM.endsWith('@resend.dev')) {
    fail('EMAIL_FROM', 'is the Resend sandbox sender, which only reaches the account owner');
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`);
  console.error('Environment is not usable:\n' + lines.join('\n'));
  process.exit(1);
}

export const env = parsed.data;
export const isDev = env.NODE_ENV === 'development';
