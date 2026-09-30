import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { monthlyTotalCents, PLANS } from '../../lib/plans.js';
import { accessFrom } from '../billing/access.js';
import { STAFF_BUSINESS_ID } from '../../lib/staff.js';

/* The Variantage side of the product.

   Read only, deliberately. The first version answers "who is on the system,
   what are they paying, and what has failed" and does not let staff change a
   customer's books. Adding a write here later means adding it to the audit log
   in the same commit.

   Every read crosses a tenant boundary, which makes this the one place in the
   codebase where businessId scoping is bypassed on purpose. That is why each
   function takes an actor and records what it did. If this file ever stops
   writing audit rows, the guarantee the rest of the schema makes about tenancy
   stops being checkable. */

export async function audit(
  actorUserId: string,
  action: string,
  businessId?: string,
  detail?: string,
  ipAddress?: string,
): Promise<void> {
  await prisma.adminAudit.create({
    data: { actorUserId, action, businessId, detail, ipAddress },
  });
}

/* The four figures at the top of the panel.

   Monthly revenue counts only accounts that are actually being billed. Trials
   and cancelled accounts are excluded, because counting a trial as revenue is
   how a dashboard talks a company into believing it is twice its real size. */
export async function metrics() {
  const [subs, businesses, users, payments] = await Promise.all([
    /* The staff business is not a customer, so it is not counted as one. */
    prisma.subscription.findMany({ where: { businessId: { not: STAFF_BUSINESS_ID } } }),
    prisma.business.count({ where: { deletedAt: null, id: { not: STAFF_BUSINESS_ID } } }),
    prisma.user.count({ where: { deletedAt: null, businessId: { not: STAFF_BUSINESS_ID } } }),
    prisma.payment.findMany({
      where: { createdAt: { gte: startOfMonth() } },
    }),
  ]);

  const billing = subs.filter((s) => s.status === 'ACTIVE' || s.status === 'PAST_DUE');
  const monthlyCents = billing.reduce((sum, s) => sum + monthlyTotalCents(s.plan, s.extraSeats), 0);

  const now = new Date();
  const trialing = subs.filter(
    (s) => s.status === 'TRIALING' && s.trialEndsAt !== null && s.trialEndsAt > now,
  );

  return {
    businesses,
    users,
    trialing: trialing.length,
    paying: subs.filter((s) => s.status === 'ACTIVE').length,
    pastDue: subs.filter((s) => s.status === 'PAST_DUE' || s.status === 'UNPAID').length,
    cancelled: subs.filter((s) => s.status === 'CANCELED').length,
    /* What the system bills a month if nothing changes. */
    monthlyCents,
    seatsPaid: billing.reduce((sum, s) => sum + s.extraSeats, 0),
    collectedThisMonthCents: payments
      .filter((p) => p.status === 'PAID')
      .reduce((sum, p) => sum + p.amountCents, 0),
    failedThisMonth: payments.filter((p) => p.status === 'FAILED').length,
    byPlan: Object.entries(PLANS).map(([id, p]) => ({
      id,
      name: p.name,
      count: billing.filter((s) => s.plan === id).length,
    })),
  };
}

const startOfMonth = (): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

export async function listBusinesses(search: string | undefined) {
  const businesses = await prisma.business.findMany({
    where: {
      deletedAt: null,
      id: { not: STAFF_BUSINESS_ID },
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { legalName: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    include: {
      subscription: true,
      users: {
        where: { deletedAt: null },
        select: { id: true, email: true, firstName: true, lastName: true, role: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return businesses.map((b) => {
    const access = accessFrom(b.subscription);
    const owner = b.users.find((u) => u.role === 'OWNER');
    return {
      id: b.id,
      name: b.name,
      province: b.province,
      createdAt: b.createdAt.toISOString(),
      ownerName: owner ? `${owner.firstName} ${owner.lastName}`.trim() : null,
      ownerEmail: owner?.email ?? null,
      plan: access.plan,
      planName: access.planName,
      state: access.state,
      status: access.status,
      seatsUsed: b.users.filter((u) => u.role === 'MEMBER').length,
      seatsPaid: access.extraSeats,
      trialEndsAt: access.trialEndsAt,
      /* Zero for a trial, on purpose. Revenue is what is being billed, not
         what might one day be billed. */
      monthlyCents: access.state === 'active' || access.state === 'past_due' ? access.monthlyCents : 0,
    };
  });
}

export async function businessDetail(businessId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId },
    include: {
      subscription: true,
      users: { where: { deletedAt: null }, orderBy: { role: 'asc' } },
      payments: { orderBy: { createdAt: 'desc' }, take: 24 },
      invites: { where: { acceptedAt: null, revokedAt: null } },
    },
  });
  if (!business) throw new ApiError(404, 'No such business.', 'not_found');

  const access = accessFrom(business.subscription);

  return {
    business: {
      id: business.id,
      name: business.name,
      legalName: business.legalName,
      province: business.province,
      currency: business.currency,
      gstRegistered: business.gstRegistered,
      createdAt: business.createdAt.toISOString(),
    },
    access,
    /* Deliberately not the whole user row. Staff need to know who is on an
       account and how to reach them, not everything the database holds about
       them, and password hashes and reset tokens never leave the API. */
    members: business.users.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim(),
      email: u.email,
      role: u.role,
      signInMethod: u.googleId ? 'google' : 'password',
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    })),
    pendingInvites: business.invites.map((i) => ({
      email: i.email,
      expiresAt: i.expiresAt.toISOString(),
    })),
    payments: business.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      description: p.description,
      paidAt: p.paidAt?.toISOString() ?? null,
      failureReason: p.failureReason,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

export async function recentPayments() {
  const payments = await prisma.payment.findMany({
    orderBy: { createdAt: 'desc' },
    take: 60,
    include: { business: { select: { id: true, name: true } } },
  });

  return payments.map((p) => ({
    id: p.id,
    businessId: p.business.id,
    businessName: p.business.name,
    amountCents: p.amountCents,
    currency: p.currency,
    status: p.status,
    description: p.description,
    paidAt: p.paidAt?.toISOString() ?? null,
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
  }));
}

export async function auditTrail() {
  const rows = await prisma.adminAudit.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  const actors = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.actorUserId))] } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  const byId = new Map(actors.map((a) => [a.id, a]));

  return rows.map((r) => {
    const actor = byId.get(r.actorUserId);
    return {
      id: r.id,
      actor: actor ? `${actor.firstName} ${actor.lastName}`.trim() || actor.email : r.actorUserId,
      action: r.action,
      businessId: r.businessId,
      detail: r.detail,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
