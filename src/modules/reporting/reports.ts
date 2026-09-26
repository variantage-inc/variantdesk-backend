import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../middleware/error.js';
import { addressOf } from '../invoices/invoices.service.js';
import { derive, invoiceLedger, monthsBetween, type InvoiceLedger, type MonthRow } from './derive.js';

/* The seven reports.

   This file LAYS OUT figures. It does not work any of them out. Every number
   below comes from `derive.ts`, which is also what the dashboard reads, so a
   report can never disagree with the screen it came from. If arithmetic ever
   starts appearing here, the rule has been broken and the two will drift.

   Each report is built as a DOCUMENT rather than as HTML: a heading, some
   cards, some notices, some tables. Three things then render that one
   document, and they stay in step because there is only one of it:

     the screen        components/reports/report-sheet.tsx
     the PDF           pdf.ts, through PDFKit
     the spreadsheet   xlsx.ts, through ExcelJS

   The alternative, writing each report three times, is twenty-one layouts to
   keep in agreement, and the export was the part the client called very
   important. It would be the first thing to go stale.

   Money is cents throughout and stays cents all the way into the renderers, so
   the spreadsheet gets real numbers somebody can sum rather than strings that
   look like numbers. */

/* ------------------------------------------------------------ the document --- */

export type Tone = 'in' | 'out' | 'draw' | 'muted';

export type Cell = {
  /* Exactly one of these three carries the value. Cents so that a spreadsheet
     can total the column, a percent so the renderer can choose its own
     precision, and text for everything that is not a figure. */
  cents?: number;
  percent?: number;
  text?: string;
  /* A second line under the value, the way the invoice tables show how late
     something is. */
  sub?: string;
  subTone?: 'late';
  strong?: boolean;
  tone?: Tone;
  align?: 'right';
  /* Proportional bars, 0 to 1 of the widest row in the column. Worked out here
     because the renderer should not have to scan the table to find the
     largest. Ignored by the spreadsheet, which has its own. */
  bars?: { share: number; tone: Tone }[];
  pill?: { label: string; cls: string };
};

export type Table = {
  title: string;
  columns: { label: string; align?: 'right'; width?: string }[];
  rows: { cells: Cell[]; tone?: 'draw' }[];
  foot?: Cell[];
};

export type Kpi = {
  label: string;
  cents?: number;
  text?: string;
  note?: string;
  tone?: 'in' | 'out' | 'draw';
  /* Never present for a period that has not finished. That rule lives in
     derive.ts, which withholds the previous period entirely, so there is
     nothing here to accidentally render. */
  delta?: { percent: number; label: string };
};

export type Note = {
  tone: 'info' | 'warn' | 'ok' | 'draw';
  icon: string;
  title: string;
  body: string;
};

export type ReportDoc = {
  id: ReportId;
  name: string;
  blurb: string;
  period: {
    from: string;
    to: string;
    /* "July 2026", "Q3 2026", "2026", or the range itself. */
    label: string;
    rangeLabel: string;
    complete: boolean;
    totalDays: number;
    elapsedDays: number;
    /* False on the invoice report, which is a position today rather than a
       total for a range, and says so on its face. */
    scoped: boolean;
  };
  basis: string | null;
  seller: {
    name: string;
    address: string | null;
    email: string | null;
    phone: string | null;
    gstHstNumber: string | null;
    gstRegistered: boolean;
  };
  preparedOn: string;
  currency: string;
  dateFormat: string;
  taxLabel: string;
  kpis: Kpi[];
  notes: Note[];
  tables: Table[];
  footnote: string;
};

/* ---------------------------------------------------------------- the list --- */

