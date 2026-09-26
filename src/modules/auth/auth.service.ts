import { prisma } from '../../lib/prisma.js';
import { hashPassword, verifyPassword, wastePasswordTime } from '../../lib/password.js';
import { newLinkToken, newRefreshToken, hashToken, signAccessToken } from '../../lib/tokens.js';
import { ApiError } from '../../middleware/error.js';
import type { SignupInput } from './auth.schemas.js';

const REFRESH_DAYS = 30;
const RESET_MINUTES = 60;

type Ctx = { userAgent?: string; ip?: string };
type Role = 'OWNER' | 'MEMBER';
type Platform = 'SUPERADMIN' | 'CUSTOMER';

/* One place builds a session, so the rules about lifetime and hashing are
   stated once. The raw token is returned to be put in a cookie and is never
   stored; only its hash reaches the database. */
async function issueSession(
  userId: string,
  businessId: string,
  role: Role,
  platformRole: Platform,
  ctx: Ctx,
) {
  const refresh = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId,
      businessId,
      refreshTokenHash: refresh.hash,
      userAgent: ctx.userAgent?.slice(0, 300),
      ipAddress: ctx.ip,
      expiresAt,
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
};

const publicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  firstName: u.firstName,
  lastName: u.lastName,
  role: u.role,
  platformRole: u.platformRole,
});

/* Signing up creates a business and its first user together. In one
   transaction, because a user with no business cannot sign in and a business
   with no user cannot be reached: either both rows exist or neither does. */
export async function signup(input: SignupInput, ctx: Ctx) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ApiError(409, 'An account already exists for that email address.', 'email_taken');
  }

  const passwordHash = await hashPassword(input.password);

  const created = await prisma.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: {
        name: input.businessName,
        legalName: input.businessName,
        province: input.province,
      },
    });
    const user = await tx.user.create({
      data: {
        businessId: business.id,
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: 'OWNER',
        platformRole: 'CUSTOMER',
      },
    });
    return { user, business };
  });

  const tokens = await issueSession(
    created.user.id,
    created.business.id,
    'OWNER',
    'CUSTOMER',
    ctx,
  );

  return {
    user: publicUser(created.user),
    business: { id: created.business.id, name: created.business.name },
    ...tokens,
  };
}

export async function login(email: string, password: string, ctx: Ctx) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { business: true },
  });

  /* Same message and roughly the same duration whether the address is unknown
     or the password is wrong. Telling those two apart is how an attacker turns
     a login form into a list of real customers. */
  if (!user || user.deletedAt) {
    await wastePasswordTime(password);
    throw new ApiError(401, 'That email or password is not right.', 'bad_credentials');
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new ApiError(401, 'That email or password is not right.', 'bad_credentials');
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const tokens = await issueSession(
    user.id,
    user.businessId,
    user.role,
    user.platformRole,
    ctx,
  );

  return {
    user: publicUser(user),
    business: { id: user.business.id, name: user.business.name },
    ...tokens,
  };
}

/* Refreshing rotates: the old token is revoked as the new one is issued, so a
   token is good for exactly one use. If a revoked token comes back, it was
   copied, and the safe answer is to end every session for that user rather
   than guess which side is the attacker. */
export async function refresh(rawToken: string, ctx: Ctx) {
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(rawToken) },
    include: { user: { include: { business: true } } },
  });

  if (!session) throw new ApiError(401, 'Please sign in again.', 'invalid_refresh');

  if (session.revokedAt) {
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new ApiError(401, 'Please sign in again.', 'refresh_reused');
  }

  if (session.expiresAt <= new Date()) {
    throw new ApiError(401, 'Please sign in again.', 'refresh_expired');
  }

  const user = session.user;

  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  const tokens = await issueSession(
    user.id,
    user.businessId,
    user.role,
    user.platformRole,
    ctx,
  );

  return {
    user: publicUser(user),
    business: { id: user.business.id, name: user.business.name },
    ...tokens,
  };
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await prisma.session.updateMany({
    where: { refreshTokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function me(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { business: true },
  });
  if (!user || user.deletedAt) {
    throw new ApiError(401, 'Please sign in again.', 'unauthenticated');
  }
  return {
    user: publicUser(user),
    business: {
      id: user.business.id,
      name: user.business.name,
      province: user.business.province,
      currency: user.business.currency,
      idleTimeoutMinutes: user.business.idleTimeoutMinutes,
      idleWarningSeconds: user.business.idleWarningSeconds,
    },
  };
}

/* Always reports success, whether or not the address exists. The screen after
   this one says "if that address is registered we have sent a link", so the
   response cannot be used to test which addresses are real. */
export async function forgotPassword(email: string): Promise<{ resetToken?: string }> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.deletedAt) return {};

  const token = newLinkToken();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetTokenHash: token.hash,
      resetTokenExpires: new Date(Date.now() + RESET_MINUTES * 60 * 1000),
    },
  });

  /* Returned so the caller can send the email. Until Resend is wired up the
     route logs it in development, and it never appears in the response. */
  return { resetToken: token.raw };
}

export async function resetPassword(rawToken: string, password: string): Promise<void> {
  const user = await prisma.user.findFirst({
    where: {
      resetTokenHash: hashToken(rawToken),
      resetTokenExpires: { gt: new Date() },
      deletedAt: null,
    },
  });

  if (!user) {
    throw new ApiError(400, 'This reset link has expired or has already been used.', 'bad_token');
  }

  const passwordHash = await hashPassword(password);

  /* Setting a new password ends every other session. If the reset happened
     because someone else knew the old password, leaving their session alive
     would make the reset pointless. */
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetTokenHash: null, resetTokenExpires: null },
    }),
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
