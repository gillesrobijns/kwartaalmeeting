// Vier extra manieren om transacties door te geven, naast een bericht aan de bot op WhatsApp (invoer.mjs).
// Alles loopt door dezelfde controles als WhatsApp (welk aandeel, wat ontbreekt, dubbel, prijs, bezit)
// en eindigt in de EIGEN sheet van het lid, via de Apps Script-webapp "Kwartaal invoer".
//
// 1. Mail naar gillesrobijns+kwartaal@gmail.com (screenshot, tekst of borderel-PDF).
//    Klopt alles, dan zet de bot het meteen in de sheet en mailt terug wat hij deed ("zet het terug" maakt het ongedaan).
//    Twijfelt een controle, dan schrijft hij niets en vraagt hij het in zijn antwoord.
// 2. Broker-meldingen: een lid laat de uitvoeringsmails van zijn broker automatisch doorsturen naar dat adres.
//    De bot vraagt dan op WhatsApp "Bolero meldt een aankoop van ... Klopt dit?" (ja/stop).
// 3. Overzicht of export van de broker (CSV, XLSX of PDF), op WhatsApp of per mail.
//    De bot vergelijkt het met de sheet (✓ klopt, + ontbreekt, ≠ verschilt) en geeft na "ja" de ontbrekende in.
// 4. Formulier op je gsm: een persoonlijke link (/formulier), geserveerd door de webapp zelf.
//    De webapp vraagt de koers voor de prijscontrole aan de bot (GET /api/koers, geen geheimen).
//
// De bot haalt nieuwe mails en formulier-meldingen zelf op bij de webapp (action "inbox", elke 3 minuten),
// dus er komt niets van buitenaf binnen behalve /api/koers.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const POLL_MS = 3 * 60 * 1000;
const MAX_LIST = 8;
const BROKERS = [['bolero', 'Bolero'], ['kbc', 'KBC'], ['degiro', 'DEGIRO'], ['keytrade', 'Keytrade'], ['revolut', 'Revolut'], ['saxo', 'Saxo'],
  ['belfius', 'Belfius'], ['ing.be', 'ING'], ['argenta', 'Argenta'], ['trading212', 'Trading 212'], ['lynx', 'LYNX'], ['medirect', 'MeDirect'], ['rebel', 'Rebel']];