export const REPORTS = [
  {
    id: 'income',
    icon: 'income',
    name: 'Income',
    blurb: 'What came in, month by month, and the tax you collected on it.',
  },
  {
    id: 'expenses',
    icon: 'expense',
    name: 'Expenses',
    blurb: 'What went out, by category, and the tax you can claim back.',
  },
  {
    id: 'profit',
    icon: 'chart',
    name: 'Profit summary',
    blurb: 'Income less expenses. Owner drawings are not in it.',
  },
  {
    id: 'tax',
    icon: 'shield',
    name: 'GST/HST summary',
    blurb: 'Collected, paid, and what is owed either way.',
  },
  {
    id: 'invoices',
    icon: 'invoice',
    name: 'Invoices',
    blurb: 'Issued, settled, still owed and overdue.',
  },
  {
    id: 'drawings',
    icon: 'wallet',
    name: 'Owner drawings',
    blurb: 'What you took out, and what is left in the business.',
  },
  {
    id: 'cashflow',
    icon: 'wave',
    name: 'Cash flow',
    blurb: 'Everything in against everything out, drawings included.',
  },
] as const;

export type ReportId = (typeof REPORTS)[number]['id'];

export const isReportId = (v: string): v is ReportId =>
  REPORTS.some((r) => r.id === v);

/* ------------------------------------------------------------- small helpers --- */

const money = (cents: number): string =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);

const slash = (iso: string): string => iso.replace(/-/g, '/');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const isFirstOfMonth = (d: Date): boolean => d.getUTCDate() === 1;
const isLastOfMonth = (d: Date): boolean =>
  d.getUTCDate() === new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/* What to call a range.

   Worked out from the dates rather than sent by the browser, because the PDF
   has to be able to title itself and a file that says "2026/07/01 to
   2026/07/31" where a person would say "July 2026" reads as machine output. */
export function labelFor(from: Date, to: Date): string {
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();

  if (isFirstOfMonth(from) && isLastOfMonth(to) && sameYear) {
    const first = from.getUTCMonth();
    const last = to.getUTCMonth();

    if (first === last) return `${MONTH_NAMES[first]} ${from.getUTCFullYear()}`;
    if (first === 0 && last === 11) return String(from.getUTCFullYear());
    if (first % 3 === 0 && last === first + 2) {
      return `Q${first / 3 + 1} ${from.getUTCFullYear()}`;
    }
  }

  return `${slash(from.toISOString().slice(0, 10))} to ${slash(to.toISOString().slice(0, 10))}`;
}

/* A percentage change, or null when there is nothing to change from. Dividing
   by a previous period of zero would print Infinity, which is not a fact about
   the business. */
const changeOf = (now: number, before: number): number | null =>
  before === 0 ? null : ((now - before) / Math.abs(before)) * 100;

const shareOf = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100);

const cash = (cents: number, extra: Partial<Cell> = {}): Cell => ({
  cents,
  align: 'right',
  ...extra,
});

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------- the builder --- */

type Built = {
  derived: Awaited<ReturnType<typeof derive>>;
  months: MonthRow[];
  /* Only the invoice report reads this, and it is the one query here that
     loads every invoice a business has ever raised, so the other six do not
     pay for it. Null rather than cast away: a report that reads it without
     asking for it should be a compile error, not a crash. */
  invoices: InvoiceLedger | null;
  compare: boolean;
  basis: string | null;
};

/* Gathered once, then handed to whichever report was asked for.

   Every read comes from the same place `GET /api/dashboard` reads. A report
   opens a few queries it does not use, because `derive` answers the whole
   dashboard; that is the price of the guarantee that a report is looking at
   exactly the arithmetic the dashboard is, and it is worth paying. */
async function gather(
  businessId: string,
  id: ReportId,
  from: Date,
  to: Date,
  compare: boolean,
): Promise<Built> {
  const [derived, months, invoices] = await Promise.all([
    derive(businessId, { from, to }),
    monthsBetween(businessId, from, to),
    id === 'invoices' ? invoiceLedger(businessId) : null,
  ]);

  const basis = derived.previous
    ? labelFor(new Date(derived.previous.from), new Date(derived.previous.to))
    : null;

  return { derived, months, invoices, compare: compare && basis !== null, basis };
}

/* The comparison line under a headline figure. One place decides whether it is
   printed at all, so no report can accidentally show one. */
