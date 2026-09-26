import { prisma } from '../../lib/prisma.js';
import { newRefreshToken, signAccessToken } from '../../lib/tokens.js';

export type Role = 'OWNER' | 'MEMBER';
export type Platform = 'SUPERADMIN' | 'CUSTOMER';
export type Ctx = { userAgent?: string; ip?: string };

const REFRESH_DAYS = 30;

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
): Promise<{ accessToken: string; refreshToken: string }> {
  const refresh = newRefreshToken();

  await prisma.session.create({
    data: {
      userId,
      businessId,
      refreshTokenHash: refresh.hash,
      userAgent: ctx.userAgent?.slice(0, 300),
      ipAddress: ctx.ip,
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  return {
    accessToken: signAccessToken({ userId, businessId, role, platformRole }),
    refreshToken: refresh.raw,
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
});
