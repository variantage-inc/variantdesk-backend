/* Prisma error codes worth handling by name rather than by guessing at the
   message text, which changes between versions. */
export const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}