function deltaFor(b: Built, now: number, before: number | undefined): Kpi['delta'] {
  if (!b.compare || before === undefined || !b.basis) return undefined;
  const percent = changeOf(now, before);
  return percent === null ? undefined : { percent, label: `against ${b.basis}` };
}

function runningNote(b: Built): Note[] {
  const { period } = b.derived;
  if (period.complete) return [];
  return [
    {
      tone: 'info',
      icon: 'info',
      title: 'This period has not finished',
      body:
        `It is ${period.elapsedDays} of ${period.totalDays} days in, so it is being ` +
        'measured against a shorter span than a completed one. No percentage comparison ' +
        'is shown, because a part finished period always reads as a fall next to a whole one.',
    },
  ];
}

/* Each month of the period, with the bar shares already worked out. */
const widest = (values: number[]): number => Math.max(0, ...values);

/* ================================================================= 1. income --- */

function rIncome(b: Built): Pick<ReportDoc, 'kpis' | 'notes' | 'tables' | 'footnote'> {
  const { income } = b.derived;
  const max = widest(b.months.map((m) => m.incomeCents));
  const perMonth = b.months.length ? Math.round(income.subtotalCents / b.months.length) : 0;

  return {
    kpis: [
      {
        label: 'Income, before tax',
        cents: income.subtotalCents,
        tone: 'in',
        note: plural(income.count, 'entry', 'entries'),
        delta: deltaFor(b, income.subtotalCents, b.derived.previous?.income.subtotalCents),
      },
      {
        label: `${b.derived.tax.label.split(' ')[0]} collected on it`,
        cents: income.taxCents,
        note: 'Held for the CRA, not earnings',
      },
      {
        label: 'Invoiced in total',
        cents: income.totalCents,
        note: 'What clients were actually billed',
      },
      {
        label: 'Average a month',
        cents: perMonth,
        note: `Across ${plural(b.months.length, 'month')}`,
      },
    ],
    notes: runningNote(b),
    tables: [
      {
        title: 'Month by month',
        columns: [
          { label: 'Month' },
          { label: '', width: '34%' },
          { label: 'Income', align: 'right' },
          { label: `${b.derived.tax.label.split(' ')[0]} collected`, align: 'right' },
          { label: 'Total invoiced', align: 'right' },
        ],
        rows: b.months.map((m) => ({
          cells: [
            { text: `${m.label} ${m.year}`, strong: true },
            { bars: [{ share: max ? m.incomeCents / max : 0, tone: 'in' }] },
            cash(m.incomeCents, { tone: 'in' }),
            cash(m.incomeTaxCents),
            cash(m.incomeCents + m.incomeTaxCents, { strong: true }),
          ],
        })),
        foot: [
          { text: 'Total' },
          {},
          cash(income.subtotalCents, { tone: 'in' }),
          cash(income.taxCents),
          cash(income.totalCents),
        ],
      },
    ],
    footnote:
      'Income is shown before tax. The tax column is money collected on behalf of the CRA ' +
      'and is never counted as earnings. Income from an invoice is recorded when the ' +
      'payment arrives, not when the invoice is sent.',
  };
}

/* =============================================================== 2. expenses --- */

