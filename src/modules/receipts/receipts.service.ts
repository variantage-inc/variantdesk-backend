import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import {
  cleanFileName,
  deleteObject,
  keyFor,
  putObject,
  readObject,
  signedUrl,
  signedUrlSeconds,
  sniff,
  storageConfigured,
} from '../../lib/storage.js';
import { unreceipted } from '../reporting/derive.js';

/* Receipts and documents.

   A receipt is never a loose file. It belongs to one ledger entry or one
   invoice, so nothing has to be named or filed: the date, the amount and who it
   was with all come from the record it is attached to, and each can be opened
   from the other.

   Three rules:

   THE BYTES DECIDE THE TYPE. What the browser says a file is, and what it is
   called, are both the sender's claim. `sniff` reads the first bytes, and that
   is the type stored and served.

   NOTHING IS PUBLIC. The bucket is private. A link is signed for five minutes,
   and only after the database has confirmed the file belongs to the business
   asking. The key is never sent to the browser.

   REMOVING A RECEIPT IS NOT REMOVING THE ENTRY. The file goes; the entry and
   its figures stay exactly as they were. The row stays too, marked removed,
   so who took the proof away still has an answer. */

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const MAX_PER_RECORD = 10;

type Ctx = { businessId: string; userId: string };

const shape = {
  createdBy: { select: { firstName: true, lastName: true } },
  transaction: {
    select: {
      id: true,
      type: true,
      date: true,
      description: true,
      totalCents: true,
      taxCents: true,
      vendor: { select: { name: true } },
      client: { select: { name: true } },
      category: { select: { name: true } },
      invoicePayment: { select: { invoice: { select: { id: true, number: true } } } },
    },
  },
  invoice: {
    select: { id: true, number: true, issueDate: true, totalCents: true, taxCents: true, billToName: true },
  },
} satisfies Prisma.AttachmentInclude;

type Row = Prisma.AttachmentGetPayload<{ include: typeof shape }>;

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/* What the browser is told about a file. Never the storage key. */
export const briefAttachment = (a: {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}) => ({
  id: a.id,
  fileName: a.fileName,
  contentType: a.contentType,
  sizeBytes: a.sizeBytes,
  createdAt: a.createdAt.toISOString(),
});

/* The select every screen that lists an entry's receipts uses. */
export const liveAttachments = {
  where: { deletedAt: null },
  orderBy: { createdAt: 'asc' as const },
  select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true },
} satisfies Prisma.Transaction$attachmentsArgs;

function publicReceipt(a: Row) {
  const t = a.transaction;
  const inv = a.invoice;
  return {
    ...briefAttachment(a),
    by: `${a.createdBy.firstName} ${a.createdBy.lastName}`.trim(),
    /* The record it belongs to, described well enough to recognise it. */
    on: t
      ? {
          kind: t.type,
          id: t.id,
          date: iso(t.date),
          title: t.description,
          party: t.vendor?.name ?? t.client?.name ?? null,
          category: t.category?.name ?? null,
          totalCents: t.totalCents,
          taxCents: t.taxCents,
          fromInvoice: t.invoicePayment?.invoice ?? null,
        }
      : {
          kind: 'INVOICE' as const,
          id: inv!.id,
          date: iso(inv!.issueDate),
          title: `Invoice ${inv!.number}`,
          party: inv!.billToName,
          category: null,
          totalCents: inv!.totalCents,
          taxCents: inv!.taxCents,
          fromInvoice: null,
        },
  };
}

export type PublicReceipt = ReturnType<typeof publicReceipt>;

/* --------------------------------------------------------------- upload --- */

function ensureStorage(): void {
  if (!storageConfigured()) {
    throw new ApiError(503, 'Document storage is not switched on yet.', 'storage_unconfigured');
  }
}

function checkFile(bytes: Buffer) {
  if (bytes.length === 0) throw new ApiError(400, 'That file is empty.', 'empty_file');
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new ApiError(413, 'That file is larger than 10 MB. Try a smaller scan or photo.', 'file_too_large');
  }
  const kind = sniff(bytes);
  if (!kind) {
    throw new ApiError(
      415,
      'A receipt can be a photo (JPG, PNG, HEIC or WebP) or a PDF. That file is none of those.',
      'unsupported_file',
    );
  }
  return kind;
}

/* Stored first, recorded second. If the row cannot be written, the object is
   removed again, so a failed upload leaves nothing behind in either place. */
