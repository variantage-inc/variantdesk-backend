import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/requireAuth.js';
import { param } from '../../lib/params.js';
import { ApiError } from '../../middleware/error.js';
import { derive } from './derive.js';
import { buildReport, fileNameFor, isReportId, REPORTS } from './reports.js';
import { renderPdf } from './pdf.js';
import { renderXlsx } from './xlsx.js';

export const reportingRouter: Router = Router();

/* The dashboard and the seven reports, both from derive.ts.

   Reading is open to anyone signed in, including a read only account whose
   trial has ended: they keep every screen and every export, which is the whole
   point of read only rather than locked out. Export especially. A customer who
   cannot get their books out of a product they have stopped paying for is a
   customer who tells other people so. */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

/* The range is decided in the browser, where the period buttons are, and sent
   as two dates. The API does not need to know what "this quarter" means; it
   needs to know which days. That keeps one definition of a quarter, in the
   place that draws the control. */
const querySchema = z.object({
  from: isoDate,
  to: isoDate,
});

reportingRouter.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const { from, to } = querySchema.parse(req.query);
    res.json(await derive(req.auth!.businessId, { from, to }));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------- the reports --- */

/* Whether to print a comparison against the period before. The customer can
   turn it off; a period that has not finished never gets one whatever this
   says, and that rule is in derive.ts rather than here. */
const reportQuery = querySchema.extend({
  compare: z
    .enum(['0', '1'])
    .optional()
    .default('1')
    .transform((v) => v === '1'),
});

reportingRouter.get('/reports', requireAuth, (_req, res) => {
  res.json({ reports: REPORTS });
});

/* One handler behind all three formats, so the file and the screen cannot be
   built from different figures. */
async function documentFor(req: Request) {
  const id = param(req, 'id');
  if (!id || !isReportId(id)) {
    throw new ApiError(404, 'There is no report by that name.', 'not_found');
  }
  const { from, to, compare } = reportQuery.parse(req.query);
  return buildReport(req.auth!.businessId, id, from, to, compare);
}

reportingRouter.get('/reports/:id', requireAuth, async (req, res, next) => {
  try {
    res.json({ report: await documentFor(req) });
  } catch (err) {
    next(err);
  }
});

reportingRouter.get('/reports/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const report = await documentFor(req);
    const file = await renderPdf(report);
    send(res, file, 'application/pdf', fileNameFor(report, 'pdf'));
  } catch (err) {
    next(err);
  }
});

reportingRouter.get('/reports/:id/xlsx', requireAuth, async (req, res, next) => {
  try {
    const report = await documentFor(req);
    const file = await renderXlsx(report);
    send(
      res,
      file,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileNameFor(report, 'xlsx'),
    );
  } catch (err) {
    next(err);
  }
});

/* The download itself.

   The name is sent in a header rather than put in the URL, because the URL is
   where a token would have to go for a plain link to work and no financial
   document should be reachable by a link somebody can copy out of a browser
   history. The browser fetches it with its access token like every other call
   and saves the blob. */
function send(res: Response, file: Buffer, type: string, name: string): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Length', String(file.length));
  /* Without this the browser cannot read the filename off a cross origin
     response, and every export would land as "download". */
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.end(file);
}
