import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { taxFor, provinceList } from '../../lib/tax.js';
import { DRAWINGS_CATEGORY } from '../../lib/defaults.js';
import {
  cleanFileName,
  deleteObject,
  keyFor,
  putObject,
  signedUrl,
  sniff,
  sniffSvg,
  storageConfigured,
} from '../../lib/storage.js';
import type { Business } from '../../generated/prisma/client.js';

/* Settings.

   This is the screen every other screen quotes. Where an invoice says "comes
   from your template", or an expense says "your province sets this rate", it is
   reading a value written here. Which is why it is built before the screens
   that read it: doing it the other way round means hard coding those values
   and then unpicking them.

   The rule that must survive every change below: changing a setting affects
   what happens NEXT. It never rewrites what already happened. Move from
   Ontario to Nova Scotia and every new invoice uses 14%; the ones already
   issued keep the 13% the client was actually charged, because that is what
   they paid and what the CRA has a record of. */

export const settingsView = (b: Business) => {
  const tax = taxFor(b.province);
  return {
    business: {
      id: b.id,
      name: b.name,
      legalName: b.legalName,
      businessType: b.businessType,
      businessNumber: b.businessNumber,
      gstHstNumber: b.gstHstNumber,
      gstRegistered: b.gstRegistered,
      addressLine1: b.addressLine1,
      addressLine2: b.addressLine2,
      city: b.city,
      province: b.province,
      postalCode: b.postalCode,
      country: b.country,
      email: b.email,
      phone: b.phone,
      website: b.website,
      currency: b.currency,
      dateFormat: b.dateFormat,
      fyStartMonth: b.fyStartMonth,
      invoicePrefix: b.invoicePrefix,
      nextInvoiceNumber: b.nextInvoiceNumber,
      invoiceNumberPad: b.invoiceNumberPad,
      paymentTermsDays: b.paymentTermsDays,
      lateInterestBp: b.lateInterestBp,
      invoiceTerms: b.invoiceTerms,
      invoiceFooter: b.invoiceFooter,
      invoicePayTo: b.invoicePayTo,
      idleTimeoutMinutes: b.idleTimeoutMinutes,
      idleWarningSeconds: b.idleWarningSeconds,
      /* What is on file, never where. The picture itself comes from
         GET /settings/logo as a short lived link. */
      logo: b.logoKey
        ? {
            fileName: b.logoFileName ?? 'logo',
            contentType: b.logoContentType ?? 'image/png',
            sizeBytes: b.logoSizeBytes ?? 0,
            uploadedAt: b.logoUploadedAt?.toISOString() ?? null,
          }
        : null,
    },
    /* The rate that follows from the province, sent with the settings rather
       than looked up in the browser. One table, in the API, so the web app and
       the phone apps cannot disagree about what Ontario charges. */
    tax,
    provinces: provinceList().map((p) => ({
      code: p.code,
      name: p.name,
      label: p.label,
      note: p.note,
    })),
  };
};

export async function getSettings(businessId: string) {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  return settingsView(business);
}

/* ------------------------------------------------------------------ logo --- */

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export async function logoLink(businessId: string) {
  const b = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { logoKey: true },
  });
  return { url: b.logoKey && storageConfigured() ? await signedUrl(b.logoKey) : null };
}

/* An old logo is removed from storage only when no invoice was printed with
   it. An issued invoice is a document, and a new logo must not reprint it. */
async function retireLogo(key: string | null): Promise<void> {
  if (!key) return;
  const printed = await prisma.invoice.count({ where: { sellerLogoKey: key } });
  if (!printed) await deleteObject(key).catch(() => undefined);
}

