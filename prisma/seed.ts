/* The development seed.

   It builds Maple Ridge Consulting, the sample business in the approved
   mockups, so that a fresh database opens on the figures the client has
   already reviewed: July 2026 income 11,540.00, expenses 3,459.64, owner
   drawings 3,500.00, nine invoices and 16,170.30 outstanding.

   Two rules shape the whole file.

   EVERYTHING IS WRITTEN THROUGH THE SERVICES. Entries go through
   modules/transactions, which goes through lib/ledger, and invoices and their
   payments go through modules/invoices. There is not one raw insert into the
   transaction table here, which means seeded data obeys every rule real data
   obeys: append only, atomic, tax stored on the row, drawings out of profit,
   and one linked income entry per payment. A seed that wrote rows directly
   would be a second, quieter way into the books, and the figures it produced
   would prove nothing about the code.

   THE PUBLISHED FIGURES ARE ASSERTED, NOT ASSUMED. When the writing is done
   the seed reads every month back through modules/reporting/derive.ts, the
   same derivation the dashboard uses, and refuses to finish if a month is a
   cent away from the table the client reviewed.

   Source of truth: ../../../mockups-v2/assets/dash-data.js. Where that file
   disagrees with itself, MONTHS and MISSING_ENTRIES win: they are written to
   reconcile, and RECENT says of itself that it is a sample of a period rather
   than a total of one.

   Amounts below are BEFORE TAX, in dollars, exactly as the mockup states
   them, so this table can be read against dash-data.js line by line. The one
   conversion to cents happens where it happens for a real entry, in
   modules/transactions.

   Run: npm run db:seed */
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/lib/env.js';
import { hashPassword } from '../src/lib/password.js';
import { toCents } from '../src/lib/money.js';
import { defaultCategories } from '../src/lib/defaults.js';
import { trialCreateData } from '../src/modules/billing/billing.service.js';
import * as transactions from '../src/modules/transactions/transactions.service.js';
import * as invoices from '../src/modules/invoices/invoices.service.js';
import * as payments from '../src/modules/invoices/payments.service.js';
import * as clients from '../src/modules/invoices/clients.service.js';
import * as settings from '../src/modules/settings/settings.service.js';
import { derive } from '../src/modules/reporting/derive.js';

const BUSINESS_ID = 'seed-maple-ridge';
const OWNER_EMAIL = 'sarah@mapleridgeconsulting.ca';
const OWNER_PASSWORD = 'Variantage2026!';

/* ------------------------------------------------------------- the people --- */

const VENDORS: { name: string; category: string }[] = [
  { name: 'Bennett Digital', category: 'Contractors Payments' },
  { name: 'Oshawa Power Ltd.', category: 'Bills Payment' },
  { name: 'Rogers Communications', category: 'Bills Payment' },
  { name: 'Bell Canada', category: 'Bills Payment' },
  { name: 'Adobe Systems', category: 'Software & Subscriptions' },
  { name: 'Figma', category: 'Software & Subscriptions' },
  { name: 'Toronto Star', category: 'Advertising' },
  { name: 'Staples', category: 'Office Supplies' },
  { name: 'Amazon Business', category: 'Office Supplies' },
  { name: 'Petro-Canada', category: 'Vehicle & Fuel' },
  { name: 'Green P Toronto', category: 'Vehicle & Fuel' },
  { name: 'Ledger & Co Accountants', category: 'Professional Fees' },
  { name: 'Gusto 101', category: 'Meals & Entertainment' },
];

const CLIENTS = [
  {
    name: 'Northwind Studio',
    contactName: 'Dan Petrov',
    email: 'dan@northwindstudio.ca',
    phone: '416 555 0102',
    addressLine1: '42 Ossington Avenue',
    city: 'Toronto',
    province: 'ON',
    postalCode: 'M6J 2Y7',
    since: '2025-03-11',
  },
  {
    name: 'Lakeshore Dental',
    contactName: 'Dr Amelia Ross',
    email: 'accounts@lakeshoredental.ca',
    phone: '905 555 0147',
    addressLine1: '900 Lakeshore Road East',
    city: 'Oshawa',
    province: 'ON',
    postalCode: 'L1H 1H8',
    since: '2025-09-02',
  },
  {
    name: 'Oshawa Physio',
    contactName: 'Marcus Hale',
    email: 'marcus@oshawaphysio.ca',
    phone: '905 555 0188',
    addressLine1: '15 King Street West',
    city: 'Oshawa',
    province: 'ON',
    postalCode: 'L1H 1A1',
    since: '2024-11-19',
  },
  {
    name: 'Bright Path Coaching',
    contactName: 'Grace Lindqvist',
    email: 'grace@brightpathcoaching.ca',
    phone: '416 555 0164',
    addressLine1: '77 Bloor Street West',
    city: 'Toronto',
    province: 'ON',
    postalCode: 'M5S 1M2',
    since: '2026-01-28',
  },
  {
    name: 'Maple Leaf Legal',
    contactName: 'Peter Almeida',
    email: 'accounts@mapleleaflegal.ca',
    phone: '416 555 0119',
    addressLine1: '250 University Avenue',
    city: 'Toronto',
    province: 'ON',
    postalCode: 'M5H 3E5',
    since: '2025-06-04',
  },
];

