import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/requireAuth.js';
import { derive } from './derive.js';

export const reportingRouter: Router = Router();

/* The dashboard, and in Phase 9 the reports, both read from here.

   Reading is open to anyone signed in, including a read only account whose
   trial has ended: they keep every screen and every export, which is the whole
   point of read only rather than locked out. */

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
