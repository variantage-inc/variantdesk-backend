import ExcelJS from 'exceljs';
import type { Cell, ReportDoc, Table } from './reports.js';

/* The spreadsheet of a report.

   Same document as the screen and the PDF, third renderer. The point of this
   one is that the figures arrive as NUMBERS, not as text that looks like
   numbers: the accountant who opens it can total a column, sort it, or paste
   it into their own working papers. A CSV of formatted strings looks identical
   and does none of that.

   Money is written as dollars with a currency format on the cell, because a
   spreadsheet is where somebody does arithmetic by hand and cents would make
   every total a hundred times too big. That conversion happens here, at the
   edge, and nowhere else. */

const MONEY_FORMAT = '#,##0.00;[Red]-#,##0.00';
const PERCENT_FORMAT = '0.0"%"';

const INK = 'FF142539';
const INK3 = 'FF5F7590';
const LINE = 'FFE8EFF7';
const IN = 'FF0D7A57';
const OUT = 'FFC01F25';
const DRAW = 'FF6D3FD4';

type Row = ExcelJS.Row;

const toneColour = (cell: Cell): string => {
  if (cell.tone === 'in') return IN;
  if (cell.tone === 'out') return OUT;
  if (cell.tone === 'draw') return DRAW;
  if (cell.tone === 'muted') return INK3;
  return INK;
};

/* One cell, with its value in whatever type it really is. */
function write(target: ExcelJS.Cell, cell: Cell, bold = false): void {
  if (cell.cents !== undefined) {
    target.value = cell.cents / 100;
    target.numFmt = MONEY_FORMAT;
  } else if (cell.percent !== undefined) {
    target.value = cell.percent;
    target.numFmt = PERCENT_FORMAT;
  } else if (cell.pill) {
    target.value = cell.pill.label;
  } else {
    target.value = cell.text ?? '';
  }

  target.font = { name: 'Calibri', size: 11, bold: bold || cell.strong === true, color: { argb: toneColour(cell) } };
  target.alignment = { horizontal: cell.align === 'right' ? 'right' : 'left', vertical: 'middle' };
}

const heading = (row: Row, text: string, size: number): void => {
  row.getCell(1).value = text;
  row.getCell(1).font = { name: 'Calibri', size, bold: true, color: { argb: INK } };
};

function addTable(sheet: ExcelJS.Worksheet, spec: Table): void {
  sheet.addRow([]);
  heading(sheet.addRow([]), spec.title, 12);

  const head = sheet.addRow(spec.columns.map((c) => c.label));
  head.eachCell((cell, index) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: INK3 } };
    cell.alignment = {
      horizontal: spec.columns[index - 1]?.align === 'right' ? 'right' : 'left',
      vertical: 'middle',
    };
    cell.border = { bottom: { style: 'thin', color: { argb: LINE } } };
  });

  for (const row of spec.rows) {
    const line = sheet.addRow([]);
    /* The bar column carries no value, only a drawing, so it is skipped
       entirely rather than written as an empty column nobody can explain. */
    let column = 1;
    for (const cell of row.cells) {
      if (cell.bars) continue;
      write(line.getCell(column), cell);
      if (cell.sub) line.getCell(column).note = cell.sub;
      column += 1;
    }
  }

  if (spec.foot) {
    const line = sheet.addRow([]);
    let column = 1;
    for (const cell of spec.foot) {
      if (cell.bars) continue;
      write(line.getCell(column), cell, true);
      column += 1;
    }
    line.eachCell((cell) => {
      cell.border = { top: { style: 'thin', color: { argb: INK } } };
    });
  }
}

export async function renderXlsx(report: ReportDoc): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = 'Variantage Finance';
  book.created = new Date();

  /* Excel refuses a sheet name with a slash in it, which "GST/HST summary"
     has. It is the report's own name everywhere else, so it is fixed here
     rather than renamed in the product. */
  const sheet = book.addWorksheet(report.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));

  heading(sheet.addRow([]), report.seller.name, 14);
  heading(sheet.addRow([]), `${report.name} · ${report.period.label}`, 12);

  const range = sheet.addRow([report.period.rangeLabel]);
  range.getCell(1).font = { name: 'Calibri', size: 10, color: { argb: INK3 } };
  const prepared = sheet.addRow([
    `Prepared ${report.preparedOn.replace(/-/g, '/')} from Variantage Finance · amounts in ${report.currency}`,
  ]);
  prepared.getCell(1).font = { name: 'Calibri', size: 10, color: { argb: INK3 } };

  if (!report.period.scoped) {
    const note = sheet.addRow(['This report covers every invoice, not only the chosen period.']);
    note.getCell(1).font = { name: 'Calibri', size: 10, color: { argb: INK3 } };
  }

  /* The headline figures first, as label and value, so the first thing in the
     file is the same first thing that is on the screen. */
  sheet.addRow([]);
  heading(sheet.addRow([]), 'Summary', 12);
  for (const kpi of report.kpis) {
    const row = sheet.addRow([]);
    row.getCell(1).value = kpi.label;
    row.getCell(1).font = { name: 'Calibri', size: 11, color: { argb: INK } };

    write(row.getCell(2), { cents: kpi.cents, text: kpi.text, align: 'right', tone: kpi.tone }, true);

    const note = [
      kpi.delta
        ? `${kpi.delta.percent >= 0 ? '+' : '-'}${Math.abs(kpi.delta.percent).toFixed(1)}% ${kpi.delta.label}`
        : null,
      kpi.note ?? null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (note) {
      row.getCell(3).value = note;
      row.getCell(3).font = { name: 'Calibri', size: 10, color: { argb: INK3 } };
    }
  }

  for (const spec of report.tables) addTable(sheet, spec);

  sheet.addRow([]);
  const footnote = sheet.addRow([report.footnote]);
  footnote.getCell(1).font = { name: 'Calibri', size: 9, italic: true, color: { argb: INK3 } };

  /* Wide enough to read without anybody dragging a column edge. */
  sheet.getColumn(1).width = 34;
  for (let i = 2; i <= 8; i += 1) sheet.getColumn(i).width = 17;

  const buffer = await book.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