/* ------------------------------------------------------------ the entries --- */

type Income = { date: string; description: string; client: string; category: string; amount: number };
type Expense = { date: string; description: string; vendor: string; category: string; amount: number };
type Drawing = { date: string; purpose: string; amount: number };

type Month = { key: string; income: Income[]; expenses: Expense[]; drawings: Drawing[] };

/* What is NOT in this table, deliberately: the income posted by the four
   invoice payments below. That income is written by recording the payment,
   because an invoice already counted as income when it was sent and again
   when the deposit landed is the most common error in small business books.
   So June's manual income is 7,005.00 against a published 10,105.00, and the
   3,100.00 difference is INV-0037 being paid on the 26th. */
const MONTHS: Month[] = [
  {
    key: '2026-01',
    income: [
      { date: '2026-01-08', description: 'Consulting, January', client: 'Maple Leaf Legal', category: 'Consulting', amount: 2000.0 },
      { date: '2026-01-15', description: 'Monthly retainer', client: 'Oshawa Physio', category: 'Retainers', amount: 3200.0 },
      { date: '2026-01-29', description: 'Brand strategy sprint', client: 'Northwind Studio', category: 'Client work', amount: 4000.0 },
    ],
    expenses: [
      { date: '2026-01-12', description: 'Hydro and utilities, January', vendor: 'Oshawa Power Ltd.', category: 'Bills Payment', amount: 430.0 },
      { date: '2026-01-14', description: 'Fuel and parking, January', vendor: 'Petro-Canada', category: 'Vehicle & Fuel', amount: 120.0 },
      { date: '2026-01-16', description: 'Advert, January', vendor: 'Toronto Star', category: 'Advertising', amount: 400.0 },
      { date: '2026-01-19', description: 'Client lunch, January', vendor: 'Gusto 101', category: 'Meals & Entertainment', amount: 180.01 },
      { date: '2026-01-21', description: 'Contractor, January', vendor: 'Bennett Digital', category: 'Contractors Payments', amount: 1600.0 },
      { date: '2026-01-22', description: 'Software subscriptions, January', vendor: 'Adobe Systems', category: 'Software & Subscriptions', amount: 189.99 },
      { date: '2026-01-27', description: 'Office supplies, January', vendor: 'Staples', category: 'Office Supplies', amount: 130.0 },
    ],
    drawings: [{ date: '2026-01-09', purpose: 'Monthly household transfer', amount: 2500.0 }],
  },
  {
    key: '2026-02',
    income: [
      { date: '2026-02-06', description: 'Consulting, February', client: 'Maple Leaf Legal', category: 'Consulting', amount: 2050.0 },
      { date: '2026-02-16', description: 'Monthly retainer', client: 'Oshawa Physio', category: 'Retainers', amount: 3200.0 },
      { date: '2026-02-25', description: 'Website refresh', client: 'Lakeshore Dental', category: 'Client work', amount: 3500.0 },
    ],
    expenses: [
      { date: '2026-02-06', description: 'Client lunch, February', vendor: 'Gusto 101', category: 'Meals & Entertainment', amount: 19.99 },
      { date: '2026-02-10', description: 'Hydro and utilities, February', vendor: 'Oshawa Power Ltd.', category: 'Bills Payment', amount: 420.0 },
      { date: '2026-02-13', description: 'Fuel and parking, February', vendor: 'Petro-Canada', category: 'Vehicle & Fuel', amount: 100.0 },
      { date: '2026-02-17', description: 'Advert, February', vendor: 'Toronto Star', category: 'Advertising', amount: 350.0 },
      { date: '2026-02-18', description: 'Contractor, February', vendor: 'Bennett Digital', category: 'Contractors Payments', amount: 1500.0 },
      { date: '2026-02-22', description: 'Software subscriptions, February', vendor: 'Adobe Systems', category: 'Software & Subscriptions', amount: 200.01 },
      { date: '2026-02-24', description: 'Office supplies, February', vendor: 'Staples', category: 'Office Supplies', amount: 90.0 },
      { date: '2026-02-26', description: 'Bookkeeping, February', vendor: 'Ledger & Co Accountants', category: 'Professional Fees', amount: 200.0 },
    ],
    drawings: [{ date: '2026-02-06', purpose: 'Monthly household transfer', amount: 2500.0 }],
  },
  {
    key: '2026-03',
    income: [
      { date: '2026-03-03', description: 'Consulting, March', client: 'Northwind Studio', category: 'Consulting', amount: 1600.0 },
      { date: '2026-03-09', description: 'Training day, on site', client: 'Maple Leaf Legal', category: 'Workshops and training', amount: 2400.0 },
      { date: '2026-03-17', description: 'Monthly retainer', client: 'Oshawa Physio', category: 'Retainers', amount: 3200.0 },
      { date: '2026-03-27', description: 'Campaign build', client: 'Bright Path Coaching', category: 'Client work', amount: 5200.0 },
    ],
    expenses: [
      { date: '2026-03-09', description: 'Office supplies, March', vendor: 'Staples', category: 'Office Supplies', amount: 180.0 },
      { date: '2026-03-11', description: 'Hydro and utilities, March', vendor: 'Oshawa Power Ltd.', category: 'Bills Payment', amount: 442.0 },
      { date: '2026-03-13', description: 'Fuel and parking, March', vendor: 'Petro-Canada', category: 'Vehicle & Fuel', amount: 117.15 },
      { date: '2026-03-16', description: 'Advert, March', vendor: 'Toronto Star', category: 'Advertising', amount: 450.0 },
      { date: '2026-03-19', description: 'Contractor, March', vendor: 'Bennett Digital', category: 'Contractors Payments', amount: 2200.0 },
      { date: '2026-03-21', description: 'Client dinner, March', vendor: 'Gusto 101', category: 'Meals & Entertainment', amount: 230.85 },
      { date: '2026-03-22', description: 'Software subscriptions, March', vendor: 'Adobe Systems', category: 'Software & Subscriptions', amount: 200.0 },
      { date: '2026-03-26', description: 'Bookkeeping, March', vendor: 'Ledger & Co Accountants', category: 'Professional Fees', amount: 300.0 },
    ],
    drawings: [{ date: '2026-03-10', purpose: 'Monthly household transfer', amount: 3000.0 }],
  },
  {
    key: '2026-04',
    income: [
      { date: '2026-04-07', description: 'Consulting, April', client: 'Maple Leaf Legal', category: 'Consulting', amount: 2850.0 },
      { date: '2026-04-15', description: 'Website build, phase two', client: 'Northwind Studio', category: 'Client work', amount: 4500.0 },
      { date: '2026-04-24', description: 'Retainer, April', client: 'Oshawa Physio', category: 'Retainers', amount: 2800.0 },
    ],
    expenses: [
      { date: '2026-04-10', description: 'Hydro and utilities, April', vendor: 'Oshawa Power Ltd.', category: 'Bills Payment', amount: 430.0 },
      { date: '2026-04-13', description: 'Fuel and parking, April', vendor: 'Petro-Canada', category: 'Vehicle & Fuel', amount: 120.0 },
      { date: '2026-04-15', description: 'Advert, April', vendor: 'Toronto Star', category: 'Advertising', amount: 300.0 },
      { date: '2026-04-16', description: 'Contractor, April', vendor: 'Bennett Digital', category: 'Contractors Payments', amount: 1900.0 },
      { date: '2026-04-21', description: 'Client lunch, April', vendor: 'Gusto 101', category: 'Meals & Entertainment', amount: 259.99 },
      { date: '2026-04-22', description: 'Software subscriptions, April', vendor: 'Adobe Systems', category: 'Software & Subscriptions', amount: 200.01 },
      { date: '2026-04-27', description: 'Office supplies, April', vendor: 'Staples', category: 'Office Supplies', amount: 130.0 },
    ],
    drawings: [{ date: '2026-04-08', purpose: 'Monthly household transfer', amount: 2500.0 }],
  },
  {
    key: '2026-05',
    income: [
      { date: '2026-05-05', description: 'Consulting, May', client: 'Northwind Studio', category: 'Consulting', amount: 2000.0 },
      { date: '2026-05-11', description: 'Workshop, two days', client: 'Bright Path Coaching', category: 'Workshops and training', amount: 2400.0 },
      { date: '2026-05-19', description: 'Monthly retainer', client: 'Oshawa Physio', category: 'Retainers', amount: 3200.0 },
      { date: '2026-05-28', description: 'Rebrand, phase one', client: 'Maple Leaf Legal', category: 'Client work', amount: 6000.0 },
    ],
    expenses: [
      { date: '2026-05-08', description: 'Office supplies, May', vendor: 'Staples', category: 'Office Supplies', amount: 250.0 },
      { date: '2026-05-11', description: 'Hydro and utilities, May', vendor: 'Oshawa Power Ltd.', category: 'Bills Payment', amount: 462.0 },
      { date: '2026-05-14', description: 'Advertising, spring', vendor: 'Toronto Star', category: 'Advertising', amount: 800.0 },
      { date: '2026-05-15', description: 'Fuel and parking, May', vendor: 'Petro-Canada', category: 'Vehicle & Fuel', amount: 78.01 },
      { date: '2026-05-20', description: 'Contractor, May', vendor: 'Bennett Digital', category: 'Contractors Payments', amount: 2400.0 },
      { date: '2026-05-22', description: 'Software subscriptions, May', vendor: 'Adobe Systems', category: 'Software & Subscriptions', amount: 89.99 },
      { date: '2026-05-26', description: 'Bookkeeping, May', vendor: 'Ledger & Co Accountants', category: 'Professional Fees', amount: 400.0 },
    ],
    drawings: [{ date: '2026-05-09', purpose: 'Monthly household transfer', amount: 3000.0 }],
  },
  {
    key: '2026-06',
    income: [
      { date: '2026-06-04', description: 'Consulting, June', client: 'Maple Leaf Legal', category: 'Consulting', amount: 1005.0 },
      { date: '2026-06-15', description: 'Identity refresh', client: 'Bright Path Coaching', category: 'Client work', amount: 2800.0 },
      { date: '2026-06-22', description: 'Monthly retainer', client: 'Oshawa Physio', category: 'Retainers', amount: 3200.0 },
    ],
    expenses: [
      { date: '2026-06-08', description: 'Office supplies, June', vendor: 'Staples', category: 'Office Supplies', amount: 216.75 },
      { date: '2026-06-10', description: 'Hydro and utilities, June', vendor: 'Oshawa Power Ltd.', category: 'Bills Payment', amount: 460.0 },
      { date: '2026-06-14', description: 'Fuel and parking, June', vendor: 'Petro-Canada', category: 'Vehicle & Fuel', amount: 259.43 },
      { date: '2026-06-18', description: 'Contractor, June', vendor: 'Bennett Digital', category: 'Contractors Payments', amount: 2100.0 },
      { date: '2026-06-22', description: 'Software subscriptions, June', vendor: 'Adobe Systems', category: 'Software & Subscriptions', amount: 360.02 },
      { date: '2026-06-25', description: 'Bookkeeping, June', vendor: 'Ledger & Co Accountants', category: 'Professional Fees', amount: 300.0 },
    ],
    drawings: [{ date: '2026-06-12', purpose: 'Monthly household transfer', amount: 2500.0 }],
  },
  {
    /* July is the month income.html and expenses.html publish to the cent, so
       it is the month everything else is checked against. Six of its expenses
       are the ones MISSING_ENTRIES marks as having no receipt behind them.
       They are not extra spending: each sits inside its category's total, and
       July still comes to 3,459.64. Phase 8 attaches receipts to the rest. */
    key: '2026-07',
    income: [
      { date: '2026-07-03', description: 'Consulting, July', client: 'Lakeshore Dental', category: 'Consulting', amount: 1090.0 },
      { date: '2026-07-16', description: 'Coaching site, phase one', client: 'Bright Path Coaching', category: 'Client work', amount: 1800.0 },
      { date: '2026-07-22', description: 'Retainer, July', client: 'Maple Leaf Legal', category: 'Retainers', amount: 3200.0 },
    ],
    expenses: [
      { date: '2026-07-02', description: 'Advert, July', vendor: 'Toronto Star', category: 'Advertising', amount: 281.5 },
      { date: '2026-07-06', description: 'Internet and mobile, July', vendor: 'Rogers Communications', category: 'Bills Payment', amount: 161.0 },
      { date: '2026-07-08', description: 'Pens and labels', vendor: 'Staples', category: 'Office Supplies', amount: 4.25 },
      { date: '2026-07-09', description: 'Design tool, monthly', vendor: 'Figma', category: 'Software & Subscriptions', amount: 24.0 }, // no receipt
      { date: '2026-07-13', description: 'Fuel, July', vendor: 'Petro-Canada', category: 'Vehicle & Fuel', amount: 36.67 },
      { date: '2026-07-15', description: 'Listing, local paper', vendor: 'Toronto Star', category: 'Advertising', amount: 68.5 }, // no receipt
      { date: '2026-07-19', description: 'Mobile top-up', vendor: 'Bell Canada', category: 'Bills Payment', amount: 55.0 }, // no receipt
      { date: '2026-07-22', description: 'Creative Cloud, monthly', vendor: 'Adobe Systems', category: 'Software & Subscriptions', amount: 65.99 },
      { date: '2026-07-23', description: 'Notebooks and folders', vendor: 'Amazon Business', category: 'Office Supplies', amount: 47.0 }, // no receipt
      { date: '2026-07-25', description: 'Front-end build, sprint 4', vendor: 'Bennett Digital', category: 'Contractors Payments', amount: 2400.0 },
      { date: '2026-07-26', description: 'Printer paper and ink', vendor: 'Staples', category: 'Office Supplies', amount: 92.0 }, // no receipt
      { date: '2026-07-27', description: 'Hydro, July', vendor: 'Oshawa Power Ltd.', category: 'Bills Payment', amount: 182.0 },
      { date: '2026-07-30', description: 'Parking, client visit', vendor: 'Green P Toronto', category: 'Vehicle & Fuel', amount: 41.73 }, // no receipt
    ],
    drawings: [
      { date: '2026-07-05', purpose: 'Car insurance renewal', amount: 1000.0 },
      { date: '2026-07-20', purpose: 'Monthly household transfer', amount: 2500.0 },
    ],
  },
  {
    /* August is deliberately a part month, to 9 August, so the dashboard has a
       running period to withhold a comparison on. */
    key: '2026-08',
    income: [
      { date: '2026-08-07', description: 'Discovery workshop', client: 'Northwind Studio', category: 'Workshops and training', amount: 2200.0 },
    ],
    expenses: [
      { date: '2026-08-02', description: 'Internet and mobile', vendor: 'Rogers Communications', category: 'Bills Payment', amount: 138.0 },
      { date: '2026-08-04', description: 'Creative Cloud, monthly', vendor: 'Adobe Systems', category: 'Software & Subscriptions', amount: 89.99 },
      { date: '2026-08-05', description: 'Sprint 5, front end', vendor: 'Bennett Digital', category: 'Contractors Payments', amount: 800.0 },
      { date: '2026-08-06', description: 'Fuel and parking, August', vendor: 'Petro-Canada', category: 'Vehicle & Fuel', amount: 112.01 },
      { date: '2026-08-07', description: 'Office supplies, August', vendor: 'Staples', category: 'Office Supplies', amount: 40.0 },
    ],
    drawings: [],
  },
];

