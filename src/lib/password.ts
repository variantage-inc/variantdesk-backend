import bcrypt from 'bcryptjs';

/* Cost 12. High enough that a leaked table is impractical to crack, low enough
   that a login is not noticeably slow. Raise it when hardware makes it cheap,
   never lower it. */
const COST = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, COST);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

/* Run when no user was found, so a login against an unknown email takes the
   same time as one against a real account. Without it the response time tells
   an attacker which addresses are registered. */
const DUMMY_HASH = '$2a$12$M8kFqZ0aVvJ5x1Q9rWnLdOJ3sT2yUvB6cD7eF8gH9iJ0kL1mN2oPq';
export const wastePasswordTime = (plain: string): Promise<boolean> =>
  bcrypt.compare(plain, DUMMY_HASH).catch(() => false);
