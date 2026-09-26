import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';
import { ApiError } from '../middleware/error.js';

/* The only file that talks to object storage.

   Neon Object Storage speaks S3, so this is the AWS SDK pointed at the branch's
   endpoint. The bucket is PRIVATE: nothing in it is ever reachable without a
   signature, and a signature is only handed out to somebody signed in to the
   business that owns the file, for five minutes at a time.

   Keys start with the business id. That is not what keeps businesses apart,
   the database check before every signature is, but it means a whole
   business's files can be listed and removed together, which the seed needs. */

const SIGNED_URL_SECONDS = 5 * 60;

export const storageConfigured = (): boolean =>
  Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_ENDPOINT_URL_S3);

let client: S3Client | null = null;

function s3(): S3Client {
  if (!storageConfigured()) {
    throw new ApiError(503, 'Document storage is not switched on yet.', 'storage_unconfigured');
  }
  client ??= new S3Client({
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL_S3,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    },
    /* Neon uses path style addressing and refuses virtual hosted buckets. */
    forcePathStyle: true,
    /* Newer SDKs add CRC checksums to every request by default, which not
       every S3 compatible store accepts. Only where the API demands one. */
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

/* ------------------------------------------------------------- the bytes --- */

export type FileKind = { contentType: string; ext: string; label: string };

const startsWith = (buf: Buffer, bytes: number[], at = 0): boolean =>
  bytes.every((b, i) => buf[at + i] === b);

const ascii = (buf: Buffer, from: number, to: number): string =>
  buf.subarray(from, to).toString('latin1');

/* What a file IS, from its first bytes.

   The browser's content type and the file name are both whatever the sender
   says they are. A script renamed receipt.pdf is still a script, so neither is
   trusted: the type stored, and later served, is the one the bytes prove. */
export function sniff(buf: Buffer): FileKind | null {
  if (ascii(buf, 0, 5) === '%PDF-') return { contentType: 'application/pdf', ext: 'pdf', label: 'PDF' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', ext: 'jpg', label: 'Photo' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', ext: 'png', label: 'Image' };
  }
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', ext: 'webp', label: 'Image' };
  }
  /* An iPhone photograph. ISO media with an HEIF brand. */
  if (ascii(buf, 4, 8) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(ascii(buf, 8, 12))) {
    return { contentType: 'image/heic', ext: 'heic', label: 'Photo' };
  }
  return null;
}

/* An SVG is text, so it has no magic number. It is accepted for the logo only,
   and only ever drawn through an <img> tag, where a script inside it cannot
   run. Opening one directly is forced to a download for the same reason. */
export function sniffSvg(buf: Buffer): FileKind | null {
  const head = buf.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart();
  if (!head.startsWith('<')) return null;
  return /<svg[\s>]/i.test(head) ? { contentType: 'image/svg+xml', ext: 'svg', label: 'Vector' } : null;
}

/* The name the owner gave the file, made safe to store and to put in a
   Content-Disposition header, with the extension the bytes proved. */
export function cleanFileName(raw: string | undefined, ext: string, fallback: string): string {
  let name = '';
  try {
    name = decodeURIComponent(raw ?? '');
  } catch {
    name = '';
  }
  const base = (name.split(/[\\/]/).pop() ?? '')
    .replace(/\.[^.]*$/, '')
    .replace(/[^\p{L}\p{N} ._()-]+/gu, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 100)
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
  return `${base || fallback}.${ext}`;
}

export const keyFor = (businessId: string, folder: 'receipts' | 'logos', ext: string): string =>
  `${businessId}/${folder}/${randomUUID()}.${ext}`;

/* ------------------------------------------------------------ operations --- */

/* A Content-Disposition header value, safe for any file name. */
export function disposition(kind: 'inline' | 'attachment', fileName: string): string {
  const plain = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${kind}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/* The type and disposition are stored WITH the object, because Neon ignores
   the per request overrides S3 allows on a signed link. So they are decided
   once, here: shown in the browser, except an SVG, which is always saved,
   because an SVG opened directly is a page that can run script. */
export async function putObject(
  key: string,
  body: Buffer,
  file: { contentType: string; fileName: string },
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.STORAGE_BUCKET,
      Key: key,
      Body: body,
      ContentType: file.contentType,
      ContentDisposition: disposition(
        file.contentType === 'image/svg+xml' ? 'attachment' : 'inline',
        file.fileName,
      ),
    }),
  );
}

/* A link that works for five minutes and then never again. For viewing: a
   download goes through the API instead, see `readObject`. */
export async function signedUrl(key: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key }), {
    expiresIn: SIGNED_URL_SECONDS,
  });
}

/* The bytes themselves, for a download the API hands over with its own
   headers. A cross origin link cannot be told to save rather than show, and
   the stored disposition says show. */
export async function readObject(key: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key }));
  if (!res.Body) throw new ApiError(404, 'That file is no longer in storage.', 'not_found');
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key }));
}

/* Everything under a prefix. Used by the seed to clear its own business
   before rebuilding it; nothing a customer can reach calls this. */
export async function deletePrefix(prefix: string): Promise<number> {
  let removed = 0;
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({ Bucket: env.STORAGE_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) {
      await s3().send(
        new DeleteObjectsCommand({ Bucket: env.STORAGE_BUCKET, Delete: { Objects: keys, Quiet: true } }),
      );
      removed += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return removed;
}

export const signedUrlSeconds = SIGNED_URL_SECONDS;