/* ----------------------------------------------------------- the invoices --- */

type SeedInvoice = {
  number: number;
  client: string;
  issueDate: string;
  paymentTermsDays: number;
  lines: { description: string; quantity: number; unitPrice: number }[];
  notes?: string;
  /* A draft is never sent, so it takes no payment and owes nothing. */
  draft?: boolean;
  payment?: { date: string; amount: number; method: 'BANK_TRANSFER' | 'E_TRANSFER'; reference: string };
};

/* 0038 and 0040 are missing from the sequence on purpose: the mockup has the
   gap, and a number that was taken is never handed out again. They are simply
   never issued, which is what the counter jumping over them means. */
const INVOICES: SeedInvoice[] = [
  {
    number: 37,
    client: 'Northwind Studio',
    issueDate: '2026-06-12',
    paymentTermsDays: 14,
    lines: [
      { description: 'Support and hosting, June', quantity: 1, unitPrice: 600.0 },
      { description: 'SEO audit and report', quantity: 1, unitPrice: 2500.0 },
    ],
    payment: { date: '2026-06-26', amount: 3503.0, method: 'BANK_TRANSFER', reference: 'BT-38402' },
  },
  {
    number: 39,
    client: 'Lakeshore Dental',
    issueDate: '2026-07-11',
    paymentTermsDays: 14,
    lines: [
      { description: 'Brand workshop, one day', quantity: 1, unitPrice: 1800.0 },
      { description: 'Workshop materials and printing', quantity: 1, unitPrice: 480.0 },
    ],
  },
  {
    number: 41,
    client: 'Oshawa Physio',
    issueDate: '2026-07-07',
    paymentTermsDays: 14,
    lines: [{ description: 'Monthly support and hosting', quantity: 1, unitPrice: 950.0 }],
    payment: { date: '2026-07-21', amount: 1073.5, method: 'BANK_TRANSFER', reference: 'BT-39877' },
  },
  {
    number: 42,
    client: 'Northwind Studio',
    issueDate: '2026-07-14',
    paymentTermsDays: 14,
    lines: [{ description: 'Website retainer, August', quantity: 1, unitPrice: 4500.0 }],
    payment: { date: '2026-07-28', amount: 5085.0, method: 'BANK_TRANSFER', reference: 'BT-40219' },
  },
  {
    number: 43,
    client: 'Bright Path Coaching',
    issueDate: '2026-08-08',
    paymentTermsDays: 20,
    lines: [
      { description: 'Logo and identity, phase one', quantity: 1, unitPrice: 1800.0 },
      { description: 'Stationery design', quantity: 1, unitPrice: 450.0 },
    ],
  },
  {
    number: 44,
    client: 'Maple Leaf Legal',
    issueDate: '2026-07-30',
    paymentTermsDays: 15,
    lines: [
      { description: 'Staff training, on site', quantity: 2, unitPrice: 1200.0 },
      { description: 'Training materials and printing', quantity: 1, unitPrice: 600.0 },
    ],
  },
  {
    number: 45,
    client: 'Northwind Studio',
    issueDate: '2026-08-05',
    paymentTermsDays: 15,
    lines: [
      { description: 'Website retainer, September', quantity: 1, unitPrice: 4500.0 },
      { description: 'Additional landing page', quantity: 8, unitPrice: 125.0 },
    ],
  },
  {
    number: 46,
    client: 'Oshawa Physio',
    issueDate: '2026-08-01',
    paymentTermsDays: 30,
    lines: [
      { description: 'Website care plan, August', quantity: 1, unitPrice: 500.0 },
      { description: 'Booking system integration', quantity: 12, unitPrice: 125.0 },
      { description: 'Content updates', quantity: 4, unitPrice: 125.0 },
    ],
    /* The part payment. 1,378.60 of a 2,825.00 invoice carries 158.60 of the
       invoice's own tax with it, so the parts add back up to the whole. */
    payment: { date: '2026-08-03', amount: 1378.6, method: 'E_TRANSFER', reference: 'ET-88214' },
  },
  {
    number: 47,
    client: 'Bright Path Coaching',
    issueDate: '2026-08-09',
    paymentTermsDays: 30,
    lines: [{ description: 'Brand guidelines, phase two', quantity: 1, unitPrice: 1200.0 }],
    notes: 'Second phase, not yet sent',
    draft: true,
  },
];