export function createKanalen({ invoer, getSock, log, adminJid, claudeTag = '🤖 Claude: ', dataDir, jobs = true }) {
  const I = invoer._internals;
  const { state, UP, eur, num, dmy, TYPE_NL } = I;
  const FILE = join(dataDir, 'kanalen.json');
  const load = () => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}; } catch { return {}; } };
  let ks = load();
  ks.tries ||= {}; ks.nudged ||= {};
  const saveKs = () => { writeFileSync(`${FILE}.tmp`, JSON.stringify(ks, null, 1)); renameSync(`${FILE}.tmp`, FILE); };
  const admin = (text) => { const a = adminJid(); if (a) return getSock().sendMessage(a, { text: claudeTag + text }).catch(() => {}); };
  const dayDiff = (a, b) => Math.abs((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 864e5);
  const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;

  // ---------- webapp ----------
  async function webapp(body) {
    const url = I.config().webapp_url;
    if (!url) throw new Error('geen webapp_url');
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, redirect: 'follow', body: JSON.stringify({ token: I.token(), ...body }) });
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { throw new Error(`webapp gaf geen JSON (HTTP ${res.status})`); }
  }
  const formKey = (member) => createHash('sha256').update(`${I.token()}|form|${member}`).digest('hex').slice(0, 16);
  const formLink = (member) => { const u = I.config().webapp_url; return u ? `${u}?k=${formKey(member)}` : null; };
  const jidOf = (member) => {
    const hit = Object.entries(state.members).find(([, m]) => m === member);
    if (hit) return hit[0];
    return member === 'Gilles' ? adminJid() : null;
  };

  // ---------- bestanden ----------
  const ext = (name = '') => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  function decodeText(buf) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
    const u = buf.toString('utf8');
    return u.includes('�') ? buf.toString('latin1') : u;
  }
  // Minimale XLSX-lezer (een xlsx is een zip met XML): geen extra npm-pakket nodig op de server.
  function unzip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('geen zip');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const files = new Map();
    for (let k = 0; k < count; k++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
      const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      files.set(name, () => (method === 8 ? inflateRawSync(raw) : raw));
      p += 46 + nlen + elen + clen;
    }
    return files;
  }
  const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e.toLowerCase()]
    ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)));
  const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const serialDate = (v) => new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  function xlsxToCsv(buf) {
    const z = unzip(buf);
    const ss = z.has('xl/sharedStrings.xml')
      ? [...z.get('xl/sharedStrings.xml')().toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))
      : [];
    const sheets = [...z.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    const out = [];
    for (const name of sheets.slice(0, 3)) {
      const xml = z.get(name)().toString('utf8');
      const rows = [];
      for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = (c[1].match(/r="([A-Z]+\d+)"/) || [])[1];
          const t = (c[1].match(/t="(\w+)"/) || [])[1];
          const body = c[2] || '';
          let v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          if (t === 's') v = ss[+v] ?? '';
          else if (t === 'inlineStr') v = unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
          else if (v != null) v = unxml(v);
          if (ref) cells[colIdx(ref)] = v ?? '';
        }
        rows.push(cells);
      }
      // Excel-datums zijn getallen: zet ze om in kolommen waarvan de kop "datum"/"date" bevat
      const hi = rows.findIndex((r) => r.filter((v) => v && Number.isNaN(+v)).length >= 3);
      const dateCols = hi >= 0 ? rows[hi].map((v, i) => (/dat(e|um)|valuta|uitvoering|settle/i.test(v || '') ? i : -1)).filter((i) => i >= 0) : [];
      for (const r of rows.slice(hi + 1)) for (const i of dateCols) if (r[i] && /^\d{5}(\.\d+)?$/.test(r[i]) && +r[i] > 20000 && +r[i] < 80000) r[i] = serialDate(+r[i]);
      const csv = rows.filter((r) => r.some((v) => v !== undefined && v !== ''))
        .map((r) => Array.from(r, (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(';'));
      if (csv.length) out.push((sheets.length > 1 ? `## ${name.replace(/^.*\//, '')}\n` : '') + csv.join('\n'));
    }
    return out.join('\n\n');
  }
  // {name, mime, data: Buffer} -> wat de lezer ermee kan
  function fileInput(f) {
    const e = ext(f.name), mime = String(f.mime || '').split(';')[0].toLowerCase();
    try {
      if (IMG_TYPES.has(mime) || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(e)) {
        const mt = IMG_TYPES.has(mime) ? mime : `image/${e === 'jpg' ? 'jpeg' : e}`;
        return f.data.length <= 5 * 1024 * 1024 ? { name: f.name, img: { media_type: mt, data: f.data.toString('base64') } } : null;
      }
      if (mime === 'application/pdf' || e === 'pdf') return f.data.length <= 8 * 1024 * 1024 ? { name: f.name, doc: true, img: { media_type: 'application/pdf', data: f.data.toString('base64') } } : null;
      if (['csv', 'txt', 'tsv'].includes(e) || mime === 'text/csv' || mime === 'text/plain') return { name: f.name, table: true, text: decodeText(f.data) };
      if (e === 'xlsx' || mime.includes('spreadsheetml')) return { name: f.name, table: true, text: xlsxToCsv(f.data) };
      if (e === 'xls' || mime === 'application/vnd.ms-excel') return { name: f.name, unsupported: true };
    } catch (err) { log('kanalen bestand', f.name, err.message); return { name: f.name, unsupported: true }; }
    return null;
  }

  // ---------- overzicht van de broker vergelijken met de sheet ----------
  const HINT_OVERZICHT = 'Dit is een OVERZICHT of EXPORT van de broker van het lid (transactiegeschiedenis of borderel). ' +
    'Geef ELKE aankoop, verkoop en ontvangen dividend als een aparte rij, ook als het er veel zijn. Sla stortingen, opnames, rente, ' +
    'bewaarloon, kosten en muntwissels zonder aandeel over. is_transactie is true als er minstens één aankoop, verkoop of dividend in staat. ' +
    'Is het alleen een lijst van posities (wat het lid nu heeft), zet die in "posities".';
  async function readDocument(jid, member, text, parts) {
    if (!I.budgetOk(jid)) return 'budget';
    I.spend(jid);
    try {
      const r = await I.read({ model: invoer.MODELS.strong, member, text: text.slice(0, 60000), imgs: parts, hint: HINT_OVERZICHT, maxTokens: 16000 });
      I.saveState();
      return r;
    } catch (e) { log('kanalen overzicht:', e.status || '', e.message); I.saveState(); return null; }
  }
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.05, 0.02 * Math.abs(b));
  function compare(rows, sh) {
    const used = new Set();
    const ok = [], miss = [], diff = [];
    for (const x of rows) {
      const isDiv = x.type === 'Dividend';
      const pool = isDiv ? (sh.div || []).map((d, i) => ({ ...d, key: `d${i}` })) : sh.tx.map((t, i) => ({ ...t, key: `t${i}` }));
      const same = pool.filter((t) => !used.has(t.key) && UP(t.stock) === UP(x.aandeel) && (isDiv || t.type === x.type) && t.date && x.datum && dayDiff(t.date, x.datum) <= (isDiv ? 10 : 5));
      const exact = same.find((t) => (isDiv ? !(x.totaal_eur > 0) || near(t.amount, x.totaal_eur) : Math.abs(t.qty - x.aantal) < 1e-6 && (!(x.totaal_eur > 0) || !(t.total > 0) || near(t.total, x.totaal_eur))));
      if (exact) { used.add(exact.key); ok.push(x); continue; }
      if (same.length) { used.add(same[0].key); diff.push({ x, t: same[0] }); continue; }
      miss.push(x);
    }
    const dates = rows.map((x) => x.datum).filter(Boolean).sort();
    const from = dates[0], to = dates[dates.length - 1];
    const extra = from ? sh.tx.filter((t, i) => !used.has(`t${i}`) && t.date >= from && t.date <= to).length : 0;
    return { ok, miss, diff, extra, from, to };
  }
  const rowLine = (x) => (x.type === 'Dividend'
    ? `Dividend · ${x.aandeel} · ${x.totaal_eur > 0 ? eur(x.totaal_eur) : '?'} · ${dmy(x.datum)}`
    : `${TYPE_NL[x.type]} · ${x.aantal > 0 ? num(x.aantal) : '?'} × ${x.aandeel} · ${x.totaal_eur > 0 ? eur(x.totaal_eur) : '?'} · ${dmy(x.datum)}`);
  const diffLine = ({ x, t }) => {
    if (x.type === 'Dividend') return `Dividend ${x.aandeel} ${dmy(x.datum)}: overzicht ${eur(x.totaal_eur)}, sheet ${eur(t.amount)}`;
    const what = `${TYPE_NL[x.type].toLowerCase()} ${x.aandeel} ${dmy(x.datum)}`;
    if (Math.abs(t.qty - x.aantal) >= 1e-6) return `${what}: overzicht ${num(x.aantal)} stuks, sheet ${num(t.qty)} stuks`;
    return `${what}: overzicht ${eur(x.totaal_eur)}, sheet ${eur(t.total)}`;
  };
  const capList = (arr, f) => arr.slice(0, MAX_LIST).map((x) => `   ${f(x)}`).concat(arr.length > MAX_LIST ? [`   … en nog ${arr.length - MAX_LIST}`] : []);
  async function statementCompare(jid, member, r) {
    const sh = await I.sheetRows(member);
    if (!sh) { await I.send(jid, 'Ik kan je sheet nu niet lezen. Probeer het straks nog eens.'); return true; }
    const c = compare(r.rijen, sh);
    const lines = [`📄 Ik vergeleek je overzicht met je sheet (${plural(r.rijen.length, 'rij', 'rijen')}${c.from ? `, ${dmy(c.from)} – ${dmy(c.to)}` : ''}):`];
    lines.push(`✓ ${c.ok.length} ${c.ok.length === 1 ? 'klopt' : 'kloppen'}`);
    if (c.miss.length) lines.push(`+ ${c.miss.length} ${c.miss.length === 1 ? 'ontbreekt' : 'ontbreken'} in je sheet:`, ...capList(c.miss, rowLine));
    if (c.diff.length) lines.push(`≠ ${c.diff.length} ${c.diff.length === 1 ? 'verschilt' : 'verschillen'}:`, ...capList(c.diff, diffLine));
    if (c.extra) lines.push(`(${plural(c.extra, 'rij', 'rijen')} in je sheet uit die periode ${c.extra === 1 ? 'staat' : 'staan'} niet op dit overzicht. Een andere broker?)`);
    if (c.diff.length) lines.push('', 'Wat verschilt, pas je best zelf aan in je sheet: ik weet niet welke van de twee juist is.');
    if (!c.miss.length) {
      if (!c.diff.length) lines.push('', 'Alles staat erin. 👍');
      delete state.pending[jid]; I.saveState();
      await I.send(jid, lines.join('\n'));
      return true;
    }
    const kinds = [...new Set(c.miss.map((x) => TYPE_NL[x.type].toLowerCase()))];
    const what = c.miss.length === 1 ? `de ontbrekende ${kinds[0]}` : `de ${c.miss.length} ontbrekende rijen`;
    lines.push('', `Zal ik ${what} ingeven? Antwoord *ja* of *stop*.`);
    state.pending[jid] = { stage: 'overzicht', member, at: Date.now(), tries: 0, sheet: sh,
      r: { is_transactie: true, zekerheid: 1, onduidelijk: [], rijen: c.miss.map((x) => ({ ...x, dup_ok: true })) },
      ...(I.virt.get(jid)?.via ? {} : { via: 'overzicht' }) };
    I.saveState();
    await I.send(jid, lines.join('\n'));
    return true;
  }
  async function confirmOverzicht(jid, p) {
    const msg = await I.advance(jid, p);                              // welk aandeel, prijs, bezit: dezelfde controles
    p.at = Date.now(); state.pending[jid] = p; I.saveState();
    if (p.stage === 'voorstel' && !I.problems(p.r).length) return invoer.handle({ jid, name: p.member, text: 'ja' });
    await I.send(jid, msg);
    return true;
  }
  // Een document (CSV, XLSX, PDF) van een lid: één borderel gaat de gewone weg, een overzicht wordt vergeleken.
  async function documentFlow(jid, member, files, text) {
    const bad = files.find((f) => f.unsupported);
    const tables = files.filter((f) => f.table), docs = files.filter((f) => f.doc), imgs = files.filter((f) => f.img && !f.doc);
    if (!tables.length && !docs.length) {
      if (bad) { await I.send(jid, `${bad.name} kan ik niet lezen. Bewaar het als .xlsx, .csv of .pdf en stuur het opnieuw.`); return true; }
      return false;
    }
    const body = [text || '', ...tables.map((t) => `BESTAND ${t.name}:\n${t.text}`)].join('\n\n').trim();
    const r = await readDocument(jid, member, body, [...docs, ...imgs].map((f) => f.img));
    if (r === 'budget') { await I.send(jid, 'Genoeg gelezen voor vandaag. Morgen weer, of zet het zelf in je sheet.'); return true; }
    if (!r) { await I.send(jid, 'Ik kon het bestand nu niet lezen. Probeer het later nog eens.'); return true; }
    I.normalize(r);
    if (!r.is_transactie || !r.rijen?.length) {
      if ((r.posities || []).length) return I.positionsCheck(jid, member, r.posities);
      await I.send(jid, 'Ik vind geen aankopen, verkopen of dividenden in dat bestand.');
      return true;
    }
    if (!tables.length && r.rijen.length <= 2) { await I.step(jid, { member, r, tries: 0 }); return true; }   // één borderel
    return statementCompare(jid, member, r);
  }
  // Antwoord op een openstaand overzicht ("ja" / "stop"); anders niets.
  async function intercept(jid, text) {
    const p = state.pending[jid];
    if (p?.stage !== 'overzicht') return null;
    if (Date.now() - p.at > 24 * 3600 * 1000) { delete state.pending[jid]; I.saveState(); return null; }
    if (I.YES.test(text)) return confirmOverzicht(jid, p);
    delete state.pending[jid]; I.saveState();
    if (I.NO.test(text)) { await I.send(jid, 'Oké, niets ingegeven.'); return true; }
    return null;                                                    // iets anders: gewoon verder
  }

  // ---------- WhatsApp (privé) ----------
  async function handleDM({ jid, name, text = '', files = [] }) {
    const raw = text.trim();
    const isAdmin = jid === adminJid();
    const member = state.members[jid] || (isAdmin ? 'Gilles' : null);
    if (isAdmin && /^\/formulieren\b/i.test(raw)) {
      const u = I.config().webapp_url;
      await I.send(jid, u ? `📝 Persoonlijke formulier-links:\n${I.MEMBERS.map((m) => `• ${m}: ${formLink(m)}`).join('\n')}` : 'Er is nog geen webapp ingesteld.');
      return true;
    }
    if (/^\/formulier\b/i.test(raw)) {
      if (!member) { await I.send(jid, 'Ik ken je nummer nog niet. Geef eerst één transactie door (screenshot of tekst), dan koppel ik je nummer en krijg je je link.'); return true; }
      const link = formLink(member);
      await I.send(jid, link
        ? `📝 Jouw formulier, ${member}:\n${link}\n\nZet het op je beginscherm (Delen → Zet op beginscherm). De link is persoonlijk: alles wat je ermee ingeeft, komt in jouw sheet.`
        : 'Het formulier staat nog niet aan.');
      return true;
    }
    const got = await intercept(jid, raw);
    if (got !== null) return got;
    const inputs = files.map(fileInput).filter(Boolean);
    if (!inputs.length) return false;
    if (!member) {
      state.pending[jid] = { stage: 'wie', at: Date.now() }; I.saveState();
      await I.send(jid, `Ik ken je nummer nog niet. Wie ben je? Antwoord met je voornaam: ${I.MEMBERS.join(', ')}. Stuur het bestand daarna nog eens.`);
      return true;
    }
    await getSock().sendPresenceUpdate('composing', jid).catch(() => {});
    return documentFlow(jid, member, inputs, raw);
  }

  // ---------- mail ----------
  const brokerOf = (m) => {
    const hay = `${m.from} ${m.subject} ${(m.body || '').slice(0, 3000)}`.toLowerCase();
    return (BROKERS.find(([k]) => hay.includes(k)) || [null, 'Je broker'])[1];
  };
  function newPart(m) {
    let body = String(m.body || '').replace(/\r/g, '');
    if (m.reply) {                                                  // alleen het nieuwe stuk van een antwoord
      const cut = body.search(/^(>|Op .{5,120}(schreef|wrote)|On .{5,120}wrote|Le .{5,120}écrit|-{2,}\s*(Original|Oorspronkelijk)|Van: |From: |_{8,})/m);
      if (cut >= 0) body = body.slice(0, cut);
      return body.trim().slice(0, 8000);
    }
    return `${m.subject || ''}\n${body}`.trim().slice(0, 20000);
  }
  const toPlain = (t) => t.replace(/\*([^*\n]+)\*/g, '$1');
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const toHtml = (t) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${esc(t).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>`;
  const SIGN = '\n\n— Claude, de bot van de kwartaalmeeting';
  const thanksOnly = (t) => t.length < 120 && !/\d/.test(t);

  async function mailFromMember(m) {
    const member = m.member, vjid = `mail:${member}`;
    const box = [];
    I.virt.set(vjid, { member, via: 'mail', sink: (t) => box.push(t) });
    try {
      const text = newPart(m);
      const inputs = (m.attachments || []).map((a) => fileInput({ name: a.name, mime: a.mime, data: Buffer.from(a.data, 'base64') })).filter(Boolean);
      let handled = await intercept(vjid, text);
      if (handled === null) {
        if (inputs.some((f) => f.table || f.doc || f.unsupported)) handled = await documentFlow(vjid, member, inputs, text);
        else handled = await invoer.handle({ jid: vjid, name: member, text, imgs: inputs.filter((f) => f.img).map((f) => f.img) });
      }
      const p = state.pending[vjid];
      if (handled && p?.stage === 'voorstel' && !I.problems(p.r).length && !(p.r.onduidelijk || []).length) {
        const lines = p.r.rijen.map((x) => `• ${rowLine(x)}`).join('\n');   // geen twijfel: meteen in de sheet
        box.length = 0;
        await invoer.handle({ jid: vjid, name: member, text: 'ja' });
        const okMsg = box.find((t) => /^✅ Staat in je sheet/.test(t));
        const rest = box.filter((t) => t !== okMsg);
        if (okMsg) return [`Dag ${member},\n\nIk heb dit in je sheet gezet:\n${lines}\n\nDe maandagscan neemt het mee. Klopt er iets niet? Antwoord "zet het terug" en ik haal het weer weg.`, ...rest].join('\n\n');
        return box.join('\n\n');
      }
      if (!handled) {
        if (thanksOnly(text) && !inputs.length) return null;
        return `Dag ${member},\n\nIk vond geen aankoop, verkoop of dividend in je mail. Stuur een screenshot of borderel van je broker, ` +
          `een overzicht (CSV, Excel of PDF), of schrijf het zo: "Kocht 10 ASML voor € 6.512 op 7/10".`;
      }
      return box.length ? `Dag ${member},\n\n${box.join('\n\n')}` : null;
    } finally {
      I.virt.set(vjid, { member, via: 'mail', sink: (t) => log('kanalen: mailbericht na afloop:', t.slice(0, 80)) });
    }
  }
  async function brokerAlert(m) {
    const member = m.fwdMember, jid = jidOf(member);
    if (!jid) { admin(`📨 Er kwam een broker-melding voor ${member} binnen, maar ik ken ${member === 'Gilles' ? 'je' : 'zijn'} WhatsApp-nummer niet. Niets mee gedaan.`); return 'done'; }
    if (state.pending[jid] && Date.now() - state.pending[jid].at < 3 * 3600 * 1000) return 'later';   // eerst het lopende gesprek afmaken
    const inputs = (m.attachments || []).map((a) => fileInput({ name: a.name, mime: a.mime, data: Buffer.from(a.data, 'base64') })).filter((f) => f?.img);
    if (!I.budgetOk(jid)) return 'later';                             // ook nodig om de dagteller te starten
    const r = await I.readSmart({ member, text: newPart({ ...m, reply: false }), imgs: inputs.map((f) => f.img) }, jid);
    I.saveState();
    if (!r) return 'retry';
    if (!r.is_transactie || !r.rijen?.length) {
      // Bolero mailt sinds eind 2025 alleen "er staat een nieuw document klaar", zonder details: dan een seintje
      const broker = brokerOf(m);
      const hay = `${m.subject} ${(m.body || '').slice(0, 3000)}`;
      if (broker !== 'Je broker' && /(uittreksel|borderel|afrekening|document|order|uitvoering|transactie|execution|trade|confirmation)/i.test(hay)
          && Date.now() - (ks.nudged[member] || 0) > 6 * 3600 * 1000) {
        ks.nudged[member] = Date.now(); saveKs();
        await I.send(jid, `📨 ${broker} meldt dat er een nieuw document klaarstaat. Heb je gehandeld? Stuur me het borderel (pdf) of een screenshot, dan kijk ik of het al in je sheet staat en zet ik het erin.`);
      } else log(`kanalen: melding zonder transactie (${m.subject})`);
      return 'done';
    }
    await I.step(jid, { member, r, tries: 0, via: 'brokermelding' }, `📨 ${brokerOf(m)} meldt een transactie.\n\n`);
    return 'done';
  }
  async function mailDone(id, reply) {
    const out = await webapp(reply ? { action: 'mail_done', id, reply: toPlain(reply) + SIGN, html: toHtml(reply + SIGN) } : { action: 'mail_done', id });
    if (!out.ok) throw new Error(out.error || 'mail_done mislukt');
    delete ks.tries[id]; saveKs();
  }
  async function handleMail(m) {
    ks.tries[m.id] = (ks.tries[m.id] || 0) + 1; saveKs();
    if (ks.tries[m.id] > 3) { await mailDone(m.id); admin(`⚠️ Een mail aan het invoeradres (${m.subject || 'zonder onderwerp'}, van ${m.from}) lukte drie keer niet. Bekijk ze zelf.`); return; }
    if (m.member) {
      const reply = await mailFromMember(m);
      await mailDone(m.id, reply);
      return;
    }
    if (m.fwdMember) {
      const st = await brokerAlert(m);
      if (st === 'done') await mailDone(m.id);
      else if (st === 'later') { ks.tries[m.id] -= 1; saveKs(); }
      return;
    }
    await mailDone(m.id);
    admin(`📭 Mail van een onbekend adres aan het invoeradres (${m.from}: ${m.subject || 'zonder onderwerp'}). Niets mee gedaan.`);
  }
  function formEvent(ev) {
    const rows = ev.rows || [];
    if (!rows.length) return;
    const jid = jidOf(ev.member);
    if (jid) { state.last[jid] = { member: ev.member, at: Date.parse(ev.at) || Date.now(), rows: rows.map((x) => ({ row: x.row, stock: x.stock, type: x.type, date: x.date })) }; I.saveState(); }
    if (jid !== adminJid()) admin(`📥 ${ev.member} gaf ${plural(rows.length, 'transactie', 'transacties')} door via het formulier: ${rows.map((x) => `${TYPE_NL[x.type] || x.type} ${x.stock}`).join(', ')}`);
  }
  let polling = false, lastErr = '';
  async function poll() {
    if (polling || !I.config().webapp_url) return;
    polling = true;
    try {
      const out = await webapp({ action: 'inbox' });
      if (!out.ok) { if (out.error !== lastErr) log('kanalen inbox:', out.error); lastErr = out.error; return; }
      lastErr = '';
      for (const ev of out.events || []) formEvent(ev);
      for (const m of out.mails || []) {
        try { await handleMail(m); } catch (e) { log('kanalen mail:', e.stack || e.message); }
      }
    } catch (e) { if (e.message !== lastErr) log('kanalen inbox:', e.message); lastErr = e.message; }
    finally { polling = false; }
  }
  if (jobs) { setTimeout(poll, 90 * 1000); setInterval(poll, POLL_MS); }

  // ---------- http: koers voor de prijscontrole van het formulier ----------
  async function http(req, res) {
    if (!req.url.startsWith('/api/koers')) return false;
    const q = new URL(req.url, 'http://x').searchParams;
    const stock = I.stockList().find((n) => UP(n) === UP(q.get('aandeel')));
    const date = q.get('datum') || '';
    let body = { ok: false };
    if (stock && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const ref = await I.refPrice(stock, date).catch(() => null);
      if (ref) body = { ok: true, stock, price_eur: ref.price_eur, date: ref.date };
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
  }

  return { handleDM, poll, http, formLink, _internals: { xlsxToCsv, fileInput, compare, handleMail, mailFromMember, brokerAlert, documentFlow, statementCompare, intercept, formKey, newPart, ks } };
}
