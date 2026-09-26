import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { publicInvoice, statusOf } from './invoices.service.js';

/* Clients, and what they owe.

   Every figure on a client is DERIVED from their invoices. Nothing about a
   balance is stored on the client row, so a client's outstanding can never
   drift away from the invoices underneath it, and the sum of every client's
   outstanding is exactly what the business is owed.

   Drafts are excluded from what a client has been billed. A draft is not a
   debt they owe: it is a document nobody has sent them. Counting it would put
   money in the outstanding figure that the client has never been asked for. */

export type ClientInput = {
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  paymentTermsDays: number | null;
  notes: string | null;
};

const invoiceShape = {
  client: { select: { id: true, name: true } },
  items: { orderBy: { sortOrder: 'asc' as const } },
  payments: {
    where: { transaction: { reversal: { is: null } } },
    orderBy: { date: 'asc' as const },
    include: { createdBy: { select: { firstName: true, lastName: true } } },
  },
} satisfies Prisma.InvoiceInclude;

/* Billed, received and outstanding, from the invoices every time. */
function statsFor(invoices: ReturnType<typeof publicInvoice>[]) {
  const billable = invoices.filter((i) => i.status !== 'draft');
  const drafts = invoices.filter((i) => i.status === 'draft');

  const billedCents = billable.reduce((n, i) => n + i.totalCents, 0);
  const paidCents = billable.reduce((n, i) => n + i.paidCents, 0);

  /* How long they take to settle, from the invoices they have actually
     settled. An average over unpaid invoices would say more about how recently
     they were sent than about the client. */
  const settled = billable.filter((i) => i.status === 'paid' && i.payments.length);
  const days = settled.map((i) => {
    const last = i.payments[i.payments.length - 1]!;
    return Math.round(
      (Date.parse(last.date) - Date.parse(i.issueDate)) / 86_400_000,
    );
  });

  return {
    billedCents,
    paidCents,
    outstandingCents: billedCents - paidCents,
    draftCents: drafts.reduce((n, i) => n + i.totalCents, 0),
    invoiceCount: billable.length,
    draftCount: drafts.length,
    overdueCount: invoices.filter((i) => i.status === 'overdue').length,
    /* Null rather than zero when nothing has been settled. Zero would read as
       "they pay the same day", which is a very different thing from "we do not
       know yet". */
    averageDaysToPay: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null,
  };
}

export async function list(businessId: string, search?: string) {
  const [business, clients] = await Promise.all([
    prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { currency: true, dateFormat: true },
    }),
    prisma.client.findMany({
      where: {
        businessId,
        archivedAt: null,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { contactName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      include: { invoices: { where: { voidedAt: null }, include: invoiceShape } },
    }),
  ]);

  const rows = clients.map((c) => {
    const invoices = c.invoices.map(publicInvoice);
    return {
      id: c.id,
      name: c.name,
      contactName: c.contactName,
      email: c.email,
      phone: c.phone,
      since: c.createdAt.toISOString().slice(0, 10),
      paymentTermsDays: c.paymentTermsDays,
      ...statsFor(invoices),
    };
  });

  return {
    clients: rows,
    totals: {
      billedCents: rows.reduce((n, c) => n + c.billedCents, 0),
      paidCents: rows.reduce((n, c) => n + c.paidCents, 0),
      /* The same figure the invoice list calls "owed to you", reached from the
         other direction. If these two ever disagree, one of them is wrong. */
      outstandingCents: rows.reduce((n, c) => n + c.outstandingCents, 0),
    },
    currency: business.currency,
    dateFormat: business.dateFormat,
  };
}

export async function one(businessId: string, id: string) {
  const [business, client] = await Promise.all([
    prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { currency: true, dateFormat: true, paymentTermsDays: true },
    }),
    prisma.client.findFirst({
      where: { id, businessId },
      include: {
        invoices: {
          where: { voidedAt: null },
          include: invoiceShape,
          orderBy: { numberValue: 'desc' },
        },
      },
    }),
  ]);

  if (!client) throw new ApiError(404, 'That client no longer exists.', 'not_found');

  const invoices = client.invoices.map(publicInvoice);

  /* Every payment this client has made, newest first, flattened out of the
     invoices so the rail can show them without a second query. */
  const payments = invoices
    .flatMap((i) => i.payments.map((p) => ({ ...p, invoiceNumber: i.number, invoiceId: i.id })))
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    client: {
      id: client.id,
      name: client.name,
      contactName: client.contactName,
      email: client.email,
      phone: client.phone,
      addressLine1: client.addressLine1,
      addressLine2: client.addressLine2,
      city: client.city,
      province: client.province,
      postalCode: client.postalCode,
      /* Null means they use the business default, and the screen says which
         one that is rather than leaving a blank box. */
      paymentTermsDays: client.paymentTermsDays,
      defaultTermsDays: business.paymentTermsDays,
      notes: client.notes,
      since: client.createdAt.toISOString().slice(0, 10),
      archived: Boolean(client.archivedAt),
    },
    stats: statsFor(invoices),
    invoices,
    payments,
    currency: business.currency,
    dateFormat: business.dateFormat,
  };
}

export async function create(businessId: string, input: ClientInput) {
  try {
    const client = await prisma.client.create({ data: { businessId, ...input } });
    return { id: client.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'You already have a client with that name.', 'duplicate');
    }
    throw err;
  }
}

export async function update(businessId: string, id: string, input: ClientInput) {
  const existing = await prisma.client.findFirst({ where: { id, businessId } });
  if (!existing) throw new ApiError(404, 'That client no longer exists.', 'not_found');

  try {
    await prisma.client.update({ where: { id }, data: input });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'You already have a client with that name.', 'duplicate');
    }
    throw err;
  }
  return one(businessId, id);
}

/* Archived, never deleted. A client attached to past invoices has to go on
   existing for the CRA's six years, and an invoice with no billed party is not
   a document anybody can defend. */
export async function archive(businessId: string, id: string): Promise<void> {
  const client = await prisma.client.findFirst({
    where: { id, businessId, archivedAt: null },
    include: {
      invoices: {
        where: { voidedAt: null },
        include: { payments: { where: { transaction: { reversal: { is: null } } } } },
      },
    },
  });
  if (!client) throw new ApiError(404, 'That client no longer exists.', 'not_found');

  const owing = client.invoices.filter((i) => {
    const paid = i.payments.reduce((n, p) => n + p.amountCents, 0);
    return statusOf(i, paid) !== 'draft' && paid < i.totalCents;
  });

  if (owing.length) {
    throw new ApiError(
      409,
      `${client.name} still owes you on ${owing.length} ${owing.length === 1 ? 'invoice' : 'invoices'}. Settle or remove those first.`,
      'client_owes',
    );
  }

  await prisma.client.update({ where: { id }, data: { archivedAt: new Date() } });
}