/* --------------------------------------------------- the published figures --- */

/* Straight from MONTHS in dash-data.js, before tax. The seed refuses to
   finish if what it wrote does not read back as this. */
const PUBLISHED: Record<string, { income: number; expenses: number; drawings: number }> = {
  '2026-01': { income: 9200.0, expenses: 3050.0, drawings: 2500.0 },
  '2026-02': { income: 8750.0, expenses: 2880.0, drawings: 2500.0 },
  '2026-03': { income: 12400.0, expenses: 4120.0, drawings: 3000.0 },
  '2026-04': { income: 10150.0, expenses: 3340.0, drawings: 2500.0 },
  '2026-05': { income: 13600.0, expenses: 4480.0, drawings: 3000.0 },
  '2026-06': { income: 10105.0, expenses: 3696.2, drawings: 2500.0 },
  '2026-07': { income: 11540.0, expenses: 3459.64, drawings: 3500.0 },
  '2026-08': { income: 3420.0, expenses: 1180.0, drawings: 0.0 },
};

/* The unpaid balance of every issued invoice, which is what the dashboard and
   the invoice list both call owed to you. */
const PUBLISHED_OUTSTANDING = 16170.3;

/* -------------------------------------------------------------- the build --- */

const date = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const money = (cents: number): string => (cents / 100).toFixed(2);