function rExpenses(b: Built): Pick<ReportDoc, 'kpis' | 'notes' | 'tables' | 'footnote'> {
  const { expenses, drawings, byCategory } = b.derived;
  const max = widest(byCategory.map((c) => c.cents));

  return {
    kpis: [
      {
        label: 'Business expenses',
        cents: expenses.subtotalCents,
        tone: 'out',
        note: plural(expenses.count, 'entry', 'entries'),
        delta: deltaFor(b, expenses.subtotalCents, b.derived.previous?.expenses.subtotalCents),
      },
      {
        label: `${b.derived.tax.label.split(' ')[0]} paid, claimable back`,
        cents: expenses.taxCents,
        note: 'Input tax credit against what you collected',
      },
      {
        label: 'Categories used',
        text: String(byCategory.length),
        note: `Largest is ${byCategory[0]?.name ?? 'none yet'}`,
      },
      {
        label: 'Owner drawings, excluded',
        cents: drawings.totalCents,
        tone: 'draw',
        note: 'Reported separately, never an expense',
      },
    ],
    notes: runningNote(b),
    tables: [
      {
        title: 'By category',
        columns: [
          { label: 'Category' },
          { label: '', width: '30%' },
          { label: 'Amount', align: 'right' },
          { label: 'Share', align: 'right' },
          { label: `${b.derived.tax.label.split(' ')[0]} paid`, align: 'right' },
        ],
        rows: byCategory.map((c) => ({
          cells: [
            { text: c.name, strong: true },
            { bars: [{ share: max ? c.cents / max : 0, tone: 'out' }] },
            cash(c.cents, { tone: 'out' }),
            { percent: c.shareBp / 100, align: 'right' },
            cash(c.taxCents),
          ],
        })),
        foot: [
          { text: 'Total' },
          {},
          cash(expenses.subtotalCents, { tone: 'out' }),
          { percent: byCategory.length ? 100 : 0, align: 'right' },
          cash(expenses.taxCents),
        ],
      },
      {
        title: 'Month by month',
        columns: [
          { label: 'Month' },
          { label: 'Business expenses', align: 'right' },
          { label: `${b.derived.tax.label.split(' ')[0]} paid`, align: 'right' },
        ],
        rows: b.months.map((m) => ({
          cells: [
            { text: `${m.label} ${m.year}`, strong: true },
            cash(m.expensesCents, { tone: 'out' }),
            cash(m.expensesTaxCents),
          ],
        })),
        foot: [{ text: 'Total' }, cash(expenses.subtotalCents, { tone: 'out' }), cash(expenses.taxCents)],
      },
    ],
    footnote:
      'Owner drawings are deliberately absent from every figure above. They have their own ' +
      'report. Tax is the amount actually charged on each entry, not a rate applied to the ' +
      'total, so a purchase made at a different rate is still counted at the rate it was charged.',
  };
}

/* ================================================================= 3. profit --- */

function rProfit(b: Built): Pick<ReportDoc, 'kpis' | 'notes' | 'tables' | 'footnote'> {
  const { income, expenses, drawings, netProfitCents, previous } = b.derived;
  const margin = shareOf(netProfitCents, income.subtotalCents);

  return {
    kpis: [
      {
        label: 'Income',
        cents: income.subtotalCents,
        tone: 'in',
        note: 'Before tax',
        delta: deltaFor(b, income.subtotalCents, previous?.income.subtotalCents),
      },
      {
        label: 'Expenses',
        cents: expenses.subtotalCents,
        tone: 'out',
        note: 'Before tax, drawings excluded',
        delta: deltaFor(b, expenses.subtotalCents, previous?.expenses.subtotalCents),
      },
      {
        label: 'Profit',
        cents: netProfitCents,
        note: 'Income less expenses',
        delta: deltaFor(b, netProfitCents, previous?.netProfitCents),
      },
      {
        label: 'Kept from every dollar',
        text: `${margin.toFixed(1)}%`,
        note: 'Profit as a share of income',
      },
    ],
    notes: [
      ...runningNote(b),
      {
        tone: 'info',
        icon: 'info',
        title: 'Profit is income less expenses, nothing else',
        body:
          `The ${money(drawings.totalCents)} taken out as owner drawings in this period is ` +
          'not in the figure above, and never will be. Drawings are the owner paying ' +
          'themselves out of profit that has already been earned, not a cost of running the business.',
      },
    ],
    tables: [
      {
        title: 'Month by month',
        columns: [
          { label: 'Month' },
          { label: 'Income', align: 'right' },
          { label: 'Expenses', align: 'right' },
          { label: 'Profit', align: 'right' },
        ],
        rows: b.months.map((m) => ({
          cells: [
            { text: `${m.label} ${m.year}`, strong: true },
            cash(m.incomeCents, { tone: 'in' }),
            cash(m.expensesCents, { tone: 'out' }),
            cash(m.incomeCents - m.expensesCents, { strong: true }),
          ],
        })),
        foot: [
          { text: 'Total' },
          cash(income.subtotalCents, { tone: 'in' }),
          cash(expenses.subtotalCents, { tone: 'out' }),
          cash(netProfitCents),
        ],
      },
    ],
    footnote:
      'All figures are before tax. GST/HST is neither income nor an expense: it is money in ' +
      'transit to or from the CRA, and it is reported on its own.',
  };
}

