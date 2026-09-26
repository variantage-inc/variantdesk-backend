import { Router } from 'express';
import { isDev } from '../../lib/env.js';
import { REFRESH_COOKIE, clearRefreshCookie, setRefreshCookie } from '../../lib/cookies.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { ApiError } from '../../middleware/error.js';
import * as auth from './auth.service.js';
import {
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
} from './auth.schemas.js';

export const authRouter: Router = Router();

const ctx = (req: { headers: Record<string, unknown>; ip?: string }) => ({
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  ip: req.ip,
});

/* The refresh token goes in an httpOnly cookie the browser sends back on its
   own. The access token goes in the response body for the client to hold in
   memory. Neither is written to localStorage, where any script on the page
   could read it. */
function respondWithSession(
  res: Parameters<typeof setRefreshCookie>[0],
  result: { refreshToken: string; accessToken: string; user: unknown; business: unknown },
  status = 200,
) {
  setRefreshCookie(res, result.refreshToken);
  res.status(status).json({
    accessToken: result.accessToken,
    user: result.user,
    business: result.business,
  });
}

/* Limits are per IP per route. Generous enough that a person retyping a
   password is never blocked, tight enough that guessing is not worth doing. */
const loginLimit = rateLimit(10, 15 * 60 * 1000);
const signupLimit = rateLimit(5, 60 * 60 * 1000);
const resetLimit = rateLimit(5, 60 * 60 * 1000);

authRouter.post('/signup', signupLimit, validate(signupSchema), async (req, res, next) => {
  try {
    respondWithSession(res, await auth.signup(req.body, ctx(req)), 201);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', loginLimit, validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    respondWithSession(res, await auth.login(email, password, ctx(req)));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new ApiError(401, 'Please sign in again.', 'no_refresh');
    respondWithSession(res, await auth.refresh(token, ctx(req)));
  } catch (err) {
    clearRefreshCookie(res);
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    await auth.logout(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json(await auth.me(req.auth!.userId));
  } catch (err) {
    next(err);
  }
});

authRouter.post(
  '/forgot-password',
  resetLimit,
  validate(forgotPasswordSchema),
  async (req, res, next) => {
    try {
      const { resetToken } = await auth.forgotPassword(req.body.email);

      /* The token is never returned. Until Resend is wired up it is logged so
         the flow can be tested locally, and only in development. */
      if (isDev && resetToken) {
        console.log(`[dev] password reset token for ${req.body.email}: ${resetToken}`);
      }

      res.json({
        ok: true,
        message: 'If that address has an account, a reset link is on its way.',
      });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  '/reset-password',
  resetLimit,
  validate(resetPasswordSchema),
  async (req, res, next) => {
    try {
      await auth.resetPassword(req.body.token, req.body.password);
      clearRefreshCookie(res);
      res.json({ ok: true, message: 'Your password has been changed. Sign in with the new one.' });
    } catch (err) {
      next(err);
    }
  },
);