/* Removed and rebuilt rather than merged. The ledger is append only, so there
   is no way to correct seeded rows in place, and a second run that added a
   second copy of every entry would double every figure on the dashboard. */
async function wipe(): Promise<void> {
  const existing = await prisma.business.findUnique({ where: { id: BUSINESS_ID } });
  if (!existing) return;

  /* In dependency order. Transactions reference categories, vendors and
     clients with ON DELETE RESTRICT, which is right for real data and means
     the rows have to come out from the inside. */
  await prisma.invoicePayment.deleteMany({ where: { businessId: BUSINESS_ID } });
  await prisma.transaction.deleteMany({ where: { businessId: BUSINESS_ID } });
  await prisma.invoice.deleteMany({ where: { businessId: BUSINESS_ID } });
  await prisma.client.deleteMany({ where: { businessId: BUSINESS_ID } });
  await prisma.vendor.deleteMany({ where: { businessId: BUSINESS_ID } });
  await prisma.category.deleteMany({ where: { businessId: BUSINESS_ID } });
  await prisma.business.delete({ where: { id: BUSINESS_ID } });
  console.log('Removed the previous seed.');
}

async function createBusiness(): Promise<{ businessId: string; userId: string }> {
  /* The subscription and the starting categories are created with the
     business, in one transaction, exactly as signup does it. An account with
     no subscription row cannot be told whether it may write, and would open
     read only. */
  const business = await prisma.business.create({
    data: {
      id: BUSINESS_ID,
      name: 'Maple Ridge Consulting',
      legalName: 'Maple Ridge Consulting',
      businessType: 'SOLE_PROPRIETOR',
      gstHstNumber: '123456789 RT0001',
      gstRegistered: true,
      addressLine1: '118 Simcoe Street, Suite 400',
      city: 'Toronto',
      province: 'ON',
      postalCode: 'M5H 3G4',
      email: OWNER_EMAIL,
      phone: '416 555 0148',
      invoicePrefix: 'INV-',
      nextInvoiceNumber: 37,
      paymentTermsDays: 30,
      invoiceTerms: 'Payment due within 30 days of the invoice date.',
      invoiceFooter:
        'Thank you for your business. Interest of 2% per month is charged on overdue accounts.',
      subscription: { create: trialCreateData() },
      categories: { create: defaultCategories() },
    },
  });

  const user = await prisma.user.create({
    data: {
      businessId: business.id,
      email: OWNER_EMAIL,
      passwordHash: await hashPassword(OWNER_PASSWORD),
      firstName: 'Sarah',
      lastName: 'Whitfield',
      role: 'OWNER',
      platformRole: 'CUSTOMER',
      emailVerifiedAt: new Date(),
    },
  });

  return { businessId: business.id, userId: user.id };
}

