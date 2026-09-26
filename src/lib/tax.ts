/* Canadian sales tax by province, current to 2026.

   The province is chosen; the rate is never typed. That is the whole point of
   the setting, and it is why this table lives in the API: the web app, the
   phone apps and every report have to agree about what Ontario charges, and
   three copies of a rate table is three chances for them not to.

   Rates are basis points, so 1300 is 13%. An integer cannot drift the way
   0.13 can, and the total is worked out on cents in lib/money.ts.

   Nothing here is the rate that ends up on an invoice. That rate is COPIED
   onto the invoice row when it is issued and never read back from this table,
   because Nova Scotia went from 15% to 14% in 2025 and a 2024 invoice must
   still read 15%. */

export type ProvinceTax = {
  code: string;
  name: string;
  /* What the customer sees, exactly as the mockups word it. */
  label: string;
  note: string;
  /* The total charged. For the split provinces this is federal plus
     provincial, which is what goes on the invoice line. */
  totalBp: number;
  federalBp: number;
  provincialBp: number;
  /* Whether the provincial half can be claimed back as an input tax credit.
     PST and RST cannot; QST can, for registrants. This is the distinction the
     GST/HST report depends on. */
  provincialRecoverable: boolean;
};

export const PROVINCE_TAX = {
  AB: { code: 'AB', name: 'Alberta', label: 'GST 5%', note: 'GST only. No provincial sales tax.', totalBp: 500, federalBp: 500, provincialBp: 0, provincialRecoverable: false },
  BC: { code: 'BC', name: 'British Columbia', label: 'GST 5% + PST 7%', note: 'Charged separately, never compounded. PST is not recoverable.', totalBp: 1200, federalBp: 500, provincialBp: 700, provincialRecoverable: false },
  MB: { code: 'MB', name: 'Manitoba', label: 'GST 5% + RST 7%', note: 'Charged separately. RST is not recoverable.', totalBp: 1200, federalBp: 500, provincialBp: 700, provincialRecoverable: false },
  NB: { code: 'NB', name: 'New Brunswick', label: 'HST 15%', note: 'Single harmonised rate, fully recoverable.', totalBp: 1500, federalBp: 500, provincialBp: 1000, provincialRecoverable: true },
  NL: { code: 'NL', name: 'Newfoundland and Labrador', label: 'HST 15%', note: 'Single harmonised rate, fully recoverable.', totalBp: 1500, federalBp: 500, provincialBp: 1000, provincialRecoverable: true },
  NS: { code: 'NS', name: 'Nova Scotia', label: 'HST 14%', note: 'Reduced from 15% on 1 April 2025.', totalBp: 1400, federalBp: 500, provincialBp: 900, provincialRecoverable: true },
  NT: { code: 'NT', name: 'Northwest Territories', label: 'GST 5%', note: 'GST only. No territorial sales tax.', totalBp: 500, federalBp: 500, provincialBp: 0, provincialRecoverable: false },
  NU: { code: 'NU', name: 'Nunavut', label: 'GST 5%', note: 'GST only. No territorial sales tax.', totalBp: 500, federalBp: 500, provincialBp: 0, provincialRecoverable: false },
  ON: { code: 'ON', name: 'Ontario', label: 'HST 13%', note: 'Single harmonised rate, fully recoverable.', totalBp: 1300, federalBp: 500, provincialBp: 800, provincialRecoverable: true },
  PE: { code: 'PE', name: 'Prince Edward Island', label: 'HST 15%', note: 'Single harmonised rate, fully recoverable.', totalBp: 1500, federalBp: 500, provincialBp: 1000, provincialRecoverable: true },
  QC: { code: 'QC', name: 'Quebec', label: 'GST 5% + QST 9.975%', note: 'Charged separately. QST is recoverable for registrants.', totalBp: 1498, federalBp: 500, provincialBp: 998, provincialRecoverable: true },
  SK: { code: 'SK', name: 'Saskatchewan', label: 'GST 5% + PST 6%', note: 'Charged separately. PST is not recoverable.', totalBp: 1100, federalBp: 500, provincialBp: 600, provincialRecoverable: false },
  YT: { code: 'YT', name: 'Yukon', label: 'GST 5%', note: 'GST only. No territorial sales tax.', totalBp: 500, federalBp: 500, provincialBp: 0, provincialRecoverable: false },
} satisfies Record<string, ProvinceTax>;

/* Quebec is the one that does not divide neatly. QST is 9.975%, which is
   99.75 basis points of a percent, so the total is rounded to 14.98% here.
   Flagged rather than hidden: when Quebec invoicing is built in Phase 6 the
   two halves are charged separately and each is rounded on its own, which is
   what Revenu Quebec expects and what this single figure cannot express. */

/* Ontario is the fallback rather than a throw. A province code that is not in
   the table means a row written before a code changed, and refusing to render
   somebody's settings over it would be worse than showing them a rate they can
   correct in one click. */
export const taxFor = (province: string): ProvinceTax =>
  (PROVINCE_TAX as Record<string, ProvinceTax | undefined>)[province] ?? PROVINCE_TAX.ON;

export const provinceList = (): ProvinceTax[] => Object.values(PROVINCE_TAX);
