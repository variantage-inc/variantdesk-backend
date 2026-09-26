/* Every error leaves through here, in one shape, so the frontend never has to
   guess. Stack traces are for the log, never the response body. */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isDev } from '../lib/env.js';
import { report } from '../lib/sentry.js';
import { redactPath } from './requestLog.js';

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
  req: Request,
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

  /* A body over a parser's limit, or JSON that does not parse, is the
     caller's mistake and said plainly, not a 500. */
  const parser = err as { status?: number; type?: string };
  if (parser.status === 413) {
    return res.status(413).json({ error: { code: 'too_large', message: 'That is larger than we accept.' } });
  }
  if (parser.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: 'That request could not be read.' } });
  }

  /* The detail goes to the log and to Sentry, tagged with the request id. The
     customer gets the id, so support can find the one line that matters. */
  if (isDev) {
    console.error(err);
  } else {
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: 'error',
        id: req.id,
        path: redactPath(req.originalUrl),
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
  }
  report(err, req.id);

  res.status(500).json({
    error: {
      code: 'server_error',
      message: 'Something went wrong at our end.',
      requestId: req.id,
      ...(isDev && err instanceof Error ? { detail: err.message } : {}),
    },
  });
}