async function store(
  ctx: Ctx,
  target: { transactionId: string } | { invoiceId: string },
  bytes: Buffer,
  rawName: string | undefined,
  fallbackName: string,
) {
  ensureStorage();
  const kind = checkFile(bytes);

  const fileName = cleanFileName(rawName, kind.ext, fallbackName);
  const key = keyFor(ctx.businessId, 'receipts', kind.ext);

  await putObject(key, bytes, { contentType: kind.contentType, fileName });

  try {
    const created = await prisma.attachment.create({
      data: {
        businessId: ctx.businessId,
        ...target,
        key,
        fileName,
        contentType: kind.contentType,
        sizeBytes: bytes.length,
        createdById: ctx.userId,
      },
    });
    /* The file's own facts only. Every screen reloads its record after an
       upload, and loading the whole record here would cost a round trip per
       relation for an answer nobody reads. */
    return briefAttachment(created);
  } catch (err) {
    await deleteObject(key).catch(() => undefined);
    throw err;
  }
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'receipt';

export async function attachToEntry(ctx: Ctx, entryId: string, bytes: Buffer, rawName?: string) {
  const entry = await prisma.transaction.findFirst({
    where: { id: entryId, businessId: ctx.businessId, kind: 'ENTRY' },
    select: {
      id: true,
      date: true,
      description: true,
      reversal: { select: { id: true } },
      vendor: { select: { name: true } },
      client: { select: { name: true } },
      _count: { select: { attachments: { where: { deletedAt: null } } } },
    },
  });
  if (!entry) throw new ApiError(404, 'That entry no longer exists.', 'not_found');

  /* A corrected or removed entry is history. Its replacement is the one that
     takes receipts, and attaching here would hide the file from every screen. */
  if (entry.reversal) {
    throw new ApiError(409, 'That entry has since been changed. Refresh and try again.', 'already_reversed');
  }
  if (entry._count.attachments >= MAX_PER_RECORD) {
    throw new ApiError(409, `An entry can hold ${MAX_PER_RECORD} documents at most.`, 'too_many_files');
  }

  const who = entry.vendor?.name ?? entry.client?.name ?? entry.description;
  return store(
    ctx,
    { transactionId: entry.id },
    bytes,
    rawName,
    `${slug(who)}-${iso(entry.date).replace(/-/g, '')}`,
  );
}

export async function attachToInvoice(ctx: Ctx, invoiceId: string, bytes: Buffer, rawName?: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, businessId: ctx.businessId, voidedAt: null },
    include: { _count: { select: { attachments: { where: { deletedAt: null } } } } },
  });
  if (!invoice) throw new ApiError(404, 'That invoice no longer exists.', 'not_found');
  if (invoice._count.attachments >= MAX_PER_RECORD) {
    throw new ApiError(409, `An invoice can hold ${MAX_PER_RECORD} documents at most.`, 'too_many_files');
  }
  return store(ctx, { invoiceId: invoice.id }, bytes, rawName, slug(invoice.number));
}

/* ------------------------------------------------------------- one file --- */

/* The file, if it is this business's and its record still stands. A receipt on
   a removed entry or a voided invoice is kept, but it is not offered. */
async function owned(businessId: string, id: string) {
  const a = await prisma.attachment.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
      OR: [
        { transaction: { is: { kind: 'ENTRY', reversal: { is: null } } } },
        { invoice: { is: { voidedAt: null } } },
      ],
    },
  });
  if (!a) throw new ApiError(404, 'That document no longer exists.', 'not_found');
  return a;
}

export async function viewLink(businessId: string, id: string) {
  ensureStorage();
  const a = await owned(businessId, id);
  return { url: await signedUrl(a.key), expiresInSeconds: signedUrlSeconds, contentType: a.contentType };
}

export async function download(businessId: string, id: string) {
  ensureStorage();
  const a = await owned(businessId, id);
  return { bytes: await readObject(a.key), fileName: a.fileName, contentType: a.contentType };
}

/* The object is deleted INSIDE the database transaction. If storage refuses,
   the row is not marked removed, so the screen never claims a file is gone
   while it is still sitting in the bucket. */
export async function remove(ctx: Ctx, id: string): Promise<void> {
  ensureStorage();
  const a = await owned(ctx.businessId, id);
  await prisma.$transaction(async (tx) => {
    await tx.attachment.update({
      where: { id: a.id },
      data: { deletedAt: new Date(), deletedById: ctx.userId },
    });
    await deleteObject(a.key);
  });
}

/* ------------------------------------------------------------ the screen --- */

export type ReceiptQuery = {
  on: 'all' | 'EXPENSE' | 'INCOME' | 'DRAWING' | 'INVOICE';
  fileType: 'all' | 'pdf' | 'img';
  search?: string;
  from?: string;
  to?: string;
  page: number;
  perPage: number;
};

const liveEntry = (extra: Prisma.TransactionWhereInput = {}): Prisma.AttachmentWhereInput => ({
  transaction: { is: { kind: 'ENTRY', reversal: { is: null }, ...extra } },
});
const liveInvoice = (extra: Prisma.InvoiceWhereInput = {}): Prisma.AttachmentWhereInput => ({
  invoice: { is: { voidedAt: null, ...extra } },
});

