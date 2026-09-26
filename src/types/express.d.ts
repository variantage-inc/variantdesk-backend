import type { AccessClaims } from '../lib/tokens.js';

/* Set by requireAuth, and by nothing else. If it is present, the token was
   valid. Routes read identity from here, never from the request body, because
   a client that can name its own businessId can read another business's books. */
declare global {
  namespace Express {
    interface Request {
      auth?: AccessClaims;
      /* One id per request, echoed in X-Request-Id and every log line, so a
         customer's report of an error can be found in the log. */
      id?: string;
    }
  }
}

export {};
