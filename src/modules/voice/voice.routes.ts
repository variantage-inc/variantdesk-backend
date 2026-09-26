import { Router, type Request } from 'express';
import express from 'express';
import { param } from '../../lib/params.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireWriteAccess } from '../../middleware/requireWriteAccess.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { ApiError } from '../../middleware/error.js';
import { AUDIO_TYPES, MAX_CLIP_BYTES, MAX_CLIP_SECONDS, geminiConfigured } from '../../lib/gemini.js';
import * as voice from './voice.service.js';
import { confirmSchema } from './voice.schemas.js';

export const voiceRouter: Router = Router();

/* Speaking an entry.

   Two steps, and the gap between them is the feature.

   POST /voice        a clip goes to Gemini and comes back as a DRAFT
   POST /voice/:id/confirm   a person has checked it, so now it becomes money

   Nothing between those two writes to the ledger, and the second one is an
   ordinary entry write with ordinary validation. `requireWriteAccess` sits on
   both: a read only account cannot dictate an entry any more than it can type
   one, and being told that before recording is kinder than after.

   The clip arrives as a raw body rather than a form. It is one file with one
   content type, so a multipart parser would be a dependency and a temporary
   file in exchange for nothing. */

const audioBody = express.raw({
  type: [...AUDIO_TYPES],
  limit: MAX_CLIP_BYTES,
});

/* Rules document section 7: voice routes are rate limited, and this one costs
   real money per call. Twenty clips in fifteen minutes is far more than anybody
   dictating their books will use and far less than a loop can spend. */
const clipLimit = rateLimit(20, 15 * 60 * 1000);

voiceRouter.get('/voice/options', requireAuth, async (req, res, next) => {
  try {
    res.json({
      ...(await voice.options(req.auth!.businessId)),
      /* The screen asks before it turns the microphone on, so it can say "not
         switched on yet" instead of failing after somebody has spoken. */
      configured: geminiConfigured(),
      maxSeconds: MAX_CLIP_SECONDS,
    });
  } catch (err) {
    next(err);
  }
});

voiceRouter.post(
  '/voice',
  requireAuth,
  requireWriteAccess,
  clipLimit,
  audioBody,
  async (req: Request, res, next) => {
    try {
      const audio = req.body as unknown;

      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        /* Either the body was empty or express.raw refused the content type,
           which is the same thing to the person holding the microphone. */
        throw new ApiError(
          400,
          'That recording did not arrive. Try again, or type the entry in.',
          'no_audio',
        );
      }

      const draft = await voice.capture(
        { businessId: req.auth!.businessId, userId: req.auth!.userId },
        audio,
        req.headers['content-type']?.split(';')[0]?.trim() ?? 'audio/wav',
      );

      res.status(201).json({ draft });
    } catch (err) {
      next(err);
    }
  },
);

voiceRouter.get('/voice/:id', requireAuth, async (req, res, next) => {
  try {
    res.json({ draft: await voice.one(req.auth!.businessId, param(req, 'id')!) });
  } catch (err) {
    next(err);
  }
});

/* The one write. Idempotent, like every other money write, so a double
   clicked Save cannot post the same entry twice. */
voiceRouter.post(
  '/voice/:id/confirm',
  requireAuth,
  requireWriteAccess,
  idempotent,
  validate(confirmSchema),
  async (req, res, next) => {
    try {
      const result = await voice.confirm(
        { businessId: req.auth!.businessId, userId: req.auth!.userId },
        param(req, 'id')!,
        req.body,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

voiceRouter.post('/voice/:id/discard', requireAuth, requireWriteAccess, async (req, res, next) => {
  try {
    res.json({
      draft: await voice.discard(
        { businessId: req.auth!.businessId, userId: req.auth!.userId },
        param(req, 'id')!,
      ),
    });
  } catch (err) {
    next(err);
  }
});
