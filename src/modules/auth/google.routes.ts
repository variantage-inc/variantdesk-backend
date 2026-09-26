import { Router } from 'express';
import { z } from 'zod';
import { env, isDev } from '../../lib/env.js';
import { buildAuthUrl, exchangeCode, googleConfigured, newState } from '../../lib/google.js';
import { setRefreshCookie } from '../../lib/cookies.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { ApiError } from '../../middleware/error.js';
import { businessName, province } from '../../lib/validation.js';
import { completeGoogleSignup, signInWithGoogle } from './google.service.js';

export const googleRouter: Router = Router();

const STATE_COOKIE = 'vd_oauth_state';

const ctx = (req: { headers: Record<string, unknown>; ip?: string }) => ({
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  ip: req.ip,
});

/* Step one. Mint a state value, remember it in a short lived cookie, and send
   the user to Google. The cookie is how the callback proves the response came
   back to the same browser that started, which is what stops an attacker
   handing someone a callback URL carrying their own code. */
googleRouter.get('/', rateLimit(20, 15 * 60 * 1000), (_req, res, next) => {
  if (!googleConfigured()) {
    return next(new ApiError(503, 'Google sign in is not configured.', 'google_off'));
  }
  const state = newState();
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: !isDev,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/api/auth/google',
  });
  res.redirect(buildAuthUrl(state));
});

/* Step two. Google sends the user back here.

   Everything ends in a redirect rather than JSON, because a browser landed on
   this URL, not a fetch. Failures go to the sign in page with a code the
   screen can turn into a sentence; tokens never travel in the URL. */
googleRouter.get('/callback', async (req, res) => {
  const fail = (code: string) => res.redirect(`${env.APP_URL}/login?error=${code}`);

  try {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const expected = req.cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: '/api/auth/google' });

    /* The user pressed cancel on Google's screen. Not an error worth shouting
       about, just send them back. */
    if (error) return fail('google_cancelled');
    if (!code || !state) return fail('google_incomplete');
    if (!expected || state !== expected) return fail('google_state');

    const identity = await exchangeCode(code);
    const outcome = await signInWithGoogle(identity, ctx(req));

    if (outcome.kind === 'signed_in') {
      setRefreshCookie(res, outcome.refreshToken);
      /* No access token in the URL. The page we land on asks the API for one
         using the cookie, so nothing sensitive reaches the browser history,
         the referrer header or the server logs. */
      return res.redirect(`${env.APP_URL}/auth/callback`);
    }

    /* New to Variantage. We know who they are but not what their business is,
       and without a province there is no tax rate. */
    return res.redirect(
      `${env.APP_URL}/signup/business?token=${encodeURIComponent(outcome.pendingToken)}`,
    );
  } catch (err) {
    console.error('Google sign in failed:', err instanceof Error ? err.message : err);
    return fail('google_failed');
  }
});

const completeSchema = z.object({
  token: z.string().min(1),
  businessName,
  province,
});

/* Step three, and only for people new to Variantage. */
googleRouter.post('/complete', validate(completeSchema), async (req, res, next) => {
  try {
    const result = await completeGoogleSignup(
      req.body.token,
      req.body.businessName,
      req.body.province,
      ctx(req),
    );
    setRefreshCookie(res, result.refreshToken);
    res.status(201).json({
      accessToken: result.accessToken,
      user: result.user,
      business: result.business,
      access: result.access,
    });
  } catch (err) {
    next(err);
  }
});