async function main(): Promise<void> {
  /* A seed removes and rewrites a whole business. That is right on a
     development branch and unthinkable anywhere else. */
  if (env.NODE_ENV === 'production') {
    throw new Error('The seed rewrites a business from scratch. It does not run in production.');
  }

  await wipe();
  const ctx = await createBusiness();
  console.log('Maple Ridge Consulting created, with its trial and starting categories.');

  /* Names to ids, once, so the tables above can read as the mockup reads. */
  const categories = await prisma.category.findMany({ where: { businessId: ctx.businessId } });
  const categoryId = (name: string): string => {
    const found = categories.find((c) => c.name === name);
    if (!found) throw new Error(`No category called ${name}. The starting list has changed.`);
    return found.id;
  };
  const drawingsCategoryId = (() => {
    const found = categories.find((c) => c.kind === 'DRAWINGS');
    if (!found) throw new Error('No Owner Drawings category.');
    return found.id;
  })();

  const vendorId = new Map<string, string>();
  for (const vendor of VENDORS) {
    vendorId.set(
      vendor.name,
      await settings.createVendor(ctx.businessId, {
        name: vendor.name,
        categoryId: categoryId(vendor.category),
      }),
    );
  }

  const clientId = new Map<string, string>();
  for (const client of CLIENTS) {
    const { since, ...fields } = client;
    const created = await clients.create(ctx.businessId, {
      ...fields,
      addressLine2: null,
      paymentTermsDays: null,
      notes: null,
    });
    clientId.set(client.name, created.id);
    /* When they came on board, which the client screen shows. Not money and
       not a ledger row, and the service has no other way to say it. */
    await prisma.client.update({ where: { id: created.id }, data: { createdAt: date(since) } });
  }
  console.log(`${VENDORS.length} vendors and ${CLIENTS.length} clients created.`);

  /* Every entry through modules/transactions, which is the same path the
     income, expenses and drawings screens take. */
  let written = 0;
  for (const month of MONTHS) {
    for (const row of month.income) {
      await transactions.create(ctx, 'INCOME', {
        date: date(row.date),
        amount: row.amount,
        description: row.description,
        categoryId: categoryId(row.category),
        clientId: clientId.get(row.client) ?? null,
        reference: null,
        /* The table holds figures before tax, which is how work is quoted. */
        taxMode: 'ADD',
      });
      written += 1;
    }
    for (const row of month.expenses) {
      await transactions.create(ctx, 'EXPENSE', {
        date: date(row.date),
        amount: row.amount,
        description: row.description,
        categoryId: categoryId(row.category),
        vendorId: vendorId.get(row.vendor) ?? null,
        reference: null,
        taxMode: 'ADD',
      });
      written += 1;
    }
    for (const row of month.drawings) {
      await transactions.create(ctx, 'DRAWING', {
        date: date(row.date),
        amount: row.amount,
        description: 'Owner drawing',
        categoryId: drawingsCategoryId,
        purpose: row.purpose,
        reference: null,
      });
      written += 1;
    }
    console.log(`  ${month.key}: ${month.income.length + month.expenses.length + month.drawings.length} entries`);
  }
  console.log(`${written} entries written through the ledger.`);

  for (const seed of INVOICES) {
    /* The number is taken from the business counter, so it is moved to the
       one this invoice should have and the service does the rest. 0038 and
       0040 are stepped over and stay unissued. */
    await prisma.business.update({
      where: { id: ctx.businessId },
      data: { nextInvoiceNumber: seed.number },
    });

    const client = clientId.get(seed.client);
    if (!client) throw new Error(`No client called ${seed.client}.`);

    const invoice = await invoices.create(ctx, {
      clientId: client,
      issueDate: date(seed.issueDate),
      paymentTermsDays: seed.paymentTermsDays,
      lines: seed.lines,
      discountMode: 'AMOUNT',
      discountValue: 0,
      chargeTax: true,
      notes: seed.notes ?? null,
    });

    if (seed.draft) {
      console.log(`  ${invoice.number} ${money(invoice.totalCents)} draft`);
      continue;
    }

    const sent = await invoices.send(ctx.businessId, invoice.id);

    if (seed.payment) {
      /* Income is posted HERE, by the payment, and nowhere else. One linked
         entry, carrying a proportional share of this invoice's own tax. */
      const paid = await payments.record(ctx, invoice.id, {
        date: date(seed.payment.date),
        amount: seed.payment.amount,
        method: seed.payment.method,
        reference: seed.payment.reference,
      });
      console.log(
        `  ${invoice.number} ${money(invoice.totalCents)} ${paid.status}, paid ${money(paid.paidCents)}`,
      );
    } else {
      /* The status is derived, so an unpaid invoice reads sent or overdue
         depending on the day this runs. It is printed rather than assumed. */
      console.log(`  ${invoice.number} ${money(invoice.totalCents)} ${sent.status}`);
    }
  }

  /* The counter now points at the next number nobody has used. */
  await prisma.business.update({
    where: { id: ctx.businessId },
    data: { nextInvoiceNumber: 48 },
  });

  await verify(ctx.businessId);
}

