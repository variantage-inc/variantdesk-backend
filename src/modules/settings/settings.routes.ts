import { Router } from 'express';
import type { Request } from 'express';
import { REFRESH_COOKIE } from '../../lib/cookies.js';
import { param } from '../../lib/params.js';
import { hashToken } from '../../lib/tokens.js';
import { requireAuth, requireOwner } from '../../middleware/requireAuth.js';
import { requireWriteAccess } from '../../middleware/requireWriteAccess.js';
import { validate } from '../../middleware/validate.js';
import * as settings from './settings.service.js';
import {
  businessProfileSchema,
  categorySchema,
  categoryUpdateSchema,
  changePasswordSchema,
  invoiceTemplateSchema,
  securitySchema,
  taxSchema,
  vendorSchema,
  vendorUpdateSchema,
} from './settings.schemas.js';

export const settingsRouter: Router = Router();

/* Who may change what.

   Reads are open to anyone signed in, because a member has to know the tax
   rate and the categories to record anything at all.

   Writes to the business itself are owner only. A member entering expenses has
   no business changing the GST registration number that prints on every
   invoice.

   Security is the exception in the other direction: it is about the person,
   not the business, so a member changes their own password. The idle timeout
   is a business setting, so that half is owner only.

   requireWriteAccess sits on the business writes and not on security. When a
   trial ends the account goes read only, and somebody must still be able to
   change their own password and see where they are signed in. */

const currentRefreshHash = (req: Request): string | null => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  return typeof raw === 'string' ? hashToken(raw) : null;
};

settingsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await settings.getSettings(req.auth!.businessId));
  } catch (err) {
    next(err);
  }
});

const ownerWrite = [requireAuth, requireOwner, requireWriteAccess] as const;

settingsRouter.put(
  '/business',
  ...ownerWrite,
  validate(businessProfileSchema),
  async (req, res, next) => {
    try {
      res.json(await settings.updateProfile(req.auth!.businessId, req.body));
    } catch (err) {
      next(err);
    }
  },
);

settingsRouter.put('/tax', ...ownerWrite, validate(taxSchema), async (req, res, next) => {
  try {
    res.json(await settings.updateTax(req.auth!.businessId, req.body));
  } catch (err) {
    next(err);
  }
});

settingsRouter.put(
  '/invoice',
  ...ownerWrite,
  validate(invoiceTemplateSchema),
  async (req, res, next) => {
    try {
      res.json(await settings.updateInvoiceTemplate(req.auth!.businessId, req.body));
    } catch (err) {
      next(err);
    }
  },
);

/* Not behind requireWriteAccess. Signing out sooner is a security setting, and
   a read only account should still be able to tighten it. */
settingsRouter.put(
  '/security',
  requireAuth,
  requireOwner,
  validate(securitySchema),
  async (req, res, next) => {
    try {
      res.json(await settings.updateSecurity(req.auth!.businessId, req.body));
    } catch (err) {
      next(err);
    }
  },
);

/* --------------------------------------------------------------- account -- */

settingsRouter.post(
  '/password',
  requireAuth,
  validate(changePasswordSchema),
  async (req, res, next) => {
    try {
      const result = await settings.changePassword(
        req.auth!.userId,
        req.body.currentPassword,
        req.body.password,
        currentRefreshHash(req),
      );
      res.json({
        ok: true,
        message: result.hadPassword
          ? 'Your password has been changed. Everywhere else has been signed out.'
          : 'Your password is set. You can now sign in with it as well as with Google.',
      });
    } catch (err) {
      next(err);
    }
  },
);

settingsRouter.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    res.json({ sessions: await settings.listSessions(req.auth!.userId, currentRefreshHash(req)) });
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    await settings.revokeSession(req.auth!.userId, param(req, 'id'), currentRefreshHash(req));
    res.json({ sessions: await settings.listSessions(req.auth!.userId, currentRefreshHash(req)) });
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete('/sessions', requireAuth, async (req, res, next) => {
  try {
    const count = await settings.revokeOtherSessions(req.auth!.userId, currentRefreshHash(req));
    res.json({
      count,
      sessions: await settings.listSessions(req.auth!.userId, currentRefreshHash(req)),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ categories -- */

settingsRouter.get('/categories', requireAuth, async (req, res, next) => {
  try {
    res.json({ categories: await settings.listCategories(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post(
  '/categories',
  ...ownerWrite,
  validate(categorySchema),
  async (req, res, next) => {
    try {
      await settings.createCategory(req.auth!.businessId, req.body);
      res.status(201).json({ categories: await settings.listCategories(req.auth!.businessId) });
    } catch (err) {
      next(err);
    }
  },
);

settingsRouter.patch(
  '/categories/:id',
  ...ownerWrite,
  validate(categoryUpdateSchema),
  async (req, res, next) => {
    try {
      await settings.updateCategory(req.auth!.businessId, param(req, 'id'), req.body);
      res.json({ categories: await settings.listCategories(req.auth!.businessId) });
    } catch (err) {
      next(err);
    }
  },
);

/* DELETE archives. Nothing on this screen ever removes a row, because a
   category or vendor attached to past entries has to stay readable for six
   years. The verb is DELETE because that is what the button means to the
   person pressing it. */
settingsRouter.delete('/categories/:id', ...ownerWrite, async (req, res, next) => {
  try {
    await settings.archiveCategory(req.auth!.businessId, param(req, 'id'));
    res.json({ categories: await settings.listCategories(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- vendors -- */

settingsRouter.get('/vendors', requireAuth, async (req, res, next) => {
  try {
    res.json({ vendors: await settings.listVendors(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});

/* Vendors are added while recording an expense, not only from Settings, so
   this one is open to any member with write access rather than to the owner
   alone. Blocking it would mean a member could not finish entering a bill. */
const memberWrite = [requireAuth, requireWriteAccess] as const;

settingsRouter.post('/vendors', ...memberWrite, validate(vendorSchema), async (req, res, next) => {
  try {
    await settings.createVendor(req.auth!.businessId, req.body);
    res.status(201).json({ vendors: await settings.listVendors(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});

settingsRouter.patch(
  '/vendors/:id',
  ...memberWrite,
  validate(vendorUpdateSchema),
  async (req, res, next) => {
    try {
      await settings.updateVendor(req.auth!.businessId, param(req, 'id'), req.body);
      res.json({ vendors: await settings.listVendors(req.auth!.businessId) });
    } catch (err) {
      next(err);
    }
  },
);

settingsRouter.delete('/vendors/:id', ...memberWrite, async (req, res, next) => {
  try {
    await settings.updateVendor(req.auth!.businessId, param(req, 'id'), { archived: true });
    res.json({ vendors: await settings.listVendors(req.auth!.businessId) });
  } catch (err) {
    next(err);
  }
});
