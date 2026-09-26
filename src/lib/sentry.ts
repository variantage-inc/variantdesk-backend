import * as Sentry from '@sentry/node';
import { env } from './env.js';

/* Error reporting, switched on by SENTRY_DSN and silent without it.

   Errors only, no tracing and no personal data. A bookkeeping API carries
   names, amounts and tax numbers in its requests, so nothing about the request
   body, cookies or headers is sent: the request id is how an event is matched
   to the log line that has the detail. */
export const sentryOn = Boolean(env.SENTRY_DSN);

if (sentryOn) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
      }
      delete event.user;
      return event;
    },
  });
}

export function report(err: unknown, requestId?: string): void {
  if (!sentryOn) return;
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag('request_id', requestId);
    Sentry.captureException(err);
  });
}
