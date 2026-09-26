import type { Response } from 'express';
import { env, isDev } from './env.js';

/* The refresh token lives here rather than in localStorage, because a cookie
   marked httpOnly cannot be read by JavaScript. That is the difference between
   a cross site scripting bug leaking one page and it leaking the session. */
export const REFRESH_COOKIE = 'vd_refresh';

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export function setRefreshCookie(res: Response, raw: string): void {
  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    /* Secure requires HTTPS, which localhost is not, so it is off in dev only. */
    secure: !isDev,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: THIRTY_DAYS,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth', secure: !isDev, sameSite: 'lax' });
}

export const corsOrigins = (): string[] => env.CORS_ORIGIN.split(',').map((s) => s.trim());