export async function setLogo(businessId: string, bytes: Buffer, rawName: string | undefined) {
  if (!storageConfigured()) {
    throw new ApiError(503, 'Document storage is not switched on yet.', 'storage_unconfigured');
  }
  if (bytes.length === 0) throw new ApiError(400, 'That file is empty.', 'empty_file');
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new ApiError(413, 'A logo can be up to 2 MB.', 'file_too_large');
  }

  const sniffed = sniff(bytes);
  const kind =
    sniffed && (sniffed.ext === 'png' || sniffed.ext === 'jpg') ? sniffed : sniffSvg(bytes);
  if (!kind) {
    throw new ApiError(415, 'A logo can be a PNG, a JPG or an SVG.', 'unsupported_file');
  }

  const before = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { logoKey: true },
  });

  const fileName = cleanFileName(rawName, kind.ext, 'logo');
  const key = keyFor(businessId, 'logos', kind.ext);
  await putObject(key, bytes, { contentType: kind.contentType, fileName });

  const business = await prisma.business.update({
    where: { id: businessId },
    data: {
      logoKey: key,
      logoFileName: fileName,
      logoContentType: kind.contentType,
      logoSizeBytes: bytes.length,
      logoUploadedAt: new Date(),
    },
  });

  await retireLogo(before.logoKey);
  return settingsView(business);
}

export async function removeLogo(businessId: string) {
  const before = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { logoKey: true },
  });
  const business = await prisma.business.update({
    where: { id: businessId },
    data: {
      logoKey: null,
      logoFileName: null,
      logoContentType: null,
      logoSizeBytes: null,
      logoUploadedAt: null,
    },
  });
  await retireLogo(before.logoKey);
  return settingsView(business);
}

type ProfileInput = {
  legalName: string;
  name?: string;
  businessType: 'SOLE_PROPRIETOR' | 'PARTNERSHIP' | 'CORPORATION' | 'CONTRACTOR';
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  businessNumber: string | null;
};

export async function updateProfile(businessId: string, input: ProfileInput) {
  const business = await prisma.business.update({
    where: { id: businessId },
    data: {
      legalName: input.legalName,
      /* Trading name is optional. Left blank, the business trades under its
         legal name, and `name` is what appears everywhere in the interface. */
      name: input.name?.trim() || input.legalName,
      businessType: input.businessType,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      postalCode: input.postalCode,
      email: input.email,
      phone: input.phone,
      website: input.website,
      businessNumber: input.businessNumber,
    },
  });
  return settingsView(business);
}

type TaxInput = {
  province: string;
  currency: 'CAD' | 'USD' | 'PKR';
  dateFormat: 'YYYY/MM/DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';
  fyStartMonth: number;
  gstRegistered: boolean;
  gstHstNumber: string | null;
};

export async function updateTax(businessId: string, input: TaxInput) {
  const business = await prisma.business.update({
    where: { id: businessId },
    data: {
      province: input.province,
      currency: input.currency,
      dateFormat: input.dateFormat,
      fyStartMonth: input.fyStartMonth,
      gstRegistered: input.gstRegistered,
      /* Cleared when they deregister, so a stale number cannot reappear on an
         invoice after they have stopped charging tax. */
      gstHstNumber: input.gstRegistered ? input.gstHstNumber : null,
    },
  });
  return settingsView(business);
}

type InvoiceInput = {
  invoicePrefix: string;
  nextInvoiceNumber: number;
  invoiceNumberPad: number;
  paymentTermsDays: number;
  lateInterestBp: number;
  invoiceTerms: string | null;
  invoiceFooter: string | null;
  invoicePayTo: string | null;
};