/* ==================================================================== 4. tax --- */

function rTax(b: Built): Pick<ReportDoc, 'kpis' | 'notes' | 'tables' | 'footnote'> {
  const { income, expenses, taxOwedCents, tax, gstRegistered } = b.derived;
  const owes = taxOwedCents >= 0;
  const short = tax.label.split(' ')[0];

  const notes: Note[] = [...runningNote(b)];

  /* A business that is not registered does not charge the tax and cannot claim
     it back, so a report full of zeroes would be true and misleading. Say why. */
  if (!gstRegistered) {
    notes.push({
      tone: 'info',
      icon: 'info',
      title: 'This business is not registered for GST/HST',
      body:
        'Registration is turned off in Settings, so nothing is being charged on sales and ' +
        'nothing can be claimed back on purchases. Registration becomes compulsory at ' +
        '$30,000 of revenue over four consecutive quarters.',
    });
  } else if (taxOwedCents === 0) {
    /* Zero either way, which happens in a quiet month and in an empty one.
       "Set aside $0.00" reads as a broken sentence rather than as good news. */
    notes.push({
      tone: 'ok',
      icon: 'shield',
      title: 'Nothing to settle for this period',
      body:
        `The ${short} you collected and the ${short} you paid come to the same figure, so ` +
        'nothing changes hands when you file for this period.',
    });
  } else {
    notes.push({
      tone: owes ? 'warn' : 'ok',
      icon: 'shield',
      title: owes
        ? `Set aside ${money(taxOwedCents)} for the CRA`
        : `A refund of ${money(Math.abs(taxOwedCents))} is due to you`,
      body:
        `You collected ${money(income.taxCents)} in ${short} on your sales and paid ` +
        `${money(expenses.taxCents)} on your purchases. The difference is what changes ` +
        'hands when you file.' +
        (owes ? " It is not your money: it is being held on the CRA's behalf." : ''),
    });
  }

  return {
    kpis: [
      {
        label: `${short} collected on sales`,
        cents: income.taxCents,
        note: `On ${money(income.subtotalCents)} invoiced`,
      },
      {
        label: `${short} paid on purchases`,
        cents: expenses.taxCents,
        note: `On ${money(expenses.subtotalCents)} spent`,
      },
      {
        label: owes ? 'You owe the CRA' : 'The CRA owes you',
        cents: Math.abs(taxOwedCents),
        tone: owes ? 'out' : 'in',
        note: owes
          ? 'Collected, less what you can claim back'
          : 'You paid more tax than you collected',
      },
    ],
    notes,
    tables: [
      {
        title: 'Month by month',
        columns: [
          { label: 'Month' },
          { label: 'Sales', align: 'right' },
          { label: 'Collected', align: 'right' },
          { label: 'Purchases', align: 'right' },
          { label: 'Paid', align: 'right' },
          { label: 'Net', align: 'right' },
        ],
        rows: b.months.map((m) => ({
          cells: [
            { text: `${m.label} ${m.year}`, strong: true },
            cash(m.incomeCents),
            cash(m.incomeTaxCents, { tone: 'in' }),
            cash(m.expensesCents),
            cash(m.expensesTaxCents, { tone: 'out' }),
            cash(m.incomeTaxCents - m.expensesTaxCents, { strong: true }),
          ],
        })),
        foot: [
          { text: 'Total' },
          cash(income.subtotalCents),
          cash(income.taxCents, { tone: 'in' }),
          cash(expenses.subtotalCents),
          cash(expenses.taxCents, { tone: 'out' }),
          cash(taxOwedCents),
        ],
      },
    ],
    footnote:
      'Owner drawings carry no input tax credit and are excluded from the purchases column. ' +
      'Each figure is the tax actually charged on the entries, stored on them at the rate ' +
      'that applied on the day. Variantage prepares these figures; it does not file the return.',
  };
}

