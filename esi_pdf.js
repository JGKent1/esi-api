'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * Brief → printable PDF. Modelled on eei-api-canonical's eei_pdf.js.
 *
 * Renders exactly the markdown subset renderBrief() emits: #/##/### headings,
 * `---` rules, pipe tables, `- ` bullets, `1. ` numbered lists, whole-line
 * _italics_, and inline **bold** / _italic_ runs. Anything else prints as
 * plain text rather than breaking the page.
 *
 * Release-gate visibility on paper: any Brief whose status is not `released`
 * carries a diagonal DRAFT — NOT RELEASED watermark on every page. Released
 * Briefs carry the release stamp in the footer instead. The endpoint is
 * admin-only either way; the watermark exists so a printed draft can never be
 * mistaken for a released record.
 * ──────────────────────────────────────────────────────────────────────────── */

const PDFDocument = require('pdfkit');

const M = 54;                 // page margin (pt)
const BODY = 10.5;            // body font size
const INK = '#1a1a1a';
const MUTED = '#666666';
const RULE = '#cccccc';

/* Parse inline **bold** and _italic_ into runs. */
function runs(text) {
  const out = [];
  let rest = String(text);
  const re = /(\*\*([^*]+)\*\*)|(_([^_]+)_)/;
  while (rest.length) {
    const m = rest.match(re);
    if (!m) { out.push({ t: rest, b: false, i: false }); break; }
    if (m.index > 0) out.push({ t: rest.slice(0, m.index), b: false, i: false });
    if (m[2] != null) out.push({ t: m[2], b: true, i: false });
    else out.push({ t: m[4], b: false, i: true });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function fontFor(r) {
  if (r.b && r.i) return 'Helvetica-BoldOblique';
  if (r.b) return 'Helvetica-Bold';
  if (r.i) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function inline(doc, text, opts = {}) {
  const rr = runs(text);
  rr.forEach((r, idx) => {
    doc.font(fontFor(r)).fontSize(opts.size || BODY).fillColor(opts.color || INK)
      .text(r.t, { continued: idx < rr.length - 1, ...(opts.text || {}) });
  });
}

function ensureRoom(doc, needed) {
  if (doc.y + needed > doc.page.height - M - 24) doc.addPage();
}

function drawTable(doc, header, rows) {
  const w = doc.page.width - M * 2;
  const n = header.length;
  // First column gets the leftover; numeric columns get a fixed width.
  const numW = Math.min(72, (w * 0.55) / Math.max(1, n - 1));
  const firstW = w - numW * (n - 1);
  const widths = [firstW, ...Array(n - 1).fill(numW)];
  const rowH = 17;

  ensureRoom(doc, rowH * (rows.length + 1) + 10);
  let y = doc.y + 2;

  const cell = (txt, x, cw, bold, right) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(INK)
      .text(String(txt).replace(/\*\*/g, ''), x + 4, y + 4.5,
        { width: cw - 8, align: right ? 'right' : 'left', lineBreak: false });
  };

  let x = M;
  header.forEach((h, i) => { cell(h, x, widths[i], true, i > 0); x += widths[i]; });
  doc.moveTo(M, y + rowH - 2).lineTo(M + w, y + rowH - 2).lineWidth(0.8).strokeColor(INK).stroke();
  y += rowH;

  rows.forEach((r) => {
    x = M;
    r.forEach((c, i) => { cell(c, x, widths[i], false, i > 0); x += widths[i]; });
    doc.moveTo(M, y + rowH - 2).lineTo(M + w, y + rowH - 2).lineWidth(0.4).strokeColor(RULE).stroke();
    y += rowH;
  });

  doc.x = M;
  doc.y = y + 6;
}

function watermark(doc) {
  doc.save();
  doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.font('Helvetica-Bold').fontSize(52).fillColor('#c0392b').opacity(0.13)
    .text('DRAFT — NOT RELEASED', 0, doc.page.height / 2 - 30,
      { width: doc.page.width, align: 'center' });
  doc.opacity(1).restore();
  doc.x = M; doc.y = M;
}

/**
 * Render a submission's Brief to PDF.
 * @param {object} sub  submission row: report_text, full_name, student_ref,
 *                      cohort, window, status, released_at, released_by, versions
 * @param {stream.Writable} out  response / file stream
 */
function renderBriefPdf(sub, out) {
  const released = sub.status === 'released';
  const doc = new PDFDocument({ size: 'LETTER', margin: M, bufferPages: true,
    info: { Title: `ESI Brief — ${sub.full_name || sub.student_ref}`, Author: 'Exceed Student Index' } });
  doc.pipe(out);

  if (!released) watermark(doc);
  doc.on('pageAdded', () => { if (!released) watermark(doc); });

  const lines = String(sub.report_text || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { doc.moveDown(0.4); i++; continue; }

    if (/^---\s*$/.test(line)) {
      ensureRoom(doc, 14);
      doc.moveTo(M, doc.y + 4).lineTo(doc.page.width - M, doc.y + 4)
        .lineWidth(0.7).strokeColor(RULE).stroke();
      doc.moveDown(0.8); i++; continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const sizes = { 1: 20, 2: 14.5, 3: 12 };
      ensureRoom(doc, sizes[level] * 2.2);
      doc.moveDown(level === 1 ? 0.1 : 0.5);
      doc.font('Helvetica-Bold').fontSize(sizes[level]).fillColor(INK)
        .text(h[2].replace(/\*\*/g, ''), { paragraphGap: 2 });
      doc.moveDown(0.2);
      i++; continue;
    }

    if (/^\|/.test(line)) {
      const tbl = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        const cells = lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!/^:?-{2,}/.test(cells[0])) tbl.push(cells);   // skip the alignment row
        i++;
      }
      if (tbl.length) drawTable(doc, tbl[0], tbl.slice(1));
      continue;
    }

    const bullet = line.match(/^-\s+(.*)$/);
    if (bullet) {
      ensureRoom(doc, 26);
      doc.font('Helvetica').fontSize(BODY).fillColor(INK).text('•  ', M + 6, doc.y, { continued: true });
      inline(doc, bullet[1], { text: { paragraphGap: 3 } });
      doc.x = M;
      i++; continue;
    }

    const num = line.match(/^(\d+)\.\s+(.*)$/);
    if (num) {
      ensureRoom(doc, 26);
      doc.font('Helvetica').fontSize(BODY).fillColor(INK).text(num[1] + '.  ', M + 6, doc.y, { continued: true });
      inline(doc, num[2], { text: { paragraphGap: 3 } });
      doc.x = M;
      i++; continue;
    }

    // Whole-line italic (caveats, versions footer). Greedy match: interior
    // underscores (e.g. esi_items_v1_0) stay literal.
    const wholeItalic = line.match(/^_(.*)_\s*$/);
    if (wholeItalic) {
      ensureRoom(doc, 26);
      doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(MUTED)
        .text(wholeItalic[1].replace(/\*\*/g, ''), { paragraphGap: 3 });
      i++; continue;
    }

    ensureRoom(doc, 30);
    inline(doc, line, { text: { paragraphGap: 3, align: 'left' } });
    i++;
  }

  // Footer on every page: identity + release stamp + page number.
  const range = doc.bufferedPageRange();
  const stamp = released
    ? `Released ${String(sub.released_at || '').slice(0, 10)} by ${sub.released_by || '—'}`
    : 'DRAFT — pending instructor review; not a released record';
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`${sub.full_name || sub.student_ref} · ${sub.cohort} · ${sub.window === 'wk15' ? 'Week 15' : 'Day 0'} · ${stamp}`,
        M, doc.page.height - M + 14, { width: doc.page.width - M * 2 - 60, lineBreak: false })
      .text(`${p - range.start + 1} / ${range.count}`,
        doc.page.width - M - 50, doc.page.height - M + 14, { width: 50, align: 'right', lineBreak: false });
  }

  doc.end();
}

module.exports = { renderBriefPdf };
