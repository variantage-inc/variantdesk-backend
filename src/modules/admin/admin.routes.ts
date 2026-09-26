import { Router } from 'express';
import { param, query } from '../../lib/params.js';
import { requireAuth, requireSuperadmin } from '../../middleware/requireAuth.js';
import * as admin from './admin.service.js';

export const adminRouter: Router = Router();

/* Variantage staff only.

   requireSuperadmin answers 404 rather than 403 on purpose. A 403 confirms
   that the route exists, which tells a curious customer there is an admin API
   worth attacking. As far as anyone without the platform role is concerned,
   none of this is here.

   Every handler writes an audit row before answering. The audit is not a
   feature of the panel; it is the price of bypassing tenancy, and the two are
   written in the same place so one cannot be added without the other. */

const guard = [requireAuth, requireSuperadmin] as const;

adminRouter.get('/metrics', ...guard, async (req, res, next) => {
  try {
    await admin.audit(req.auth!.userId, 'admin.metrics', undefined, undefined, req.ip);
    res.json(await admin.metrics());
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/businesses', ...guard, async (req, res, next) => {
  try {
    const search = query(req, 'q', 80);
    await admin.audit(req.auth!.userId, 'admin.businesses.list', undefined, search, req.ip);
    res.json({ businesses: await admin.listBusinesses(search) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/businesses/:id', ...guard, async (req, res, next) => {
  try {
    /* The one that matters most in the log: a named member of staff opened a
       named customer's account on a given day. */
    await admin.audit(req.auth!.userId, 'admin.business.read', param(req, 'id'), undefined, req.ip);
    res.json(await admin.businessDetail(param(req, 'id')));
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/payments', ...guard, async (req, res, next) => {
  try {
    await admin.audit(req.auth!.userId, 'admin.payments.list', undefined, undefined, req.ip);
    res.json({ payments: await admin.recentPayments() });
  } catch (err) {
    next(err);
  }
});

/* The log reads itself, which is the point: staff can see who else has been
   looking at what. It is not audited in turn, or the table would fill with
   rows about people reading the table. */
adminRouter.get('/audit', ...guard, async (_req, res, next) => {
  try {
    res.json({ entries: await admin.auditTrail() });
  } catch (err) {
    next(err);
  }
});
