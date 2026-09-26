import { Router } from 'express';
import { z } from 'zod';
import { email, password, personName } from '../../lib/validation.js';
import { inviteUrlFor, sendMemberInvite } from '../../lib/email.js';
import { setRefreshCookie } from '../../lib/cookies.js';
import { param } from '../../lib/params.js';
import { isDev } from '../../lib/env.js';
import { requireAuth, requireOwner } from '../../middleware/requireAuth.js';
import { requireWriteAccess } from '../../middleware/requireWriteAccess.js';
import { validate } from '../../middleware/validate.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import * as team from './team.service.js';

export const teamRouter: Router = Router();

const ctx = (req: { headers: Record<string, unknown>; ip?: string }) => ({
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  ip: req.ip,
});

/* ---------------------------------------------------------------- public --

   Accepting an invitation happens before there is an account, so these two are
   unauthenticated by necessity. The token in the URL is the credential, which
   is why it is single use, expires in seven days and is stored hashed. */

const inviteLimit = rateLimit(20, 60 * 60 * 1000);

teamRouter.get('/invites/:token', inviteLimit, async (req, res, next) => {
  try {
    res.json(await team.previewInvite(param(req, 'token')));
  } catch (err) {
    next(err);
  }
});

const acceptSchema = z.object({
  firstName: personName('first name'),
  lastName: personName('last name'),
  password,
});

teamRouter.post(
  '/invites/:token/accept',
  inviteLimit,
  validate(acceptSchema),
  async (req, res, next) => {
    try {
      const result = await team.acceptInvite(
        param(req, 'token'),
        req.body.firstName,
        req.body.lastName,
        req.body.password,
        ctx(req),
      );
      setRefreshCookie(res, result.refreshToken, true);
      res.status(201).json({
        accessToken: result.accessToken,
        user: result.user,
        business: result.business,
        access: result.access,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------------------- internal -- */

/* A member may see who else is on the account. Only the owner may change it. */
teamRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await team.listTeam(req.auth!.businessId));
  } catch (err) {
    next(err);
  }
});

teamRouter.post(
  '/invites',
  requireAuth,
  requireOwner,
  requireWriteAccess,
  validate(z.object({ email })),
  async (req, res, next) => {
    try {
      const result = await team.invite(req.auth!.businessId, req.auth!.userId, req.body.email);

      /* A failed email never fails this request: the invite exists either
         way. But the owner is told, and given the link to pass on themselves,
         rather than being told it was sent when it was not. The link goes only
         to the owner who just created it, and only when the email did not go. */
      const emailed = await sendMemberInvite(
        req.body.email,
        result.inviteToken,
        result.businessName,
        result.invitedByName,
      );
      if (isDev) console.log(`[dev] invite token for ${req.body.email}: ${result.inviteToken}`);

      res.status(201).json({
        ok: true,
        emailed,
        inviteUrl: emailed ? null : inviteUrlFor(result.inviteToken),
        team: await team.listTeam(req.auth!.businessId),
      });
    } catch (err) {
      next(err);
    }
  },
);

teamRouter.delete('/invites/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    await team.revokeInvite(req.auth!.businessId, param(req, 'id'));
    res.json({ ok: true, team: await team.listTeam(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});

teamRouter.delete('/members/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    await team.removeMember(req.auth!.businessId, req.auth!.userId, param(req, 'id'));
    res.json({ ok: true, team: await team.listTeam(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});
