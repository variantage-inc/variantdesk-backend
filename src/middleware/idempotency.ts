import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { ApiError } from './error.js';

/* Idempotency, rule 4 of the financial architecture.

   A write that arrives twice must not post the money twice. Three ways that
   actually happens, and none of them are exotic:

     a button double clicked on a slow connection
     a request retried by the browser or a proxy after a timeout
     a voice entry confirmed twice because the first tap looked like nothing

   The client sends X-Idempotency-Key. The first request runs, and its answer
   is stored against that key. A repeat gets the stored answer back, byte for
   byte, without the ledger being touched at all. That is the important part:
   a retry has to look like it worked, not like it failed, or the person will
   press the button a third time.

   The key is claimed BEFORE the handler runs, not after, so two requests
   racing on the same key cannot both get past this point. The loser is told
   the first one is still in flight rather than being allowed to post again. */

const HEADER = 'x-idempotency-key';

/* Deliberately optional rather than required.

   Making it mandatory would mean an API that refuses a perfectly valid request
   because a header is missing, and it would break the moment anything calls
   these routes without knowing the convention. Clients that send a key get the
   guarantee; clients that do not get the ordinary behaviour they asked for. */
export async function idempotent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = req.headers[HEADER];
  const key = typeof raw === 'string' ? raw.trim() : null;

  if (!key || !req.auth) return next();

  if (key.length > 200) {
    return next(new ApiError(400, 'That idempotency key is too long.', 'bad_idempotency_key'));
  }

  const businessId = req.auth.businessId;
  /* The endpoint is part of the record, so the same key cannot be replayed
     against a different route and hand back an answer that was never about
     this request. */
  const endpoint = `${req.method} ${req.baseUrl}${req.path}`;

  const seen = await prisma.idempotencyKey.findUnique({
    where: { businessId_key: { businessId, key } },
  });

  if (seen) {
    if (seen.endpoint !== endpoint) {
      return next(
        new ApiError(
          409,
          'That idempotency key has already been used for a different request.',
          'idempotency_key_reused',
        ),
      );
    }
    /* status 0 marks a claim with no answer yet: the first request is still
       running. Answering 409 rather than replaying nothing is what stops the
       second request going on to post the money itself. */
    if (seen.status === 0) {
      return next(
        new ApiError(409, 'That request is still being processed.', 'idempotency_in_flight'),
      );
    }
    res.status(seen.status).json(seen.response);
    return;
  }

  try {
    await prisma.idempotencyKey.create({
      data: { businessId, key, endpoint, status: 0, response: {} },
    });
  } catch (err) {
    /* Two requests arrived together and the other one won the insert. */
    if (isUniqueViolation(err)) {
      return next(
        new ApiError(409, 'That request is still being processed.', 'idempotency_in_flight'),
      );
    }
    throw err;
  }

  /* Capture whatever the handler answers, so the replay is the real response
     rather than a summary of it. res.json is wrapped rather than the response
     rebuilt afterwards, because only the handler knows its own shape. */
  const send = res.json.bind(res);
  let captured = false;

  res.json = (body: unknown) => {
    if (!captured) {
      captured = true;
      const status = res.statusCode;

      if (status >= 200 && status < 300) {
        void prisma.idempotencyKey
          .update({
            where: { businessId_key: { businessId, key } },
            data: { status, response: body as object },
          })
          .catch(() => undefined);
      } else {
        /* A failed request is not an answer worth replaying. The claim is
           released so the customer can fix the problem and try again with the
           same key, which is what their client will naturally do. */
        void prisma.idempotencyKey
          .delete({ where: { businessId_key: { businessId, key } } })
          .catch(() => undefined);
      }
    }
    return send(body);
  };

  next();
}