/* =============================================================== 5. invoices --- */

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'p-draft' },
  sent: { label: 'Sent', cls: 'p-sent' },
  part: { label: 'Partially paid', cls: 'p-part' },
  overdue: { label: 'Overdue', cls: 'p-late' },
  paid: { label: 'Paid', cls: 'p-paid' },
};

function rInvoices(b: Built): Pick<ReportDoc, 'kpis' | 'notes' | 'tables' | 'footnote'> {
  const inv = b.invoices;
  if (!inv) throw new Error('The invoice report was built without the invoice ledger.');

  return {
    kpis: [
      {
        label: 'Invoiced in total',
        cents: inv.billedCents,
        note: `${plural(inv.issued.length, 'invoice')} issued, tax included`,
      },
      {
        label: 'Received',
        cents: inv.receivedCents,
        tone: 'in',
        note: 'Payments recorded against them',
      },
      {
        label: 'Still owed to you',
        cents: inv.outstandingCents,
        note: `Across ${plural(inv.open.length, 'open invoice')}`,
      },
      {
        label: 'Overdue',
        cents: inv.overdueCents,
        tone: 'out',
        note: `${plural(inv.overdueCount, 'invoice')} past the due date`,
      },
    ],
    notes: [
      {
        tone: 'info',
        icon: 'info',
        title: 'This report covers every invoice, not just the chosen period',
        body:
          'An invoice raised in June and still unpaid in September is money you are owed ' +
          'today, so limiting it to a date range would hide the debts that matter most.',
      },
    ],
    tables: [
      {
        title: 'By status',
        columns: [
          { label: 'Status' },
          { label: 'Invoices', align: 'right' },
          { label: 'Value', align: 'right' },
          { label: 'Received', align: 'right' },
          { label: 'Outstanding', align: 'right' },
        ],
        rows: inv.byStatus.map((g) => ({
          cells: [
            { pill: STATUS_PILL[g.status] ?? { label: g.status, cls: 'p-sent' } },
            { text: String(g.count), align: 'right' },
            cash(g.totalCents),
            g.paidCents ? cash(g.paidCents, { tone: 'in' }) : { text: '—', align: 'right', tone: 'muted' },
            g.outstandingCents
              ? cash(g.outstandingCents, { strong: true })
              : { text: '—', align: 'right', tone: 'muted' },
          ],
        })),
        foot: [
          { text: `${plural(inv.all.length, 'invoice')} in total` },
          {},
          cash(inv.billedCents + inv.draftCents),
          cash(inv.receivedCents, { tone: 'in' }),
          cash(inv.outstandingCents),
        ],
      },
      {
        title: 'Still owed to you',
        columns: [
          { label: 'Invoice' },
          { label: 'Client' },
          { label: 'Due' },
          { label: 'Status' },
          { label: 'Total', align: 'right' },
          { label: 'Outstanding', align: 'right' },
        ],
        rows: inv.open.map((i) => ({
          cells: [
            { text: i.number, strong: true },
            { text: i.client.name },
            {
              text: slash(i.dueDate),
              sub:
                i.daysToDue < 0
                  ? `${Math.abs(i.daysToDue)} days late`
                  : i.daysToDue === 0
                    ? 'due today'
                    : `in ${i.daysToDue} days`,
              subTone: i.daysToDue < 0 ? 'late' : undefined,
            },
            { pill: STATUS_PILL[i.status] ?? { label: i.status, cls: 'p-sent' } },
            cash(i.totalCents),
            cash(i.balanceCents, { strong: true }),
          ],
        })),
        foot: [
          { text: `${plural(inv.open.length, 'open invoice')}` },
          {},
          {},
          {},
          {},
          cash(inv.outstandingCents),
        ],
      },
    ],
    footnote:
      'Status is worked out from the payments and the due date, never stored, so it cannot ' +
      'drift away from the money underneath it. A draft is not a debt and is excluded from ' +
      'what you are owed. A voided invoice keeps its number and is not shown.',
  };
}

