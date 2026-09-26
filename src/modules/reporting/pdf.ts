import PDFDocument from 'pdfkit';
import type { Cell, Kpi, Note, ReportDoc, Table } from './reports.js';

/* The PDF of a report.

   It renders the document that `reports.ts` builds, which is the same document
   the screen and the spreadsheet render. So a figure cannot be right on screen
   and wrong in the file somebody emails to their accountant: there is one
   report and three ways of drawing it.

   PDFKit and the standard Helvetica faces, deliberately. Embedding the brand
   typeface would mean shipping font files, licensing them for redistribution
   inside a document, and adding half a megabyte to every export, in exchange
   for a report that looks slightly more like the website. The colours carry
   the brand instead. */

const COLOUR = {
  ink: '#142539',
  ink2: '#3c5169',
  ink3: '#5f7590',
  line: '#d7e3f0',
  line2: '#e8eff7',
  navy: '#142539',
  in: '#0d7a57',
  out: '#c01f25',
  draw: '#6d3fd4',
  infoBg: '#eff4fd',
  warnBg: '#fff6e8',
  warnInk: '#7a4400',
  okBg: '#eaf7f1',
  okInk: '#0b5c42',
  drawBg: '#f3efff',
  drawInk: '#4a2a95',
  surface2: '#f7fafd',
};

const PAGE = { width: 612, height: 792, margin: 44 };
const CONTENT = PAGE.width - PAGE.margin * 2;
const BOTTOM = PAGE.height - PAGE.margin - 26;

type Doc = InstanceType<typeof PDFDocument>;

const nf = new Intl.NumberFormat('en-CA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/* Money in a table is printed without the currency symbol and with the sign in
   front of the digits, which is how a column of figures is read. The currency
   is said once, in the footer. */
const amount = (cents: number): string =>
  `${cents < 0 ? '-' : ''}${nf.format(Math.abs(cents) / 100)}`;

const cash = (cents: number): string => `$${amount(cents)}`;

function cellText(cell: Cell): string {
  if (cell.cents !== undefined) return amount(cell.cents);
  if (cell.percent !== undefined) return `${cell.percent.toFixed(1)}%`;
  if (cell.pill) return cell.pill.label;
  return cell.text ?? '';
}

const toneColour = (cell: Cell): string => {
  if (cell.tone === 'in') return COLOUR.in;
  if (cell.tone === 'out') return COLOUR.out;
  if (cell.tone === 'draw') return COLOUR.draw;
  if (cell.tone === 'muted') return COLOUR.ink3;
  return COLOUR.ink;
};

/* Column widths.

   A money column needs room for $123,456.78 and no more, so it is given a
   fixed width and everything left over is shared between the columns that
   carry words. A bar column asks for a percentage of the page and gets it. */
function widthsFor(table: Table): number[] {
  const MONEY = 74;
  const widths = table.columns.map((c) => {
    if (c.width) return (CONTENT * parseFloat(c.width)) / 100;
    if (c.align === 'right') return MONEY;
    return 0;
  });

  const spare = CONTENT - widths.reduce((n, w) => n + w, 0);
  const flexible = widths.filter((w) => w === 0).length;
  if (flexible > 0) {
    const each = spare / flexible;
    return widths.map((w) => (w === 0 ? each : w));
  }
  return widths;
}

/* ------------------------------------------------------------------ pieces --- */

function sellerBlock(doc: Doc, report: ReportDoc, top: number): number {
  const right = PAGE.margin + CONTENT / 2;
  const width = CONTENT / 2;

  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOUR.ink);
  doc.text(report.seller.name, right, top, { width, align: 'right' });

  const lines = [
    ...(report.seller.address ? report.seller.address.split('\n') : []),
    ...(report.seller.gstHstNumber ? [`GST/HST ${report.seller.gstHstNumber}`] : []),
  ];
  doc.font('Helvetica').fontSize(8.5).fillColor(COLOUR.ink3);
  doc.text(lines.join('\n'), right, doc.y + 1, { width, align: 'right', lineGap: 1.5 });

  return doc.y;
}

function header(doc: Doc, report: ReportDoc): void {
  const top = PAGE.margin;

  doc.font('Helvetica-Bold').fontSize(22).fillColor(COLOUR.navy);
  doc.text(report.name, PAGE.margin, top, { width: CONTENT / 2 });

  doc.font('Helvetica').fontSize(9).fillColor(COLOUR.ink3);
  doc.text(
    `${report.period.label} · ${report.period.rangeLabel} · ${report.taxLabel}`,
    PAGE.margin,
    doc.y + 3,
    { width: CONTENT / 2 },
  );

  const left = doc.y;
  const right = sellerBlock(doc, report, top);

  const y = Math.max(left, right) + 12;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(1).strokeColor(COLOUR.line).stroke();
  doc.y = y + 16;
}

