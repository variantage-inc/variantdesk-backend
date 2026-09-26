/* Every error leaves through here, in one shape, so the frontend never has to
   guess. Stack traces are for the log, never the response body. */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isDev } from '../lib/env.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
  ) {
    super(message);
  }
}

export function notFound(req: Request, res: Response) {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.originalUrl}` },
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Some fields need attention.',
        /* field -> message, so the form can put each one under its own input */
        fields: Object.fromEntries(
          err.issues.map((i) => [i.path.join('.'), i.message]),
        ),
      },
    });
  }

  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }

  console.error(err);
  res.status(500).json({
    error: {
      code: 'server_error',
      message: 'Something went wrong at our end.',
      ...(isDev && err instanceof Error ? { detail: err.message } : {}),
    },
  });
}
