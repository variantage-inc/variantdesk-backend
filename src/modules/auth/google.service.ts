import { prisma } from '../../lib/prisma.js';
import type { GoogleIdentity } from '../../lib/google.js';
import { signPendingSignup, verifyPendingSignup } from '../../lib/tokens.js';
import { ApiError } from '../../middleware/error.js';
import { issueSession, publicUser } from './session.js';

type Ctx = { userAgent?: string; ip?: string };

export type GoogleOutcome =
  | { kind: 'signed_in'; refreshToken: string }
  | { kind: 'needs_business'; pendingToken: string };

/* Three ways this can go, and the middle one is where the risk sits.

   1. We already know this Google id. Sign them in.
   2. We know the email but not the Google id. Link the two, but only if Google
      says the address is verified. Without that check, anyone able to create a
      Google account claiming an address could take over the matching
      Variantage account.
   3. Neither. They need a business before they can have an account. */
export async function signInWithGoogle(
  identity: GoogleIdentity,
  ctx: Ctx,
): Promise<GoogleOutcome> {
  const byGoogleId = await prisma.user.findUnique({ where: { googleId: identity.googleId } });

  if (byGoogleId && !byGoogleId.deletedAt) {
    const session = await issueSession(
      byGoogleId.id,
      byGoogleId.businessId,
      byGoogleId.role,
      byGoogleId.platformRole,
      ctx,
    );
    await prisma.user.update({
      where: { id: byGoogleId.id },
      data: { lastLoginAt: new Date() },
    });
    return { kind: 'signed_in', refreshToken: session.refreshToken };
  }

  const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });

  if (byEmail && !byEmail.deletedAt) {
    if (!identity.emailVerified) {
      throw new ApiError(
        403,
        'Google has not verified that email address, so we cannot link it to an existing account.',
        'email_unverified',
      );
    }
    const linked = await prisma.user.update({
      where: { id: byEmail.id },
      data: {
        googleId: identity.googleId,
        avatarUrl: identity.avatarUrl ?? byEmail.avatarUrl,
        lastLoginAt: new Date(),
      },
    });
    const session = await issueSession(
      linked.id,
      linked.businessId,
      linked.role,
      linked.platformRole,
      ctx,
    );
    return { kind: 'signed_in', refreshToken: session.refreshToken };
  }

  return {
    kind: 'needs_business',
    pendingToken: signPendingSignup({
      googleId: identity.googleId,
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
      avatarUrl: identity.avatarUrl,
    }),
  };
}

/* The second half of a Google signup, once we know the business. */
export async function completeGoogleSignup(
  pendingToken: string,
  businessName: string,
  province: string,
  ctx: Ctx,
) {
  const pending = verifyPendingSignup(pendingToken);
  if (!pending) {
    throw new ApiError(400, 'That sign up link has expired. Start again.', 'pending_expired');
  }

  /* Between the redirect and this call, someone could have signed up with the
     same address the ordinary way. Check again rather than trusting the token. */
  const taken = await prisma.user.findFirst({
    where: { OR: [{ email: pending.email }, { googleId: pending.googleId }] },
  });
  if (taken) {
    throw new ApiError(409, 'An account already exists for that email address.', 'email_taken');
  }

  const created = await prisma.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: { name: businessName, legalName: businessName, province },
    });
    const user = await tx.user.create({
      data: {
        businessId: business.id,
        email: pending.email,
        googleId: pending.googleId,
        avatarUrl: pending.avatarUrl,
        firstName: pending.firstName,
        lastName: pending.lastName,
        role: 'OWNER',
        platformRole: 'CUSTOMER',
        /* Google vouched for the address, so there is nothing left to verify. */
        emailVerifiedAt: new Date(),
      },
    });
    return { user, business };
  });

  const session = await issueSession(
    created.user.id,
    created.business.id,
    'OWNER',
    'CUSTOMER',
    ctx,
  );

  return {
    user: publicUser(created.user),
    business: { id: created.business.id, name: created.business.name },
    ...session,
  };
}