function kpis(doc: Doc, list: Kpi[]): void {
  if (!list.length) return;

  /* Four across is what the screen shows and what fits on a letter page. More
     than four wraps into two rows rather than shrinking to illegible. */
  const perRow = list.length <= 4 ? list.length : Math.ceil(list.length / 2);
  const gap = 10;
  const boxWidth = (CONTENT - gap * (perRow - 1)) / perRow;

  for (let i = 0; i < list.length; i += perRow) {
    const row = list.slice(i, i + perRow);
    const top = doc.y;
    /* Measured before anything is drawn, so every box in a row is the height
       of the tallest and the row does not look ragged. */
    const height = 52 + Math.max(...row.map((k) => (k.delta ? 12 : 0), 0));

    row.forEach((kpi, column) => {
      const x = PAGE.margin + column * (boxWidth + gap);
      doc
        .roundedRect(x, top, boxWidth, height, 8)
        .lineWidth(1)
        .strokeColor(COLOUR.line2)
        .fillColor(COLOUR.surface2)
        .fillAndStroke(COLOUR.surface2, COLOUR.line2);

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOUR.ink3);
      doc.text(kpi.label.toUpperCase(), x + 10, top + 9, { width: boxWidth - 20 });

      const tone =
        kpi.tone === 'in' ? COLOUR.in : kpi.tone === 'out' ? COLOUR.out : kpi.tone === 'draw' ? COLOUR.draw : COLOUR.ink;
      doc.font('Helvetica-Bold').fontSize(15).fillColor(tone);
      doc.text(kpi.cents !== undefined ? cash(kpi.cents) : (kpi.text ?? ''), x + 10, top + 21, {
        width: boxWidth - 20,
      });

      const note = [
        kpi.delta ? `${kpi.delta.percent >= 0 ? '+' : '-'}${Math.abs(kpi.delta.percent).toFixed(1)}% ${kpi.delta.label}` : null,
        kpi.note ?? null,
      ]
        .filter(Boolean)
        .join(' · ');

      if (note) {
        doc.font('Helvetica').fontSize(7).fillColor(COLOUR.ink3);
        doc.text(note, x + 10, top + 40, { width: boxWidth - 20, height: 20, ellipsis: true });
      }
    });

    doc.y = top + height + gap;
  }

  doc.y += 4;
}

function notes(doc: Doc, list: Note[]): void {
  for (const note of list) {
    const background =
      note.tone === 'warn' ? COLOUR.warnBg : note.tone === 'ok' ? COLOUR.okBg : note.tone === 'draw' ? COLOUR.drawBg : COLOUR.infoBg;
    const ink =
      note.tone === 'warn' ? COLOUR.warnInk : note.tone === 'ok' ? COLOUR.okInk : note.tone === 'draw' ? COLOUR.drawInk : COLOUR.ink2;

    const inner = CONTENT - 24;
    doc.font('Helvetica-Bold').fontSize(9);
    const titleHeight = doc.heightOfString(note.title, { width: inner });
    doc.font('Helvetica').fontSize(8.5);
    const bodyHeight = doc.heightOfString(note.body, { width: inner, lineGap: 1.5 });
    const height = titleHeight + bodyHeight + 20;

    if (doc.y + height > BOTTOM) doc.addPage();

    const top = doc.y;
    doc.roundedRect(PAGE.margin, top, CONTENT, height, 8).fill(background);

    doc.font('Helvetica-Bold').fontSize(9).fillColor(ink);
    doc.text(note.title, PAGE.margin + 12, top + 9, { width: inner });
    doc.font('Helvetica').fontSize(8.5).fillColor(ink);
    doc.text(note.body, PAGE.margin + 12, doc.y + 2, { width: inner, lineGap: 1.5 });

    doc.y = top + height + 12;
  }
}

function tableHead(doc: Doc, table: Table, widths: number[]): void {
  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOUR.ink3);

  let x = PAGE.margin;
  table.columns.forEach((column, i) => {
    doc.text(column.label.toUpperCase(), x, top, {
      width: widths[i]!,
      align: column.align === 'right' ? 'right' : 'left',
    });
    x += widths[i]!;
  });

  const y = top + 13;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(1).strokeColor(COLOUR.line).stroke();
  doc.y = y + 6;
}

