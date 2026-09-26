import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { hashPassword } from '../../lib/password.js';
import { hashToken, newLinkToken } from '../../lib/tokens.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { MAX_EXTRA_SEATS } from '../../lib/plans.js';
import { issueSession, publicBusiness, publicUser, sessionAccess, type Ctx } from '../auth/session.js';

/* The people on one account.

   The rules the client set, and where each one is enforced:

     an owner plus at most two other people   the seat check below
     the owner can remove either of them      requireOwner on the route
     they cannot remove the owner             the guard in removeMember
     nobody is emailed a password             invites carry a link, not a secret

   That last one is the one part of the call worth pushing back on, and the
   reason is not theoretical. A password sent by email sits in that inbox in
   plain text for as long as the account exists, so anyone who ever reaches
   that mailbox reaches the books. The invite link gives the owner an identical
   experience, they still just type an email address, and nothing reusable is
   ever sent. */

const INVITE_DAYS = 7;

export async function listTeam(businessId: string) {
  const [users, invites, sub] = await Promise.all([
    prisma.user.findMany({
      where: { businessId, deletedAt: null },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.invite.findMany({
      where: { businessId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.subscription.findUnique({ where: { businessId } }),
  ]);

  const now = new Date();

  return {
    members: users.map((u) => ({
      ...publicUser(u),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      /* Whether they have ever finished setting up. A Google account has no
         password and is still complete, so both routes count. */
      signInMethod: u.googleId ? 'google' : u.passwordHash ? 'password' : 'pending',
    })),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      expiresAt: i.expiresAt.toISOString(),
      expired: i.expiresAt <= now,
      createdAt: i.createdAt.toISOString(),
    })),
    /* Seats paid for against seats taken. An invite that has not been accepted
       still holds a seat, or two people invited at once would both get in and
       the third would be a surprise on the bill. */
    seatsPaid: sub?.extraSeats ?? 0,
    seatsUsed: users.filter((u) => u.role === 'MEMBER').length + invites.filter((i) => i.expiresAt > now).length,
    maxExtraSeats: MAX_EXTRA_SEATS,
  };
}

export async function invite(
  businessId: string,
  invitedById: string,
  email: string,
): Promise<{ inviteToken: string; businessName: string; invitedByName: string }> {
  const [existingUser, sub, memberCount, pending] = await Promise.all([
    prisma.user.findUnique({ where: { email } }),
    prisma.subscription.findUnique({ where: { businessId } }),
    prisma.user.count({ where: { businessId, role: 'MEMBER', deletedAt: null } }),
    /* Everyone with a live invitation EXCEPT this address. Resending someone
       their link replaces it rather than taking a second seat, and without
       the exclusion the owner is told they have no spare seats by the very
       invitation they are trying to resend. */
    prisma.invite.count({
      where: {
        businessId,
        email: { not: email },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);

  if (existingUser) {
    /* Two different problems with two different answers. Someone already on
       this account is a no-op the owner should be told about; someone on a
       different account cannot be moved, because their books are not ours to
       reassign. */
    throw new ApiError(
      409,
      existingUser.businessId === businessId
        ? 'That person is already on this account.'
        : 'That email address already has a Variantage account.',
      'email_taken',
    );
  }

  const seats = sub?.extraSeats ?? 0;
  const used = memberCount + pending;

  if (used >= MAX_EXTRA_SEATS) {
    throw new ApiError(
      409,
      `An account can have you plus ${MAX_EXTRA_SEATS} other people, and both places are taken.`,
      'seat_limit',
    );
  }
  if (used >= seats) {
    throw new ApiError(
      409,
      'You have no spare seats. Add one on the billing tab first, at $5 a month once the trial ends.',
      'no_spare_seat',
    );
  }

  const token = newLinkToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000);

  /* Upsert rather than create. Inviting the same person again should replace
     their link, not leave two live ways into one set of books. */
  try {
    await prisma.invite.upsert({
      where: { businessId_email: { businessId, email } },
      create: { businessId, email, invitedById, tokenHash: token.hash, expiresAt },
      update: {
        tokenHash: token.hash,
        expiresAt,
        invitedById,
        revokedAt: null,
        acceptedAt: null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'That person has already been invited.', 'already_invited');
    }
    throw err;
  }

  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  const inviter = await prisma.user.findUniqueOrThrow({ where: { id: invitedById } });

  return {
    inviteToken: token.raw,
    businessName: business.name,
    invitedByName: `${inviter.firstName} ${inviter.lastName}`.trim(),
  };
}

export async function revokeInvite(businessId: string, inviteId: string): Promise<void> {
  /* Scoped by businessId as well as by id. An id alone would let one owner
     cancel another business's invite by guessing, which is exactly the class
     of bug multi-tenancy exists to prevent. */
  const result = await prisma.invite.updateMany({
    where: { id: inviteId, businessId, acceptedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!result.count) throw new ApiError(404, 'That invitation no longer exists.', 'not_found');
}

/* What the accept page shows before anyone types a password. Deliberately thin:
   the business name and the address it was sent to, and nothing else about the
   account, because this page is reachable by anyone holding the link. */
export async function previewInvite(rawToken: string) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { business: true },
  });

  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= new Date()) {
    throw new ApiError(
      400,
      'This invitation has expired or has already been used. Ask for a new one.',
      'bad_invite',
    );
  }

  return { email: invite.email, businessName: invite.business.name };
}

export async function acceptInvite(
  rawToken: string,
  firstName: string,
  lastName: string,
  password: string,
  ctx: Ctx,
) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { business: true },
  });

  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= new Date()) {
    throw new ApiError(
      400,
      'This invitation has expired or has already been used. Ask for a new one.',
      'bad_invite',
    );
  }

  const passwordHash = await hashPassword(password);

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          businessId: invite.businessId,
          email: invite.email,
          passwordHash,
          firstName,
          lastName,
          role: 'MEMBER',
          platformRole: 'CUSTOMER',
          /* They arrived through a link sent to that address, which is the
             same proof a verification email would give. */
          emailVerifiedAt: new Date(),
        },
      });
      /* Marked used inside the same transaction. Two people opening the link
         at once must not both get an account on the same seat. */
      await tx.invite.update({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      return user;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'That email address already has an account.', 'email_taken');
    }
    throw err;
  }

  const tokens = await issueSession(
    created.id,
    created.businessId,
    'MEMBER',
    'CUSTOMER',
    ctx,
  );

  return {
    user: publicUser(created),
    business: publicBusiness(invite.business),
    access: await sessionAccess(invite.businessId),
    ...tokens,
  };
}