/* Read back through the same derivation the dashboard uses, and refuse to
   finish if a month is a cent away from what the client reviewed. */
async function verify(businessId: string): Promise<void> {
  console.log('\nAgainst the published figures, to the cent:');
  console.log('  month      income            expenses          drawings');

  let wrong = 0;
  for (const [key, published] of Object.entries(PUBLISHED)) {
    const [year, month] = key.split('-').map(Number);
    const from = new Date(Date.UTC(year!, month! - 1, 1));
    const to = new Date(Date.UTC(year!, month!, 0));
    const figures = await derive(businessId, { from, to });

    const rows: [string, number, number][] = [
      ['income', figures.income.subtotalCents, toCents(published.income)],
      ['expenses', figures.expenses.subtotalCents, toCents(published.expenses)],
      ['drawings', figures.drawings.totalCents, toCents(published.drawings)],
    ];
    const bad = rows.filter(([, got, want]) => got !== want);
    wrong += bad.length;

    console.log(
      `  ${key}   ` +
        rows
          .map(([, got, want]) => `${money(got).padStart(9)} ${got === want ? ' ' : `!= ${money(want)}`}`.padEnd(18))
          .join(''),
    );
  }

  const list = await invoices.list(businessId, { page: 1, perPage: 100, status: 'all' });
  const outstanding = list.summary.owedCents;
  const wantOutstanding = toCents(PUBLISHED_OUTSTANDING);
  if (outstanding !== wantOutstanding) wrong += 1;

  console.log(
    `\n  invoices: ${list.counts.all}   outstanding ${money(outstanding)}` +
      (outstanding === wantOutstanding ? '  matches the mockup' : `  != ${money(wantOutstanding)}`),
  );

  if (wrong > 0) {
    throw new Error(`${wrong} figure(s) do not match the published data. The seed is wrong.`);
  }

  console.log(`\nSeeded. Sign in as ${OWNER_EMAIL} with ${OWNER_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