function whereFor(businessId: string, q: ReceiptQuery): Prisma.AttachmentWhereInput {
  const range =
    q.from || q.to
      ? {
          ...(q.from ? { gte: new Date(`${q.from}T00:00:00.000Z`) } : {}),
          ...(q.to ? { lte: new Date(`${q.to}T00:00:00.000Z`) } : {}),
        }
      : undefined;

  const txBase: Prisma.TransactionWhereInput = {
    ...(q.on !== 'all' && q.on !== 'INVOICE' ? { type: q.on } : {}),
    ...(range ? { date: range } : {}),
  };
  const invBase: Prisma.InvoiceWhereInput = range ? { issueDate: range } : {};

  const targets: ((extra?: object) => Prisma.AttachmentWhereInput)[] = [];
  if (q.on !== 'INVOICE') targets.push((extra = {}) => liveEntry({ ...txBase, ...extra }));
  if (q.on === 'all' || q.on === 'INVOICE') targets.push((extra = {}) => liveInvoice({ ...invBase, ...extra }));

  let OR: Prisma.AttachmentWhereInput[];
  if (!q.search) {
    OR = targets.map((t) => t());
  } else {
    const contains = { contains: q.search, mode: 'insensitive' as const };
    OR = [
      ...targets.map((t) => ({ AND: [t(), { fileName: contains }] })),
      ...(q.on !== 'INVOICE'
        ? [
            liveEntry({
              ...txBase,
              OR: [
                { description: contains },
                { vendor: { name: contains } },
                { client: { name: contains } },
                { reference: contains },
              ],
            }),
          ]
        : []),
      ...(q.on === 'all' || q.on === 'INVOICE'
        ? [liveInvoice({ ...invBase, OR: [{ number: contains }, { billToName: contains }] })]
        : []),
    ];
  }

  return {
    businessId,
    deletedAt: null,
    ...(q.fileType === 'pdf'
      ? { contentType: 'application/pdf' }
      : q.fileType === 'img'
        ? { contentType: { startsWith: 'image/' } }
        : {}),
    OR,
  };
}

export async function list(businessId: string, q: ReceiptQuery) {
  const where = whereFor(businessId, q);
  const everything: Prisma.AttachmentWhereInput = {
    businessId,
    deletedAt: null,
    OR: [liveEntry(), liveInvoice()],
  };

  const countOn = (extra: Prisma.AttachmentWhereInput) =>
    prisma.attachment.count({ where: { businessId, deletedAt: null, ...extra } });

  const [business, rows, total, byType, all, expense, income, drawing, invoice, missing] =
    await Promise.all([
      prisma.business.findUniqueOrThrow({
        where: { id: businessId },
        select: { currency: true, dateFormat: true, gstRegistered: true },
      }),
      prisma.attachment.findMany({
        where,
        include: shape,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
      }),
      prisma.attachment.count({ where }),
      prisma.attachment.groupBy({
        by: ['contentType'],
        where: everything,
        _count: true,
        _sum: { sizeBytes: true },
      }),
      countOn({ OR: [liveEntry(), liveInvoice()] }),
      countOn(liveEntry({ type: 'EXPENSE' })),
      countOn(liveEntry({ type: 'INCOME' })),
      countOn(liveEntry({ type: 'DRAWING' })),
      countOn(liveInvoice()),
      /* All time. A receipt missing from March is still missing in September. */
      unreceipted(businessId, null),
    ]);

  const pdfs = byType.filter((g) => g.contentType === 'application/pdf');
  const images = byType.filter((g) => g.contentType.startsWith('image/'));
  const sum = (groups: typeof byType, pick: (g: (typeof byType)[number]) => number) =>
    groups.reduce((n, g) => n + pick(g), 0);

  return {
    receipts: rows.map(publicReceipt),
    total,
    page: q.page,
    perPage: q.perPage,
    counts: { all, EXPENSE: expense, INCOME: income, DRAWING: drawing, INVOICE: invoice },
    summary: {
      files: all,
      pdfs: sum(pdfs, (g) => g._count),
      images: sum(images, (g) => g._count),
      bytes: sum(byType, (g) => g._sum.sizeBytes ?? 0),
    },
    missing,
    configured: storageConfigured(),
    maxBytes: MAX_RECEIPT_BYTES,
    currency: business.currency,
    dateFormat: business.dateFormat,
    gstRegistered: business.gstRegistered,
  };
}

/* The receipts on one invoice, for the invoice screen. */
export async function forInvoice(businessId: string, invoiceId: string) {
  const rows = await prisma.attachment.findMany({
    where: { businessId, invoiceId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(briefAttachment);
}