export async function updateInvoiceTemplate(businessId: string, input: InvoiceInput) {
  const current = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });

  /* Invoice numbers run in an unbroken sequence and are never reissued. Moving
     the counter forward is fine, and is how somebody continues a sequence they
     started in a spreadsheet. Moving it back would hand out a number that has
     already been on a document somebody else is holding.

     Today nothing has been issued yet, so this only ever fires once invoicing
     exists in Phase 6. It is written now because the check is easy to forget
     later, and by then it will be too late for whoever it happens to. */
  if (input.nextInvoiceNumber < current.nextInvoiceNumber) {
    const issued = current.nextInvoiceNumber > 1;
    if (issued) {
      throw new ApiError(
        409,
        `You have already issued invoices up to ${current.nextInvoiceNumber - 1}. The next number cannot go backwards.`,
        'number_reused',
      );
    }
  }

  const business = await prisma.business.update({
    where: { id: businessId },
    data: input,
  });
  return settingsView(business);
}

export async function updateSecurity(
  businessId: string,
  input: { idleTimeoutMinutes: number; idleWarningSeconds: number },
) {
  /* A warning longer than the timeout would put the countdown on screen from
     the moment they stop typing. Caught here as well as in the schema, because
     the schema can only check each field on its own. */
  if (input.idleWarningSeconds >= input.idleTimeoutMinutes * 60) {
    throw new ApiError(
      400,
      'The warning has to be shorter than the sign out time.',
      'warning_too_long',
    );
  }

  const business = await prisma.business.update({
    where: { id: businessId },
    data: input,
  });
  return settingsView(business);
}

/* ------------------------------------------------------------- password ----

   Two doors, one endpoint underneath.

   Someone with a password has to give the current one. Someone who signed up
   through Google has none, so there is nothing to ask for; they are setting a
   password rather than changing it. Today the only route for them is Forgot
   password, which is odd wording for a person who never had one. */
export async function changePassword(
  userId: string,
  currentPassword: string | undefined,
  newPassword: string,
  currentRefreshHash: string | null,
): Promise<{ hadPassword: boolean }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const hadPassword = Boolean(user.passwordHash);

  if (hadPassword) {
    if (!currentPassword) {
      throw new ApiError(400, 'Enter your current password.', 'current_required');
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash!))) {
      throw new ApiError(400, 'That is not your current password.', 'bad_current');
    }
    if (currentPassword === newPassword) {
      throw new ApiError(400, 'The new password has to be different.', 'same_password');
    }
  }

  const passwordHash = await hashPassword(newPassword);

  /* Every other session ends, on the web and on both phones. If the password
     was changed because somebody else knew the old one, leaving their session
     alive makes the change pointless. The browser doing the changing is left
     signed in, which is why its own refresh hash is passed in. */
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(currentRefreshHash ? { refreshTokenHash: { not: currentRefreshHash } } : {}),
      },
      data: { revokedAt: new Date() },
    }),
  ]);

  return { hadPassword };
}

export async function listSessions(userId: string, currentRefreshHash: string | null) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
  });

  return sessions.map((s) => ({
    id: s.id,
    userAgent: s.userAgent,
    ipAddress: s.ipAddress,
    lastSeenAt: s.lastSeenAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    remembered: s.remembered,
    /* Which row is the browser asking the question. Worked out from the hash
       of the cookie it sent, so the interface can label it Current and not
       offer a Sign out button that would end the session mid click. */
    current: currentRefreshHash !== null && s.refreshTokenHash === currentRefreshHash,
  }));
}

export async function revokeSession(
  userId: string,
  sessionId: string,
  currentRefreshHash: string | null,
): Promise<void> {
  const session = await prisma.session.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new ApiError(404, 'That session no longer exists.', 'not_found');

  if (currentRefreshHash && session.refreshTokenHash === currentRefreshHash) {
    throw new ApiError(
      400,
      'That is this browser. Use Sign out instead.',
      'cannot_revoke_current',
    );
  }

  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}

export async function revokeOtherSessions(
  userId: string,
  currentRefreshHash: string | null,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(currentRefreshHash ? { refreshTokenHash: { not: currentRefreshHash } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/* ----------------------------------------------------------- categories ---- */

export async function listCategories(businessId: string) {
  const categories = await prisma.category.findMany({
    where: { businessId },
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { vendors: true } } },
  });

  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    isSystem: c.isSystem,
    archived: Boolean(c.archivedAt),
    vendorCount: c._count.vendors,
  }));
}

