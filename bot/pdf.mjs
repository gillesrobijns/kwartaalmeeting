// PDFs for the group: De Kwartaalkrant (from the recap JSON) and short reports Claude writes on request.
// pdfkit is loaded lazily, so a missing package never stops the bot.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', minus: '-', euro: '€', mdash: '—', ndash: '–',
  rarr: '->', larr: '<-', hellip: '…', laquo: '«', raquo: '»', bull: '•', middot: '·', eacute: 'é', euml: 'ë', iuml: 'ï' };
const decode = (s) => String(s ?? '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? m);
// Standard PDF fonts only know Latin-1 plus a few typographic signs: drop emoji and the like.
const clean = (s) => decode(s).replace(/−/g, '-').replace(/→/g, '->').replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF€–—‘’“”…•]/gu, '').replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ');
const safe = (s) => clean(s).trim();
const strip = (s) => safe(String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));

async function newDoc(opts) {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, bufferPages: true, ...opts });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  return { doc, done };
}

// Paragraph with <b>…</b> runs in a regular/bold font pair.
function rich(doc, html, { font = 'Times-Roman', bold = 'Times-Bold', size = 11, color = '#1c1917', ...opts } = {}) {
  const parts = String(html ?? '').replace(/<br\s*\/?>/gi, '\n').split(/(<b>[\s\S]*?<\/b>|<strong>[\s\S]*?<\/strong>)/i).filter((p) => p !== '');
  doc.fillColor(color).fontSize(size);
  if (!parts.length) return;
  parts.forEach((p, i) => {
    const isB = /^<(b|strong)>/i.test(p);
    let t = clean(p.replace(/<[^>]+>/g, ''));
    if (i === 0) t = t.trimStart();
    if (i === parts.length - 1) t = t.trimEnd();
    doc.font(isB ? bold : font).text(t, { ...opts, continued: i < parts.length - 1 });
  });
}

function ensureSpace(doc, h) { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); }

// ---------------- De Kwartaalkrant ----------------
const INK = '#1c1917', MUTED = '#78716c', RED = '#b91c1c', PAPER = '#fbf8f1';