/* =============================================================== 6. drawings --- */

function rDrawings(b: Built): Pick<ReportDoc, 'kpis' | 'notes' | 'tables' | 'footnote'> {
  const { drawings, netProfitCents, leftInBusinessCents } = b.derived;
  const share = shareOf(drawings.totalCents, netProfitCents);

  return {
    kpis: [
      {
        label: 'Profit earned',
        cents: netProfitCents,
        note: 'Income less expenses',
      },
      {
        label: 'Taken out as drawings',
        cents: drawings.totalCents,
        tone: 'draw',
        note:
          netProfitCents > 0
            ? `${share.toFixed(0)}% of the profit earned`
            : 'No profit was earned in this period',
      },
      {
        label: 'Left in the business',
        cents: leftInBusinessCents,
        tone: leftInBusinessCents >= 0 ? 'in' : 'out',
        note:
          leftInBusinessCents >= 0
            ? 'Profit not yet taken out'
            : 'More taken out than was earned this period',
      },
    ],
    notes: [
      ...runningNote(b),
      {
        tone: 'draw',
        icon: 'wallet',
        title: 'A drawing is not an expense, and this report is why it is kept apart',
        body:
          'Money taken out for the owner does not reduce profit, does not appear in the ' +
          'expense report, and carries no tax that can be claimed back. It comes out of ' +
          'profit that has already been earned, which is exactly what the last column shows.',
      },
    ],
    tables: [
      {
        title: 'Month by month',
        columns: [
          { label: 'Month' },
          { label: 'Profit', align: 'right' },
          { label: 'Drawings', align: 'right' },
          { label: 'Left in the business', align: 'right' },
        ],
        rows: b.months.map((m) => {
          const profit = m.incomeCents - m.expensesCents;
          return {
            tone: m.drawingsCents ? ('draw' as const) : undefined,
            cells: [
              { text: `${m.label} ${m.year}`, strong: true },
              cash(profit),
              m.drawingsCents
                ? cash(m.drawingsCents, { tone: 'draw' })
                : { text: '—', align: 'right' as const, tone: 'muted' as const },
              cash(profit - m.drawingsCents, { strong: true }),
            ],
          };
        }),
        foot: [
          { text: 'Total' },
          cash(netProfitCents),
          cash(drawings.totalCents, { tone: 'draw' }),
          cash(leftInBusinessCents),
        ],
      },
    ],
    footnote:
      'Your accountant will use this at year end to work out what has been drawn against ' +
      'the business. It is the report that makes tracking drawings separately worth doing.',
  };
}

/* =============================================================== 7. cashflow --- */