export async function createCategory(
  businessId: string,
  input: { name: string; kind: 'INCOME' | 'EXPENSE' | 'DRAWINGS' },
) {
  /* Owner Drawings exists once and is created with the business. A second one
     would give an owner two places to file the same thing, and the reports
     that exclude drawings from profit look for the one. */
  if (input.kind === 'DRAWINGS') {
    throw new ApiError(
      400,
      `${DRAWINGS_CATEGORY} is built in. You cannot add another drawings category.`,
      'drawings_locked',
    );
  }

  try {
    const created = await prisma.category.create({
      data: { businessId, name: input.name, kind: input.kind },
    });
    return created.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'You already have a category with that name.', 'duplicate');
    }
    throw err;
  }
}

export async function updateCategory(
  businessId: string,
  id: string,
  input: { name?: string; archived?: boolean },
): Promise<void> {
  const category = await prisma.category.findFirst({ where: { id, businessId } });
  if (!category) throw new ApiError(404, 'That category no longer exists.', 'not_found');

  /* The one category that cannot be touched. Anything filed under it stays out
     of profit, out of expense reports and out of the input tax credit, so a
     rename into an ordinary expense would break all three quietly, and the
     mistake would not surface until a tax return. */
  if (category.isSystem) {
    throw new ApiError(
      403,
      `${category.name} is built in and cannot be renamed or removed.`,
      'system_category',
    );
  }

  try {
    await prisma.category.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.archived === undefined
          ? {}
          : { archivedAt: input.archived ? new Date() : null }),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'You already have a category with that name.', 'duplicate');
    }
    throw err;
  }
}

/* Archive, never delete.

   A category attached to last year's entries has to go on existing for the
   CRA's six years, long after nobody files under it. Archiving takes it out of
   the dropdowns and leaves last year's expenses carrying their labels. */
export const archiveCategory = (businessId: string, id: string) =>
  updateCategory(businessId, id, { archived: true });

/* -------------------------------------------------------------- vendors ---- */

export async function listVendors(businessId: string) {
  const vendors = await prisma.vendor.findMany({
    where: { businessId },
    orderBy: { name: 'asc' },
    include: { category: { select: { id: true, name: true } } },
  });

  return vendors.map((v) => ({
    id: v.id,
    name: v.name,
    categoryId: v.categoryId,
    categoryName: v.category?.name ?? null,
    archived: Boolean(v.archivedAt),
  }));
}

async function assertCategoryBelongs(businessId: string, categoryId: string | null) {
  if (!categoryId) return;
  const category = await prisma.category.findFirst({ where: { id: categoryId, businessId } });
  if (!category) throw new ApiError(400, 'That category does not exist.', 'bad_category');
}

export async function createVendor(
  businessId: string,
  input: { name: string; categoryId: string | null },
) {
  await assertCategoryBelongs(businessId, input.categoryId);
  try {
    const created = await prisma.vendor.create({
      data: { businessId, name: input.name, categoryId: input.categoryId },
    });
    return created.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'You already have a vendor with that name.', 'duplicate');
    }
    throw err;
  }
}

export async function updateVendor(
  businessId: string,
  id: string,
  input: { name?: string; categoryId?: string | null; archived?: boolean },
): Promise<void> {
  const vendor = await prisma.vendor.findFirst({ where: { id, businessId } });
  if (!vendor) throw new ApiError(404, 'That vendor no longer exists.', 'not_found');

  if (input.categoryId !== undefined) await assertCategoryBelongs(businessId, input.categoryId);

  try {
    await prisma.vendor.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
        ...(input.archived === undefined
          ? {}
          : { archivedAt: input.archived ? new Date() : null }),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'You already have a vendor with that name.', 'duplicate');
    }
    throw err;
  }
}