export async function renderKrant(c) {
  const { doc, done } = await newDoc({ info: { Title: `De Kwartaalkrant ${strip(c.quarter)}` } });
  const W = doc.page.width - 112, X = 56;
  const paper = () => { doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(PAPER).restore(); doc.fillColor(INK); };
  paper(); doc.on('pageAdded', paper);
  const kicker = (t) => { ensureSpace(doc, 60); doc.moveDown(0.6).font('Helvetica-Bold').fontSize(8.5).fillColor(RED).text(strip(t).toUpperCase(), X, doc.y, { characterSpacing: 1.6 }); doc.moveDown(0.3); doc.fillColor(INK); };
  const rule = (th = 1) => { doc.moveDown(0.4); doc.save().moveTo(X, doc.y).lineTo(X + W, doc.y).lineWidth(th).strokeColor(INK).stroke().restore(); doc.moveDown(0.5); };

  // masthead
  doc.font('Times-Bold').fontSize(38).fillColor(INK).text('De Kwartaalkrant', X, 50, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`RECAP ${strip(c.quarter).toUpperCase()}  ·  ${strip(c.meeting_date).toUpperCase()}`, { width: W, align: 'center', characterSpacing: 1.2 });
  rule(2);
  doc.font('Times-Bold').fontSize(24).fillColor(INK).text(strip(c.headline), X, doc.y, { width: W });
  doc.moveDown(0.3);
  rich(doc, c.lede, { size: 12.5, width: W, lineGap: 2 });
  rule();

  // jerseys and prizes, two columns
  const colW = (W - 20) / 2;
  const standings = (rows, x, y0) => {
    let y = y0;
    for (const r of rows || []) {
      const col = r.color || '#999';
      if (col === 'dots') { doc.save().rect(x, y + 2, 10, 10).fillAndStroke('#ffffff', '#a8a29e').circle(x + 5, y + 7, 2).fill('#dc2626').restore(); }
      else doc.save().rect(x, y + 2, 10, 10).fillAndStroke(col, col.toLowerCase() === '#ffffff' ? '#a8a29e' : col).restore();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`${strip(r.name)}: ${strip(r.winner)}`, x + 16, y, { width: colW - 16 });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(strip(r.value), x + 16, doc.y, { width: colW - 16 });
      y = doc.y + 6;
    }
    return y;
  };
  ensureSpace(doc, 160);
  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(RED).text('DE TRUIEN', X, top, { characterSpacing: 1.6 });
  doc.text('KWARTAALPRIJZEN', X + colW + 20, top, { characterSpacing: 1.6 });
  const yL = standings(c.jerseys, X, top + 16);
  const yR = standings(c.prizes, X + colW + 20, top + 16);
  doc.y = Math.max(yL, yR); doc.x = X;
  if (c.jerseys_note) doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(strip(c.jerseys_note), X, doc.y, { width: W });

  if (c.duvel) { kicker('Duvelteller'); rich(doc, c.duvel, { size: 11.5, width: W }); }

  if (c.said?.length) {
    kicker('Wat er gezegd werd');
    for (const [who, txt] of c.said) { ensureSpace(doc, 40); rich(doc, `<b>${who}.</b> ${txt}`, { size: 11, width: W, lineGap: 1.5 }); doc.moveDown(0.4); }
  }

  const d = c.dossier;
  if (d?.title) {
    rule();
    kicker(d.kicker || 'Dossier');
    doc.font('Times-Bold').fontSize(18).fillColor(INK).text(strip(d.title), X, doc.y, { width: W });
    doc.moveDown(0.2); rich(doc, d.text, { size: 11.5, width: W, lineGap: 1.5 });
    if (d.meta) doc.moveDown(0.2).font('Helvetica').fontSize(9).fillColor(MUTED).text(strip(d.meta), { width: W });
    if (d.link) doc.moveDown(0.2).font('Helvetica-Bold').fontSize(9.5).fillColor(RED).text(`${strip(d.link_label || 'Lees online')} ->`, { width: W, link: d.link, underline: false });
    if (d.note) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(strip(d.note), { width: W });
  }

  if (c.new_cards?.length) {
    rule();
    kicker(c.new_title || 'Nieuw');
    for (const card of c.new_cards) {
      ensureSpace(doc, 70);
      doc.font('Times-Bold').fontSize(14).fillColor(INK).text(strip(card.title), X, doc.y, { width: W });
      if (card.sub) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(strip(card.sub), { width: W });
      for (const [, t] of card.items || []) rich(doc, `•  ${t}`, { font: 'Helvetica', bold: 'Helvetica-Bold', size: 10, width: W, indent: 8 });
      doc.moveDown(0.4);
    }
  }
  if (c.backlog?.length) { kicker('Op de backlog'); for (const [t, s] of c.backlog) rich(doc, `<b>${t}</b>: ${s}`, { font: 'Helvetica', bold: 'Helvetica-Bold', size: 10, width: W }); }
  if (c.rules?.length) { kicker('Nieuwe afspraken'); for (const r of c.rules) rich(doc, `•  ${r}`, { font: 'Helvetica', bold: 'Helvetica-Bold', size: 10, width: W }); }
  if (c.actions?.length) {
    kicker(c.actions_title || 'Agenda');
    for (const [t, who] of c.actions) { ensureSpace(doc, 30); rich(doc, `${t} <b>(${who})</b>`, { font: 'Helvetica', bold: 'Helvetica-Bold', size: 10, width: W }); doc.moveDown(0.2); }
  }
  if (c.next?.date) {
    rule();
    kicker(`Volgende meeting: ${c.next.label || ''}`);
    doc.font('Times-Bold').fontSize(16).fillColor(INK).text(`${strip(c.next.date)}${c.next.host ? `, bij ${strip(c.next.host)}` : ''}`, X, doc.y, { width: W });
    if (c.next.note) rich(doc, c.next.note, { size: 11, width: W });
  }
  if (c.signoff || c.signature) { doc.moveDown(0.8); doc.font('Times-Italic').fontSize(11).fillColor(INK).text(strip(c.signoff || ''), { width: W }); doc.font('Times-Roman').text(strip(c.signature || ''), { width: W }); }
  doc.end();
  return done;
}