function rCashflow(b: Built): Pick<ReportDoc, 'kpis' | 'notes' | 'tables' | 'footnote'> {
  const { income, expenses, drawings, netProfitCents } = b.derived;
  const out = expenses.subtotalCents + drawings.totalCents;
  const net = income.subtotalCents - out;
  const max = widest(
    b.months.map((m) => Math.max(m.incomeCents, m.expensesCents + m.drawingsCents)),
  );

  return {
    kpis: [
      { label: 'Money in', cents: income.subtotalCents, tone: 'in', note: 'Before tax' },
      {
        label: 'Money out',
        cents: out,
        tone: 'out',
        note: `${money(expenses.subtotalCents)} expenses and ${money(drawings.totalCents)} drawings`,
      },
      {
        label: 'Net movement',
        cents: net,
        tone: net >= 0 ? 'in' : 'out',
        note: net >= 0 ? 'More came in than went out' : 'More went out than came in',
      },
    ],
    notes: [
      ...runningNote(b),
      {
        tone: 'info',
        icon: 'info',
        title: 'This is the one report where drawings count',
        body:
          'Profit ignores drawings, because they are not a cost of the business. Cash flow ' +
          `cannot, because the money genuinely left the account. That is why the two give ` +
          `different answers: ${money(netProfitCents)} of profit against ${money(net)} of ` +
          'actual movement.',
      },
    ],
    tables: [
      {
        title: 'Month by month',
        columns: [
          { label: 'Month' },
          { label: '', width: '26%' },
          { label: 'In', align: 'right' },
          { label: 'Expenses', align: 'right' },
          { label: 'Drawings', align: 'right' },
          { label: 'Net', align: 'right' },
        ],
        rows: b.months.map((m) => {
          const monthOut = m.expensesCents + m.drawingsCents;
          return {
            cells: [
              { text: `${m.label} ${m.year}`, strong: true },
              {
                bars: [
                  { share: max ? m.incomeCents / max : 0, tone: 'in' as const },
                  { share: max ? monthOut / max : 0, tone: 'out' as const },
                ],
              },
              cash(m.incomeCents, { tone: 'in' }),
              cash(m.expensesCents, { tone: 'out' }),
              m.drawingsCents
                ? cash(m.drawingsCents, { tone: 'draw' })
                : { text: '—', align: 'right' as const, tone: 'muted' as const },
              cash(m.incomeCents - monthOut, { strong: true }),
            ],
          };
        }),
        foot: [
          { text: 'Total' },
          {},
          cash(income.subtotalCents, { tone: 'in' }),
          cash(expenses.subtotalCents, { tone: 'out' }),
          cash(drawings.totalCents, { tone: 'draw' }),
          cash(net),
        ],
      },
    ],
    footnote:
      'Figures are before tax throughout. The tax collected and paid moves through the same ' +
      'bank account but belongs in the GST/HST report, not here.',
  };
}

const BUILDERS: Record<ReportId, (b: Built) => Pick<ReportDoc, 'kpis' | 'notes' | 'tables' | 'footnote'>> = {
  income: rIncome,
  expenses: rExpenses,
  profit: rProfit,
  tax: rTax,
  invoices: rInvoices,
  drawings: rDrawings,
  cashflow: rCashflow,
};

/* ------------------------------------------------------------------ the API --- */

export async function buildReport(
  businessId: string,
  id: ReportId,
  from: Date,
  to: Date,
  compare: boolean,
): Promise<ReportDoc> {
  if (to < from) {
    throw new ApiError(400, 'The end of the range is before the start.', 'bad_range');
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new ApiError(404, 'That business no longer exists.', 'not_found');

  const built = await gather(businessId, id, from, to, compare);
  const meta = REPORTS.find((r) => r.id === id)!;
  const body = BUILDERS[id](built);

  return {
    id,
    name: meta.name,
    blurb: meta.blurb,
    period: {
      from: built.derived.period.from,
      to: built.derived.period.to,
      label: labelFor(from, to),
      rangeLabel: `${slash(built.derived.period.from)} to ${slash(built.derived.period.to)}`,
      complete: built.derived.period.complete,
      totalDays: built.derived.period.totalDays,
      elapsedDays: built.derived.period.elapsedDays,
      scoped: id !== 'invoices',
    },
    basis: built.compare ? built.basis : null,
    seller: {
      name: business.legalName ?? business.name,
      address: addressOf(business),
      email: business.email,
      phone: business.phone,
      gstHstNumber: business.gstRegistered ? business.gstHstNumber : null,
      gstRegistered: business.gstRegistered,
    },
    preparedOn: new Date().toISOString().slice(0, 10),
    currency: business.currency,
    dateFormat: business.dateFormat,
    taxLabel: built.derived.tax.label,
    ...body,
  };
}

/* The file somebody ends up with in their downloads folder. Named so that a
   year of them sorts into something an accountant can read. */
export const fileNameFor = (doc: ReportDoc, extension: string): string =>
  `${doc.seller.name} ${doc.name} ${doc.period.label}`
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') + `.${extension}`;
