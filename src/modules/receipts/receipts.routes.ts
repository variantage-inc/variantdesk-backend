import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { param } from '../../lib/params.js';
import { disposition } from '../../lib/storage.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireWriteAccess } from '../../middleware/requireWriteAccess.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { ApiError } from '../../middleware/error.js';
import * as receipts from './receipts.service.js';

export const receiptsRouter: Router = Router();

/* Receipts and documents.

   A file arrives as the raw body, as application/octet-stream, with its name
   in X-File-Name. Deliberately not multipart: it is one file, and a form
   parser would be a dependency and a temporary file in exchange for nothing.
   The declared type is ignored anyway, because the service reads the bytes.

   Reading is open to anyone signed in, including a read only account: the
   receipts are theirs and the CRA wants them kept. Adding and removing need
   write access, exactly like the entries they belong to. */

/* The limit is a little over the service's own, so a file just over 10 MB is
   refused by the service with a sentence rather than by the parser. The parser
   still stops anything absurd before it is held in memory. */
const parseFile = express.raw({
  type: 'application/octet-stream',
  limit: receipts.MAX_RECEIPT_BYTES + 64 * 1024,
});

export function fileBody(req: Request, res: Response, next: NextFunction): void {
  parseFile(req, res, (err?: unknown) => {
    if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large') {
      return next(new ApiError(413, 'That file is too large.', 'file_too_large'));
    }
    if (err) return next(err);
    if (!Buffer.isBuffer(req.body)) {
      return next(new ApiError(400, 'No file arrived. Choose it again.', 'no_file'));
    }
    next();
  });
}

export const fileName = (req: Request): string | undefined => {
  const raw = req.headers['x-file-name'];
  return typeof raw === 'string' ? raw : undefined;
};

/* Sixty files in fifteen minutes, per address and record. Generous for
   somebody catching up on a shoebox, and a ceiling on a loop. */
const uploadLimit = rateLimit(60, 15 * 60 * 1000);

const upload = [requireAuth, requireWriteAccess, uploadLimit, fileBody] as const;

receiptsRouter.post('/entries/:id/attachments', ...upload, async (req, res, next) => {
  try {
    const receipt = await receipts.attachToEntry(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      param(req, 'id')!,
      req.body as Buffer,
      fileName(req),
    );
    res.status(201).json({ receipt });
  } catch (err) {
    next(err);
  }
});

receiptsRouter.post('/invoices/:id/attachments', ...upload, async (req, res, next) => {
  try {
    const receipt = await receipts.attachToInvoice(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      param(req, 'id')!,
      req.body as Buffer,
      fileName(req),
    );
    res.status(201).json({ receipt });
  } catch (err) {
    next(err);
  }
});

const listQuery = z.object({
  on: z.enum(['all', 'EXPENSE', 'INCOME', 'DRAWING', 'INVOICE']).default('all'),
  fileType: z.enum(['all', 'pdf', 'img']).default('all'),
  search: z.string().trim().max(100).optional().transform((s) => s || undefined),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(24),
});

receiptsRouter.get('/receipts', requireAuth, async (req, res, next) => {
  try {
    res.json(await receipts.list(req.auth!.businessId, listQuery.parse(req.query)));
  } catch (err) {
    next(err);
  }
});

/* A five minute link to look at the file. */
receiptsRouter.get('/attachments/:id/view', requireAuth, async (req, res, next) => {
  try {
    res.json(await receipts.viewLink(req.auth!.businessId, param(req, 'id')!));
  } catch (err) {
    next(err);
  }
});

/* The file itself, to save. Through the API rather than the signed link,
   because a link to another origin cannot be told to save instead of show. */
receiptsRouter.get('/attachments/:id/download', requireAuth, async (req, res, next) => {
  try {
    const file = await receipts.download(req.auth!.businessId, param(req, 'id')!);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', disposition('attachment', file.fileName));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.bytes);
  } catch (err) {
    next(err);
  }
});

receiptsRouter.delete('/attachments/:id', requireAuth, requireWriteAccess, async (req, res, next) => {
  try {
    await receipts.remove(
      { businessId: req.auth!.businessId, userId: req.auth!.userId },
      param(req, 'id')!,
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