export async function removeMember(
  businessId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  const target = await prisma.user.findFirst({
    where: { id: targetUserId, businessId, deletedAt: null },
  });
  if (!target) throw new ApiError(404, 'That person is not on this account.', 'not_found');

  /* The two guards the client asked for, in the order they can bite.

     The owner cannot be removed by anyone, which is what stops a member from
     taking a business away from the person paying for it. The route already
     requires an owner, so in practice this catches an owner trying to remove
     themselves, which would leave a business with nobody who can pay. */
  if (target.role === 'OWNER') {
    throw new ApiError(
      403,
      'The account owner cannot be removed. Contact us to transfer ownership.',
      'cannot_remove_owner',
    );
  }
  if (target.id === actorUserId) {
    throw new ApiError(400, 'You cannot remove yourself.', 'cannot_remove_self');
  }

  /* Soft delete, and every session ended in the same transaction. Marking the
     row without revoking the sessions would leave them signed in until their
     access token expired, which is up to fifteen minutes of a removed person
     still reading the books. */
  await prisma.$transaction([
    prisma.user.update({
      where: { id: target.id },
      data: {
        deletedAt: new Date(),
        /* Frees the address for a real account elsewhere. The row is kept for
           the audit trail; the login is not. */
        email: `removed+${target.id}@variantage.invalid`,
      },
    }),
    prisma.session.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