function drawRow(doc: Doc, cells: Cell[], widths: number[], options: { bold?: boolean; tint?: string }): void {
  const height = cells.some((c) => c.sub) ? 26 : 17;
  const top = doc.y;

  if (options.tint) {
    doc.rect(PAGE.margin, top - 4, CONTENT, height + 4).fill(options.tint);
  }

  let x = PAGE.margin;
  cells.forEach((cell, i) => {
    const width = widths[i]!;

    if (cell.bars?.length) {
      /* One or two proportional bars, drawn rather than described. The report
         is read at a glance before it is read in detail. */
      const barWidth = width - 12;
      cell.bars.forEach((bar, index) => {
        const y = top + 3 + index * 6;
        doc.roundedRect(x, y, barWidth, 4, 2).fill(COLOUR.line2);
        if (bar.share > 0) {
          const colour = bar.tone === 'in' ? COLOUR.in : bar.tone === 'out' ? COLOUR.out : COLOUR.draw;
          doc.roundedRect(x, y, Math.max(2, barWidth * bar.share), 4, 2).fill(colour);
        }
      });
      x += width;
      return;
    }

    const text = cellText(cell);
    if (text) {
      doc
        .font(cell.strong || options.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8.5)
        .fillColor(options.bold ? COLOUR.ink : toneColour(cell));
      doc.text(text, x, top, { width, align: cell.align === 'right' ? 'right' : 'left' });
    }

    if (cell.sub) {
      doc.font('Helvetica').fontSize(7).fillColor(cell.subTone === 'late' ? COLOUR.out : COLOUR.ink3);
      doc.text(cell.sub, x, top + 11, { width, align: cell.align === 'right' ? 'right' : 'left' });
    }

    x += width;
  });

  doc.y = top + height;
}

function table(doc: Doc, spec: Table): void {
  const widths = widthsFor(spec);

  if (doc.y + 60 > BOTTOM) doc.addPage();

  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOUR.navy);
  doc.text(spec.title.toUpperCase(), PAGE.margin, doc.y, { characterSpacing: 0.6 });
  doc.y += 6;

  tableHead(doc, spec, widths);

  for (const row of spec.rows) {
    if (doc.y + 30 > BOTTOM) {
      doc.addPage();
      tableHead(doc, spec, widths);
    }
    drawRow(doc, row.cells, widths, { tint: row.tone === 'draw' ? COLOUR.drawBg : undefined });
    doc
      .moveTo(PAGE.margin, doc.y - 3)
      .lineTo(PAGE.width - PAGE.margin, doc.y - 3)
      .lineWidth(0.5)
      .strokeColor(COLOUR.line2)
      .stroke();
    doc.y += 3;
  }

  if (spec.foot) {
    if (doc.y + 30 > BOTTOM) {
      doc.addPage();
      tableHead(doc, spec, widths);
    }
    doc
      .moveTo(PAGE.margin, doc.y)
      .lineTo(PAGE.width - PAGE.margin, doc.y)
      .lineWidth(1)
      .strokeColor(COLOUR.line)
      .stroke();
    doc.y += 5;
    drawRow(doc, spec.foot, widths, { bold: true });
  }

  doc.y += 16;
}

/* The line along the bottom of every page. Added at the end, once the number
   of pages is known, because "page 1 of 4" cannot be written before the fourth
   page exists. */
function footers(doc: Doc, report: ReportDoc): void {
  const range = doc.bufferedPageRange();

  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const y = PAGE.height - PAGE.margin - 14;

    doc.moveTo(PAGE.margin, y - 8).lineTo(PAGE.width - PAGE.margin, y - 8).lineWidth(0.5).strokeColor(COLOUR.line2).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOUR.ink3);
    doc.text(
      `Prepared ${report.preparedOn.replace(/-/g, '/')} from Variantage Finance · ${report.seller.name} · all amounts in Canadian dollars`,
      PAGE.margin,
      y,
      { width: CONTENT - 60, lineBreak: false },
    );
    doc.text(`${i + 1} of ${range.count}`, PAGE.margin, y, { width: CONTENT, align: 'right' });
  }
}

/* ------------------------------------------------------------------- render --- */

export function renderPdf(report: ReportDoc): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margin: PAGE.margin,
    /* Pages are buffered so the footer can say how many there are. */
    bufferPages: true,
    info: {
      Title: `${report.name} · ${report.period.label}`,
      Author: report.seller.name,
      Creator: 'Variantage Finance',
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  header(doc, report);
  kpis(doc, report.kpis);
  notes(doc, report.notes);
  for (const spec of report.tables) table(doc, spec);

  if (doc.y + 40 > BOTTOM) doc.addPage();
  doc
    .moveTo(PAGE.margin, doc.y)
    .lineTo(PAGE.width - PAGE.margin, doc.y)
    .lineWidth(1)
    .strokeColor(COLOUR.line)
    .stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOUR.ink3);
  doc.text(report.footnote, PAGE.margin, doc.y + 8, { width: CONTENT, lineGap: 1.5 });

  footers(doc, report);
  doc.end();

  return done;
}