// ---------------- report on request ----------------
export async function renderReport(r) {
  const { doc, done } = await newDoc({ info: { Title: strip(r.titel) } });
  const W = doc.page.width - 112, X = 56;
  const NAVY = '#0f172a';
  doc.save().rect(0, 0, doc.page.width, 118).fill(NAVY).restore();
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#94a3b8').text('KWARTAALMEETING  ·  RAPPORTJE VAN CLAUDE', X, 34, { characterSpacing: 1.4 });
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff').text(strip(r.titel), X, 52, { width: W });
  if (r.ondertitel) doc.font('Helvetica').fontSize(10.5).fillColor('#cbd5e1').text(strip(r.ondertitel), X, doc.y + 2, { width: W });
  doc.y = Math.max(doc.y + 24, 142); doc.x = X;

  for (const s of r.secties || []) {
    ensureSpace(doc, 70);
    if (s.kop) { doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text(strip(s.kop), X, doc.y, { width: W }); doc.moveDown(0.25); }
    if (s.tekst) { rich(doc, s.tekst, { font: 'Helvetica', bold: 'Helvetica-Bold', size: 10.5, width: W, lineGap: 2, color: '#1f2937' }); doc.moveDown(0.3); }
    for (const p of s.punten || []) { rich(doc, `•  ${p}`, { font: 'Helvetica', bold: 'Helvetica-Bold', size: 10.5, width: W, indent: 6, lineGap: 1.5, color: '#1f2937' }); }
    doc.moveDown(0.8);
  }

  const t = r.tabel;
  if (t?.kolommen?.length && t?.rijen?.length) {
    ensureSpace(doc, 80);
    if (t.kop) { doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text(strip(t.kop), X, doc.y, { width: W }); doc.moveDown(0.3); }
    const n = t.kolommen.length, first = Math.min(W * 0.4, W / n * 1.6), rest = (W - first) / Math.max(1, n - 1);
    const widths = t.kolommen.map((_, i) => (n === 1 ? W : i === 0 ? first : rest));
    const row = (cells, head, zebra) => {
      const h = Math.max(...cells.map((c, i) => doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).heightOfString(strip(c), { width: widths[i] - 10 }))) + 8;
      ensureSpace(doc, h);
      const y = doc.y;
      if (head) doc.save().rect(X, y, W, h).fill('#e2e8f0').restore();
      else if (zebra) doc.save().rect(X, y, W, h).fill('#f8fafc').restore();
      let x = X;
      cells.forEach((c, i) => { doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor('#111827').text(strip(c), x + 5, y + 4, { width: widths[i] - 10, align: i ? 'right' : 'left' }); x += widths[i]; });
      doc.y = y + h; doc.x = X;
    };
    row(t.kolommen, true);
    t.rijen.slice(0, 60).forEach((rw, i) => row(t.kolommen.map((_, j) => String(rw[j] ?? '')), false, i % 2));
    doc.moveDown(0.8);
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const b = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor('#94a3b8').text(
      `Gemaakt door Claude, lid 11, op ${new Date().toLocaleDateString('nl-BE', { dateStyle: 'long', timeZone: 'Europe/Brussels' })}. Op basis van het publieke dashboard: geen eurobedragen, geen beleggingsadvies.`,
      X, doc.page.height - 36, { width: W, align: 'center', lineBreak: false });
    doc.page.margins.bottom = b;
  }
  doc.end();
  return done;
}
