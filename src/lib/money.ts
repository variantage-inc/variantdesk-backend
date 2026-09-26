/* Money is whole cents everywhere inside the API. See decision 4 in the data
   model. These are the only two places a conversion is allowed to happen, so
   a float never reaches the database and a cent never goes missing.

   Tax is worked out on the cent amount and rounded once, at the end. Rounding
   each line separately is what makes an invoice total disagree with the sum of
   its lines. */

export const toCents = (amount: number | string): number => {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) throw new Error(`Not a usable amount: ${amount}`);
  return Math.round(n * 100);
};

export const fromCents = (cents: number): number => cents / 100;

export const formatCents = (cents: number, currency = 'CAD'): string =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);

/** Tax on a pre-tax amount. `rateBasisPoints` is 1300 for 13%. */
export const taxOn = (subtotalCents: number, rateBasisPoints: number): number =>
  Math.round((subtotalCents * rateBasisPoints) / 10000);

/** Split a tax-inclusive total back into subtotal and tax. */
export const splitInclusive = (
  totalCents: number,
  rateBasisPoints: number,
): { subtotal: number; tax: number } => {
  const subtotal = Math.round((totalCents * 10000) / (10000 + rateBasisPoints));
  return { subtotal, tax: totalCents - subtotal };
};
