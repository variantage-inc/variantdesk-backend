import type { Prisma } from '../generated/prisma/client.js';

/* What a brand new business starts with.

   Every one of these is editable, archivable and renameable from Settings, with
   exactly one exception. They exist so that the first expense somebody records
   has somewhere to go, rather than sending them to Settings before they can use
   the product they just signed up for.

   The lists are the ones in the reviewed mockups, so a new account matches the
   screens the client approved. */

const EXPENSE = [
  'Bills Payment',
  'Contractors Payments',
  'Software & Subscriptions',
  'Office Supplies',
  'Vehicle & Fuel',
  'Advertising',
  'Professional Fees',
  'Meals & Entertainment',
];

const INCOME = ['Client work', 'Retainers', 'Consulting', 'Workshops and training', 'Other income'];

/* The one that cannot be renamed or removed.

   It is what keeps profit honest: anything filed under Owner Drawings stays
   out of net profit, out of expense reports and out of the input tax credit.
   A category that could be renamed into an ordinary expense would quietly
   break all three, and the mistake would not show up until a tax return. */
const DRAWINGS = 'Owner Drawings';

export function defaultCategories(): Prisma.CategoryCreateWithoutBusinessInput[] {
  return [
    ...INCOME.map((name, i) => ({ name, kind: 'INCOME' as const, sortOrder: i })),
    ...EXPENSE.map((name, i) => ({ name, kind: 'EXPENSE' as const, sortOrder: i })),
    { name: DRAWINGS, kind: 'DRAWINGS' as const, isSystem: true, sortOrder: 0 },
  ];
}

export const DRAWINGS_CATEGORY = DRAWINGS;
