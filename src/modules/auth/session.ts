import { prisma } from '../../lib/prisma.js';
import { newRefreshToken, signAccessToken } from '../../lib/tokens.js';
import { accessFrom, type Access } from '../billing/access.js';

export type Role = 'OWNER' | 'MEMBER';
export type Platform = 'SUPERADMIN' | 'CUSTOMER';
export type Ctx = { userAgent?: string; ip?: string };

/* Two lifetimes, and the difference is the point of the checkbox.

   Remembered: a month, in a cookie that survives the browser closing.
   Not remembered: a day, in a session cookie that dies with the window. That
   is what someone on a shared or public machine is asking for when they
   untick it. */
const REMEMBERED_DAYS = 30;
const SESSION_DAYS = 1;

/* One place builds a session, whether the user arrived by password or by
   Google, so the rules about lifetime and hashing are stated once and cannot
   drift apart. The raw token is returned to be put in a cookie and is never
   stored; only its hash reaches the database. */
export async function issueSession(
  userId: string,
  businessId: string,
  role: Role,
  platformRole: Platform,
  ctx: Ctx,
  remembered = true,
): Promise<{ accessToken: string; refreshToken: string; remembered: boolean }> {
  const refresh = newRefreshToken();
  const days = remembered ? REMEMBERED_DAYS : SESSION_DAYS;

  await prisma.session.create({
    data: {
      userId,
      businessId,
      refreshTokenHash: refresh.hash,
      userAgent: ctx.userAgent?.slice(0, 300),
      ipAddress: ctx.ip,
      remembered,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    },
  });

  return {
    accessToken: signAccessToken({ userId, businessId, role, platformRole }),
    refreshToken: refresh.raw,
    remembered,
  };
}

type UserRow = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  platformRole: Platform;
  avatarUrl?: string | null;
  passwordHash?: string | null;
  googleId?: string | null;
};

/* What a user looks like to the client. Nothing else about the row leaves the
   API: no password hash, no reset token, no internal flags. */
export const publicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  firstName: u.firstName,
  lastName: u.lastName,
  role: u.role,
  platformRole: u.platformRole,
  avatarUrl: u.avatarUrl ?? null,
  /* Whether each way in exists, never the credential itself. Settings needs
     this to decide between "change your password" and "set a password", which
     is not the same question for somebody who arrived through Google and has
     never had one. The hash itself does not leave the API. */
  hasPassword: Boolean(u.passwordHash),
  hasGoogle: Boolean(u.googleId),
});

type BusinessRow = {
  id: string;
  name: string;
  province: string;
  currency: string;
  idleTimeoutMinutes: number;
  idleWarningSeconds: number;
};

/* What a business looks like to the client.

   The idle timeout values travel with every session, not just with /me, because
   the browser has to start counting the moment someone signs in. They are
   settings, not secrets. */
export const publicBusiness = (b: BusinessRow) => ({
  id: b.id,
  name: b.name,
  province: b.province,
  currency: b.currency,
  idleTimeoutMinutes: b.idleTimeoutMinutes,
  idleWarningSeconds: b.idleWarningSeconds,
});

/* Whether this business may write to its books, sent with every session
   response rather than fetched separately.

   It costs one indexed lookup on a table with one row per business, and it
   means the app shell can render the read only banner on the first paint. The
   alternative, a second request after sign in, shows the customer a working
   interface for a moment before telling them it is not.

   This is a courtesy to the interface. The API checks the same thing again on
   every write, in requireWriteAccess, because anything decided in a browser
   can be edited in a browser. */
export const sessionAccess = async (businessId: string): Promise<Access> =>
  accessFrom(await prisma.subscription.findUnique({ where: { businessId } }));
