// Transacties doorgeven via WhatsApp (alleen in een privégesprek met de bot).
//
// Een lid stuurt een screenshot van zijn broker of typt wat hij kocht of verkocht.
// 1. Haiku leest het (goedkoop). Twijfelt Haiku, kent hij het aandeel niet of klopt er iets niet,
//    dan leest Sonnet het opnieuw.
// 2. Claude toont de regel(s) en vraagt "klopt dit?". Het lid zegt ja, of zegt wat er anders moet.
// 3. Na "ja" zet een Apps Script-webapp (op Gilles' Google-account) de rij in de EIGEN sheet van het lid.
//    De master blijft alleen via de maandagscan veranderen, dus de sheet blijft de enige bron.
//
// Geen webapp-adres ingesteld? Dan bewaart de bot de goedgekeurde rijen in data/invoer_queue.json
// en krijgt Gilles een bericht, zodat er niets verloren gaat.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const MEMBERS = ['Gilles', 'Kevin', 'Robbe', 'Joran', 'Arno', 'Pieter', 'Haakon', 'Jeff', 'Niels', 'Tom'];
const MODELS = { fast: 'claude-haiku-5-5', strong: 'claude-sonnet-5-5' };
// $ per miljoen tokens (platform.claude.com/docs/en/about-claude/pricing, okt 2026)
const PRICE = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.10, cw: 2.5 },
};
const LIMITS = { perPersonDay: 25, totalDay: 120 };              // leesbeurten (Haiku + Sonnet samen)
const PENDING_TTL = 24 * 3600 * 1000;
const IMAGE_TTL = 60 * 60 * 1000;
const TX_WORDS = /\b(ge|aan|bij)?(kocht|koop|aankoop|verkocht|verkoop|bought|sold|buy|sell)\b|\bdividend/i;
const YES = /^\s*(ja+|jaja|jep|yes|ok(e|é|ay)?|klopt|correct|juist|in orde|doe maar|top|perfect|👍|✅)[\s!.👍✅]*$/iu;
const NO = /^\s*(nee+|neen|stop|annuleer|annuleren|laat maar|cancel|❌)[\s!.]*$/iu;

const eur = (x) => new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(x);
const num = (x) => new Intl.NumberFormat('nl-BE', { maximumFractionDigits: 6 }).format(x);
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '?');
const TYPE_NL = { Buy: 'Aankoop', Sell: 'Verkoop', Dividend: 'Dividend' };

const TOOL = {
  name: 'transacties',
  description: 'Geef de transacties terug die je in het bericht en/of de afbeelding leest.',
  input_schema: {
    type: 'object',
    properties: {
      is_transactie: { type: 'boolean', description: 'true als het bericht een aankoop, verkoop of ontvangen dividend doorgeeft. false voor een portefeuilleoverzicht, grafiek, nieuws, meme of een gewone vraag.' },
      rijen: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['Buy', 'Sell', 'Dividend'] },
            aandeel: { type: 'string', description: 'Exacte naam uit de AANDELENLIJST als het aandeel erin staat. Anders de naam zoals op de afbeelding, in hoofdletters, zonder NV/SA/Inc/Holding.' },
            in_lijst: { type: 'boolean', description: 'true als "aandeel" letterlijk in de AANDELENLIJST staat.' },
            aantal: { type: ['number', 'null'], description: 'Aantal stuks. null bij dividend of als het nergens staat.' },
            totaal_eur: { type: ['number', 'null'], description: 'Buy: totaal dat van de rekening ging, kosten en taksen inbegrepen. Sell: totaal dat op de rekening kwam, na kosten en taksen. Dividend: netto ontvangen bedrag. Alleen in euro; null als je het bedrag niet in euro ziet.' },
            munt_gezien: { type: 'string', description: 'De munt van het totaal zoals je het ziet, bv. EUR of USD.' },
            datum: { type: ['string', 'null'], description: 'Uitvoerings- of betaaldatum als YYYY-MM-DD. Ontbreekt het jaar: het jongste jaar dat niet in de toekomst ligt. null als er geen datum is.' },
            kandidaten: { type: 'array', items: { type: 'string' }, description: 'Alleen bij twijfel: tot 3 namen uit de AANDELENLIJST die kunnen passen. Leeg als het zeker één naam is.' },
            isin: { type: ['string', 'null'], description: 'De ISIN (2 letters + 10 tekens) als die op de afbeelding of in het bericht staat, anders null.' },
          },
          required: ['type', 'aandeel', 'in_lijst', 'aantal', 'totaal_eur', 'munt_gezien', 'datum'],
        },
      },
      onduidelijk: { type: 'array', items: { type: 'string' }, description: 'Wat je niet zeker weet of wat ontbreekt, als korte vragen in het Nederlands aan het lid.' },
      zekerheid: { type: 'number', description: 'Hoe zeker je bent dat alle rijen juist zijn, tussen 0 en 1.' },
    },
    required: ['is_transactie', 'rijen', 'onduidelijk', 'zekerheid'],
  },
};

const RULES = `Je leest transacties uit berichten van leden van een beleggingsclub (tien vrienden, Belgen). ` +
  `Ze sturen een screenshot van hun broker (meestal Bolero, soms DEGIRO, Keytrade of Revolut) of typen wat ze deden. ` +
  `Roep altijd de tool "transacties" aan, ook als er geen transactie in staat.\n\n` +
  `Regels:\n` +
  `- Eén rij per transactie. Een screenshot met meerdere transacties geeft meerdere rijen.\n` +
  `- Buy = aankoop, Sell = verkoop, Dividend = ontvangen dividend.\n` +
  `- totaal_eur is het TOTAAL in euro, niet de koers per aandeel. Bij een aankoop: inclusief makelaarsloon en beurstaks. Bij een verkoop: wat er netto binnenkwam. Bij dividend: het netto bedrag na roerende voorheffing.\n` +
  `- Staat het totaal alleen in een andere munt (bv. dollar), zet totaal_eur op null en munt_gezien op die munt. Reken zelf NIET om.\n` +
  `- Staat er geen totaal maar wel aantal en koers in euro, reken dan aantal x koers uit en meld in "onduidelijk" dat de kosten er niet in zitten.\n` +
  `- Gebruik voor "aandeel" de naam uit de AANDELENLIJST hieronder als het hetzelfde bedrijf of fonds is (bv. "ASML Holding NV" wordt "ASML").\n` +
  `- Twijfel je tussen meerdere namen uit de AANDELENLIJST (fondsen met een gelijkaardige naam, aandelenklassen, een naam die maar half overeenkomt), zet ze dan in "kandidaten" en kies niet zelf. Is het zeker één naam, laat "kandidaten" leeg.\n` +
  `- Verzin niets. Wat je niet ziet, is null, en je zet een vraag in "onduidelijk".\n` +
  `- Een portefeuilleoverzicht (posities en waarde) is GEEN transactie.\n` +
  `- Komt er een vorige versie en een correctie van het lid mee, pas dan de vorige versie aan volgens de correctie. Wat het lid zegt, gaat voor op de afbeelding.\n` +
  `- "onduidelijk" bevat ALLEEN vragen die echt nog open staan, kort en aan het lid gericht ("je"). Is alles duidelijk, laat het leeg. Herhaal niet wat het lid al zei en leg niet uit wat je deed.`;

export function createInvoer({ anthropic, getSock, log, dataDir, hereDir, adminJid, claudeTag = '🤖 Claude: ' }) {
  const STATE_FILE = join(dataDir, 'invoer.json');
  const USAGE_FILE = join(dataDir, 'invoer_usage.json');
  const QUEUE_FILE = join(dataDir, 'invoer_queue.json');
  const load = (f, d) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d; } catch { return d; } };
  const save = (f, obj) => { writeFileSync(`${f}.tmp`, JSON.stringify(obj, null, 1)); renameSync(`${f}.tmp`, f); };
  let state = load(STATE_FILE, {});
  state.members ||= {}; state.pending ||= {}; state.day ||= {};
  const saveState = () => save(STATE_FILE, state);
  const images = new Map();                                       // jid -> { images, at } (alleen in het geheugen)

  const config = () => load(join(hereDir, 'invoer_config.json'), {});
  const token = () => createHash('sha256').update(`kwartaal-invoer|${process.env.ANTHROPIC_API_KEY || ''}`).digest('hex').slice(0, 32);
  const send = (jid, text) => getSock().sendMessage(jid, { text: claudeTag + text });

  function stockList() {
    try { return Object.keys(JSON.parse(readFileSync(join(hereDir, 'tickers.json'), 'utf8'))).sort(); }
    catch { return []; }
  }

  // ---------- budget ----------
  const today = () => new Date().toISOString().slice(0, 10);
  function budgetOk(jid) {
    if (state.day.date !== today()) state.day = { date: today(), total: 0, per: {} };
    return (state.day.per[jid] || 0) < LIMITS.perPersonDay && state.day.total < LIMITS.totalDay;
  }
  function spend(jid) { state.day.total += 1; state.day.per[jid] = (state.day.per[jid] || 0) + 1; }

  function track(model, u = {}) {
    const all = load(USAGE_FILE, {});
    const m = today().slice(0, 7);
    all[m] ||= {};
    const r = (all[m][model] ||= { calls: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, usd: 0 });
    const p = PRICE[model] || PRICE[MODELS.strong];
    r.calls += 1; r.in += u.input_tokens || 0; r.out += u.output_tokens || 0;
    r.cache_read += u.cache_read_input_tokens || 0; r.cache_write += u.cache_creation_input_tokens || 0;
    r.usd = +(r.in * p.in / 1e6 + r.out * p.out / 1e6 + r.cache_read * p.cr / 1e6 + r.cache_write * p.cw / 1e6).toFixed(4);
    save(USAGE_FILE, all);
  }

  // ---------- lezen ----------
  async function read({ model, member, text, imgs, previous, correction }) {
    const parts = [];
    for (const i of imgs || []) parts.push({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } });
    let prompt = `Vandaag is het ${today()}.\n`;
    if (previous) prompt += `\nVORIGE VERSIE (die jij eerder las):\n${JSON.stringify(previous)}\n\nCORRECTIE VAN HET LID: "${correction}"\n`;
    else prompt += `\nBericht van het lid: "${text || '(alleen een afbeelding)'}"\n`;
    parts.push({ type: 'text', text: prompt });
    const req = {
      model,
      max_tokens: 2000,
      system: [
        { type: 'text', text: RULES },
        { type: 'text', text: `AANDELENLIJST (namen zoals in de sheets van de club):\n${stockList().join('\n')}`, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL],
      messages: [{ role: 'user', content: parts }],
    };
    if (model === MODELS.strong) req.thinking = { type: 'between_tools' };   // Sonnet 5.5: geen gedwongen tool_choice
    else req.tool_choice = { type: 'any' };
    const res = await anthropic.messages.create(req);
    track(model, res.usage);
    const u = res.usage || {};
    log(`invoer ${model}: in=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} out=${u.output_tokens}`);
    const block = (res.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL.name);
    if (!block) throw new Error('geen tool-antwoord');
    return { ...block.input, model };
  }

  // Code-controle bovenop wat het model zegt.
  function problems(r) {
    const out = [];
    for (const [i, row] of (r.rijen || []).entries()) {
      const n = (r.rijen.length > 1) ? ` (rij ${i + 1})` : '';
      if (row.type !== 'Dividend' && !(row.aantal > 0)) out.push(`Hoeveel stuks${n}?`);
      if (!(row.totaal_eur > 0)) out.push(row.munt_gezien && row.munt_gezien !== 'EUR'
        ? `Ik zie het totaal in ${row.munt_gezien}. Hoeveel euro ging er${row.type === 'Buy' ? ' van je rekening' : ' naar je rekening'}${n}? (staat op je uittreksel)`
        : `Wat was het totaal in euro${n}?`);
      if (!row.datum || !/^\d{4}-\d{2}-\d{2}$/.test(row.datum)) out.push(`Op welke datum${n}?`);
      else if (row.datum > today()) out.push(`De datum${n} ligt in de toekomst. Klopt ${dmy(row.datum)}?`);
      else if (row.datum < '2021-01-01') out.push(`De datum${n} is wel heel oud. Klopt ${dmy(row.datum)}?`);
    }
    return out;
  }
  const needsStrong = (r) => !r || r.zekerheid < 0.8 || (r.rijen || []).some((x) => !x.in_lijst);

  // ---------- controles vóór het voorstel ----------
  const UP = (x) => String(x || '').trim().toUpperCase();
  const ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/;
  const FLAGS = ['keuze_ok', 'dup_ok', 'prijs_ok', 'bezit_ok', 'force', 'nieuw'];
  const dayDiff = (a, b) => Math.abs((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 864e5);
  const GENERIC = new Set(['ISHARES', 'AMUNDI', 'XTRACKERS', 'VANGUARD', 'SPDR', 'LYXOR', 'INVESCO', 'WISDOMTREE', 'VANECK', 'FRANKLIN', 'MSCI', 'FTSE', 'ETF', 'UCITS', 'ACC', 'DIST', 'GLOBAL', 'WORLD', 'INDEX', 'FUND', 'CORP', 'INC', 'GROUP', 'HOLDING', 'HOLDINGS', 'THE', 'AND', 'CLASS']);
  const toks = (x) => UP(x).replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);

  function normalize(r) {                                          // namen gelijkzetten met de lijst, in_lijst door de code laten bepalen
    const byUp = new Map(stockList().map((n) => [UP(n), n]));
    for (const x of r.rijen || []) {
      const hit = byUp.get(UP(x.aandeel));
      if (hit) { x.aandeel = hit; x.in_lijst = true; } else if (!x.nieuw) x.in_lijst = false;
      if (x.isin) { const m = UP(x.isin).replace(/\s/g, '').match(ISIN_RE); x.isin = m ? m[1] : null; }
    }
  }
  function candidates(x) {
    const list = stockList();
    const byUp = new Map(list.map((n) => [UP(n), n]));
    let c = (x.kandidaten || []).map((k) => byUp.get(UP(k))).filter(Boolean);
    if (!c.length && !x.in_lijst) {
      const mine = toks(x.aandeel);
      c = list.map((n) => { const t = toks(n); let sc = 0; for (const w of mine) if (t.includes(w)) sc += GENERIC.has(w) ? 0.5 : 2; return [n, sc]; })
        .filter((v) => v[1] >= 2).sort((a, b) => b[1] - a[1]).map((v) => v[0]);
    }
    if (x.in_lijst) c = [x.aandeel, ...c.filter((n) => n !== x.aandeel)];
    return [...new Set(c)].slice(0, 3);
  }
  async function sheetRows(member) {                               // alleen lezen, via de webapp
    const url = config().webapp_url;
    if (!url) return null;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, redirect: 'follow',
        body: JSON.stringify({ token: token(), action: 'lookup', member }) });
      const out = JSON.parse(await res.text());
      if (out.ok && Array.isArray(out.tx)) return out;
      log('invoer lookup:', out.error || 'geen rijen');
    } catch (e) { log('invoer lookup:', e.message); }
    return null;
  }
  async function refPrice(stock, date) {                           // slotkoers in euro op die dag (of de eerste beursdag erna)
    try {
      const t = JSON.parse(readFileSync(join(hereDir, 'tickers.json'), 'utf8'))[stock];
      if (!t) return null;
      const { closeOn, quote } = await import('./trader.mjs');
      const d = date > today() ? today() : date;
      const c = await closeOn(t, d).catch(() => null);
      if (c?.price_eur) return { price_eur: c.price_eur, date: c.date };
      if (dayDiff(d, today()) <= 3) { const q = await quote(t); if (q?.price_eur) return { price_eur: q.price_eur, date: today() }; }
    } catch (e) { log('invoer koers:', stock, e.message); }
    return null;
  }
  const rowTag = (r, i) => (r.rijen.length > 1 ? ` (rij ${i + 1})` : '');
  const sheetLine = (h, isDiv) => (isDiv
    ? `Dividend · ${h.stock} · ${h.amount > 0 ? eur(h.amount) : '?'} · ${dmy(h.date)}`
    : `${TYPE_NL[h.type] || h.type} · ${num(h.qty)} × ${h.stock} · ${h.total > 0 ? eur(h.total) : '?'} · ${dmy(h.date)}`);

  // Zet p.stage en geeft het bericht terug. Volgorde: welk aandeel → wat ontbreekt → dubbel → prijs → bezit → voorstel.
  async function advance(jid, p) {
    const r = p.r;
    normalize(r);
    // welk aandeel en de ISIN vraagt de code zelf; dezelfde vraag van het model niet nog eens stellen
    r.onduidelijk = (r.onduidelijk || []).filter((q) => !/(lijst|welk(e)? (aandeel|fonds)|bedoel je (een|het|de)|nieuw (aandeel|fonds)|ISIN)/i.test(q));
    for (const [i, x] of r.rijen.entries()) {
      if (x.keuze_ok) continue;
      const opts = candidates(x);
      if (x.in_lijst && opts.length < 2) { x.keuze_ok = true; continue; }
      p.idx = i;
      if (opts.length) {
        p.stage = 'keuze'; p.opts = opts;
        const fund = opts.some((n) => /ISHARES|AMUNDI|XTRACKERS|VANGUARD|SPDR|ETF|MSCI|FTSE|INVESCO|WISDOMTREE|VANECK/.test(n));
        return `Welk ${fund ? 'fonds' : 'aandeel'} bedoel je${rowTag(r, i)}?${x.in_lijst ? '' : ` (op je ${images.get(jid) ? 'screenshot' : 'bericht'}: ${x.aandeel})`}\n` +
          opts.map((n, k) => `${k + 1}. ${n}`).join('\n') + `\n${opts.length + 1}. Een nieuw ${fund ? 'fonds' : 'aandeel'} voor de club\n\nAntwoord met het nummer.`;
      }
      p.stage = 'isin';
      return x.isin
        ? `${x.aandeel}${rowTag(r, i)} staat nog niet in de lijst van de club. Is het een nieuw aandeel (ISIN ${x.isin})? Antwoord *nieuw*, of zeg welk aandeel uit de lijst je bedoelt.`
        : `${x.aandeel}${rowTag(r, i)} staat nog niet in de lijst van de club. Is het nieuw, stuur dan de ISIN (12 tekens, staat bij de details in je broker-app), dan kan de maandagscan de koers vinden. Bedoel je een aandeel uit de lijst, zeg dan welk.`;
    }
    if (problems(r).length) { p.stage = 'voorstel'; return proposal(p.member, r); }   // eerst aanvullen, dan controleren

    if (p.sheet === undefined) p.sheet = (await sheetRows(p.member)) || false;
    const sh = p.sheet;
    if (sh) for (const [i, x] of r.rijen.entries()) {
      if (x.dup_ok) continue;
      const isDiv = x.type === 'Dividend';
      const hit = isDiv
        ? (sh.div || []).find((d) => UP(d.stock) === UP(x.aandeel) && d.date && dayDiff(d.date, x.datum) <= 5)
        : sh.tx.find((t) => UP(t.stock) === UP(x.aandeel) && t.type === x.type && Math.abs(t.qty - x.aantal) < 1e-6 && t.date && dayDiff(t.date, x.datum) <= 5);
      if (!hit) { x.dup_ok = true; continue; }
      p.stage = 'dubbel'; p.idx = i;
      return `Dit lijkt al in je sheet te staan${rowTag(r, i)}:\n*${sheetLine(hit, isDiv)}*\n\n` +
        `${hit.date !== x.datum ? `Jij gaf ${dmy(x.datum)} door. ` : ''}Is dat dezelfde ${isDiv ? 'uitbetaling' : TYPE_NL[x.type].toLowerCase()}?\n*zelfde* = niets doen · *nieuw* = toch ingeven`;
    }
    for (const [i, x] of r.rijen.entries()) {
      if (x.prijs_ok || x.type === 'Dividend' || !x.in_lijst) { x.prijs_ok = true; continue; }
      const ref = await refPrice(x.aandeel, x.datum);
      const per = x.totaal_eur / x.aantal;
      if (!ref || (per / ref.price_eur <= 1.25 && per / ref.price_eur >= 0.75)) { x.prijs_ok = true; continue; }
      p.stage = 'prijs'; p.idx = i;
      const k = Math.round(Math.log10((ref.price_eur * x.aantal) / x.totaal_eur));
      const guess = k !== 0 && Math.abs((x.totaal_eur * 10 ** k) / (ref.price_eur * x.aantal) - 1) < 0.25 ? x.totaal_eur * 10 ** k : null;
      return `Dat is ${eur(per)} per aandeel${rowTag(r, i)}. ${x.aandeel} stond ${ref.date === today() ? 'vandaag' : `op ${dmy(ref.date)}`} rond ${eur(ref.price_eur)}.\n` +
        (guess ? `Bedoel je *${eur(guess)}*? ` : 'Klopt het aantal en het totaal? ') +
        `Zeg het juiste totaal (of aantal) van je uittreksel, of *ja* als ${eur(x.totaal_eur)} toch klopt.`;
    }
    if (sh) for (const [i, x] of r.rijen.entries()) {
      if (x.bezit_ok || x.type !== 'Sell') { x.bezit_ok = true; continue; }
      let held = 0;
      for (const t of sh.tx) if (UP(t.stock) === UP(x.aandeel)) held += t.type === 'Buy' ? t.qty : t.type === 'Sell' ? -t.qty : 0;
      for (const y of r.rijen.slice(0, i)) if (UP(y.aandeel) === UP(x.aandeel)) held += y.type === 'Buy' ? y.aantal : y.type === 'Sell' ? -y.aantal : 0;
      if (x.aantal <= held + 1e-6) { x.bezit_ok = true; continue; }
      p.stage = 'bezit'; p.idx = i;
      return `Volgens je sheet heb je ${held > 1e-6 ? `*${num(held)} ${x.aandeel}*` : `geen ${x.aandeel}`}, dus ${num(x.aantal)} verkopen kan niet${rowTag(r, i)}.\n` +
        `Klopt het aantal, of ontbreekt er nog een aankoop in je sheet? Zeg het juiste aantal, of *ja* als het toch klopt.`;
    }
    p.stage = 'voorstel';
    return proposal(p.member, r);
  }
  async function step(jid, p, prefix = '') {
    await getSock().sendPresenceUpdate('composing', jid).catch(() => {});
    const msg = await advance(jid, p);
    p.at = Date.now();
    state.pending[jid] = p;
    saveState();
    await send(jid, prefix + msg);
  }
  const carry = (oldR, newR) => {                                  // beslissingen van het lid bewaren na een correctie
    for (const [i, y] of (newR.rijen || []).entries()) {
      const x = oldR?.rijen?.[i];
      if (!x || UP(x.aandeel) !== UP(y.aandeel) || x.type !== y.type) continue;
      for (const f of ['keuze_ok', 'nieuw', 'isin']) if (x[f] && !y[f]) y[f] = x[f];
      if (x.aantal === y.aantal && x.totaal_eur === y.totaal_eur && x.datum === y.datum) for (const f of ['dup_ok', 'force', 'prijs_ok', 'bezit_ok']) if (x[f]) y[f] = x[f];
    }
    return newR;
  };
  const clean = (r) => ({ ...r, rijen: (r.rijen || []).map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !FLAGS.includes(k)))) });

  async function readSmart(args, jid, forceStrong = false) {
    let r = null;
    if (!forceStrong) {
      spend(jid);
      try { r = await read({ ...args, model: MODELS.fast }); } catch (e) { log('invoer haiku:', e.status || '', e.message); }
      if (r && !r.is_transactie && !args.previous) return r;
    }
    if (forceStrong || needsStrong(r)) {                         // ontbrekende gegevens vraagt Claude aan het lid; Sonnet helpt daar niet
      if (!budgetOk(jid)) return r;
      spend(jid);
      try { r = await read({ ...args, model: MODELS.strong }); } catch (e) { log('invoer sonnet:', e.status || '', e.message); }
    }
    return r;
  }

  // ---------- tonen ----------
  function proposal(member, r) {
    const lines = r.rijen.map((x, i) => {
      const what = x.type === 'Dividend'
        ? `${TYPE_NL[x.type]} · ${x.aandeel} · ${x.totaal_eur > 0 ? eur(x.totaal_eur) : '?'} · ${dmy(x.datum)}`
        : `${TYPE_NL[x.type]} · ${x.aantal > 0 ? num(x.aantal) : '?'} × ${x.aandeel} · ${x.totaal_eur > 0 ? eur(x.totaal_eur) : '?'} · ${dmy(x.datum)}`;
      return `${r.rijen.length > 1 ? `${i + 1}. ` : ''}${what}${x.in_lijst ? '' : ` (nieuw voor de club${x.isin ? `, ISIN ${x.isin}` : ''})`}`;
    });
    const pr = problems(r);
    const ask = pr.length ? pr : (r.onduidelijk || []).slice(0, 3);
    let t = `Dit zet ik in de sheet van ${member}:\n${lines.join('\n')}`;
    if (pr.length) t += `\n\nNog even checken:\n${ask.map((q) => `• ${q}`).join('\n')}\n\nAntwoord gewoon met wat ontbreekt.`;
    else if (ask.length) t += `\n\nNog even checken:\n${ask.map((q) => `• ${q}`).join('\n')}\n\nKlopt alles? Antwoord *ja*, of zeg wat er anders moet.`;
    else t += `\n\nKlopt dit? Antwoord *ja*, of zeg wat er anders moet. *stop* om te annuleren.`;
    return t;
  }

  // ---------- schrijven ----------
  async function write(jid, member, rows) {
    const url = config().webapp_url;
    if (!url) {
      const q = load(QUEUE_FILE, []);
      q.push({ member, rows, at: new Date().toISOString() });
      save(QUEUE_FILE, q);
      const a = adminJid();
      if (a) await getSock().sendMessage(a, { text: claudeTag + `📥 ${member} gaf via WhatsApp door (nog niet automatisch in de sheet, zet het er zelf in):\n` +
        rows.map((x) => `• ${TYPE_NL[x.type]} ${x.type === 'Dividend' ? '' : `${num(x.shares)} × `}${x.stock} · ${eur(x.total_eur)} · ${dmy(x.date)}`).join('\n') }).catch(() => {});
      return { queued: true };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },                // Apps Script: geen CORS-preflight nodig
      body: JSON.stringify({ token: token(), action: 'append', member, source: 'WhatsApp', rows }),
      redirect: 'follow',
    });
    const txt = await res.text();
    let out; try { out = JSON.parse(txt); } catch { throw new Error(`webapp gaf geen JSON (HTTP ${res.status})`); }
    if (!out.ok) throw new Error(out.error || 'webapp weigerde');
    return out;
  }

  // ---------- gesprek ----------
  async function handle({ jid, name, text, imgs = [] }) {
    const raw = (text || '').trim();
    const isAdmin = jid === adminJid();
    if (isAdmin && /^\/invoer\b/i.test(raw)) { await send(jid, report()); return true; }

    const p = state.pending[jid];
    if (p && Date.now() - p.at > PENDING_TTL) { delete state.pending[jid]; saveState(); }
    const pending = state.pending[jid];
    const member = state.members[jid] || (isAdmin ? 'Gilles' : null);

    // Wie ben je? (eenmalig per nummer)
    if (pending?.stage === 'wie') {
      const pick = MEMBERS.find((m) => new RegExp(`^\\s*(ik ben\\s+)?${m}\\b`, 'i').test(raw));
      if (!pick) { await send(jid, `Ik ken je nummer nog niet. Wie ben je? Antwoord met je voornaam: ${MEMBERS.join(', ')}.`); return true; }
      const taken = Object.entries(state.members).find(([j, m]) => m === pick && j !== jid);
      if (taken) { await send(jid, `${pick} is al gekoppeld aan een ander nummer. Vraag Gilles om dat recht te zetten.`); delete state.pending[jid]; saveState(); return true; }
      state.members[jid] = pick;
      const a = adminJid();
      if (a && a !== jid) getSock().sendMessage(a, { text: claudeTag + `🔗 ${name} koppelde dit nummer aan ${pick} om transacties door te geven.` }).catch(() => {});
      const saved = pending.saved;
      delete state.pending[jid];
      if (saved?.r) {
        await step(jid, { member: pick, r: saved.r, tries: 0 }, `Dag ${pick}, genoteerd.\n\n`);
      } else { saveState(); await send(jid, `Dag ${pick}, genoteerd.`); }
      return true;
    }

    // Een controlevraag staat open
    if (['keuze', 'isin', 'dubbel', 'prijs', 'bezit'].includes(pending?.stage)) {
      if (NO.test(raw)) { delete state.pending[jid]; saveState(); await send(jid, 'Oké, niets ingegeven.'); return true; }
      const x = pending.r.rijen[pending.idx];
      if (!x) { delete state.pending[jid]; saveState(); return false; }
      if (pending.stage === 'keuze') {
        const n = (raw.match(/^\s*(\d)\b/) || [])[1];
        const byName = pending.opts.find((o) => UP(raw) === UP(o) || (UP(raw).length >= 4 && UP(o).includes(UP(raw))));
        if ((n && +n === pending.opts.length + 1) || /\bnieuw/i.test(raw)) {
          if (x.isin) { x.nieuw = true; x.in_lijst = false; x.keuze_ok = true; await step(jid, pending); return true; }
          pending.stage = 'isin'; pending.at = Date.now(); saveState();
          await send(jid, 'Nieuw voor de club. Stuur de ISIN (12 tekens, staat bij de details in je broker-app), dan kan de maandagscan de koers vinden.');
          return true;
        }
        const pick = n && +n >= 1 && +n <= pending.opts.length ? pending.opts[+n - 1] : byName;
        if (pick) { x.aandeel = pick; x.in_lijst = true; x.keuze_ok = true; delete x.kandidaten; await step(jid, pending); return true; }
        return correct(jid, pending, raw);
      }
      if (pending.stage === 'isin') {
        const m = UP(raw).replace(/[\s.-]/g, '').match(/([A-Z]{2}[A-Z0-9]{9}[0-9])/);
        const byUp = new Map(stockList().map((s) => [UP(s), s]));
        if (m) { x.isin = m[1]; x.nieuw = true; x.in_lijst = false; x.keuze_ok = true; await step(jid, pending); return true; }
        if (x.isin && (YES.test(raw) || /\bnieuw/i.test(raw))) { x.nieuw = true; x.in_lijst = false; x.keuze_ok = true; await step(jid, pending); return true; }
        if (byUp.has(UP(raw))) { x.aandeel = byUp.get(UP(raw)); x.in_lijst = true; x.keuze_ok = true; await step(jid, pending); return true; }
        if (raw.split(/\s+/).length <= 3 && !/\d/.test(raw)) {
          await send(jid, 'Dat is geen ISIN. Een ISIN heeft 12 tekens: 2 letters en dan 10 cijfers of letters, bv. IE00BMC38736. Stuur de ISIN, zeg welk aandeel uit de lijst je bedoelt, of *stop*.');
          return true;
        }
        return correct(jid, pending, raw);
      }
      if (pending.stage === 'dubbel') {
        if (/\b(zelfde|dezelfde|hetzelfde|al ingevuld|staat er al|al ingegeven)\b/i.test(raw)) {
          pending.r.rijen.splice(pending.idx, 1);
          if (!pending.r.rijen.length) { delete state.pending[jid]; saveState(); await send(jid, '👍 Dan doe ik niets. Geen dubbele rij.'); return true; }
          await step(jid, pending, 'Oké, die laat ik weg.\n\n'); return true;
        }
        if (/\b(nieuw|nieuwe|andere|tweede|toch)\b/i.test(raw)) { x.dup_ok = true; x.force = true; await step(jid, pending); return true; }
        if (YES.test(raw)) { await send(jid, 'Antwoord *zelfde* (dan doe ik niets) of *nieuw* (dan geef ik het toch in).'); return true; }
        return correct(jid, pending, raw);
      }
      if (YES.test(raw) || /^\s*(klopt( toch)?|toch juist|het klopt)[\s!.]*$/i.test(raw)) { x[pending.stage === 'prijs' ? 'prijs_ok' : 'bezit_ok'] = true; await step(jid, pending); return true; }
      return correct(jid, pending, raw);
    }

    // Een voorstel staat open: ja / stop / correctie
    if (pending?.stage === 'voorstel') {
      if (NO.test(raw)) { delete state.pending[jid]; saveState(); await send(jid, 'Oké, niets ingegeven.'); return true; }
      if (YES.test(raw)) {
        if (problems(pending.r).length) { await send(jid, `Er ontbreekt nog iets:\n${problems(pending.r).map((q) => `• ${q}`).join('\n')}`); return true; }
        const rows = pending.r.rijen.map((x) => ({ type: x.type, stock: x.aandeel, shares: x.type === 'Dividend' ? null : x.aantal, total_eur: x.totaal_eur, date: x.datum,
          ...(x.force ? { force: true } : {}), ...(x.nieuw && x.isin ? { isin: x.isin } : {}) }));
        delete state.pending[jid]; saveState();
        try {
          const out = await write(jid, pending.member, rows);
          if (out.queued) await send(jid, '✅ Goedgekeurd. Gilles zet het in je sheet; de maandagscan neemt het daarna mee.');
          else {
            const done = (out.results || []).filter((x) => x.status === 'written').length;
            const dup = (out.results || []).filter((x) => x.status === 'duplicate').length;
            let t = done ? `✅ Staat in je sheet${done > 1 ? ` (${done} rijen)` : ''}. De maandagscan neemt het mee.` : '';
            if (dup) t += `${t ? '\n' : ''}${dup > 1 ? `${dup} rijen stonden` : 'Die rij stond'} al in je sheet, dus niets dubbel ingegeven.`;
            await send(jid, t || 'Niets ingegeven.');
            const a = adminJid();
            if (a && a !== jid && done) getSock().sendMessage(a, { text: claudeTag + `📥 ${pending.member} gaf ${done} transactie${done > 1 ? 's' : ''} door via WhatsApp: ${[...new Set(rows.map((x) => x.stock))].join(', ')}` }).catch(() => {});
            const fresh = rows.filter((x) => x.isin);
            if (a && done && fresh.length) getSock().sendMessage(a, { text: claudeTag + `🆕 ${pending.member} gaf een nieuw aandeel door: ${fresh.map((x) => `${x.stock} (ISIN ${x.isin})`).join(', ')}. Staat nog niet in de lijst; de maandagscan vraagt de classificatie.` }).catch(() => {});
          }
        } catch (e) {
          log('invoer write:', e.message);
          await send(jid, 'Het lukte niet om het in je sheet te zetten. Ik heb Gilles verwittigd; probeer het later nog eens of zet het er zelf in.');
          const a = adminJid();
          if (a) getSock().sendMessage(a, { text: claudeTag + `⚠️ Invoer voor ${pending.member} mislukt: ${e.message}` }).catch(() => {});
        }
        return true;
      }
      return correct(jid, pending, raw);                            // correctie of aanvulling
    }

    // Nieuw bericht: is het een transactie?
    if (!imgs.length && !(TX_WORDS.test(raw) && /\d/.test(raw))) return false;
    if (imgs.length) images.set(jid, { images: imgs, at: Date.now() }); else images.delete(jid);   // een nieuwe transactie: oude screenshot vergeten
    for (const [j, v] of images) if (Date.now() - v.at > IMAGE_TTL) images.delete(j);
    if (!budgetOk(jid)) return false;

    await getSock().sendPresenceUpdate('composing', jid).catch(() => {});
    const r = await readSmart({ member, text: raw, imgs }, jid);
    saveState();
    if (!r || !r.is_transactie || !r.rijen?.length) return false;   // gewoon gesprek: Claude antwoordt zoals altijd

    if (!member) {
      state.pending[jid] = { stage: 'wie', at: Date.now(), saved: { r } };
      saveState();
      await send(jid, `Ik zie een transactie, maar ik ken je nummer nog niet. Wie ben je? Antwoord met je voornaam: ${MEMBERS.join(', ')}.`);
      return true;
    }
    await step(jid, { member, r, tries: 0 });
    return true;
  }

  async function correct(jid, pending, raw) {
    if (!budgetOk(jid)) { await send(jid, 'Genoeg gelezen voor vandaag. Morgen weer, of zet het zelf in je sheet.'); return true; }
    await getSock().sendPresenceUpdate('composing', jid).catch(() => {});
    const r = await readSmart({ member: pending.member, imgs: images.get(jid)?.images || [], previous: clean(pending.r), correction: raw }, jid, (pending.tries || 0) >= 1);
    saveState();
    if (!r || !r.rijen?.length) { await send(jid, 'Dat begrijp ik niet goed. Zeg wat er anders moet, of *stop*.'); return true; }
    await step(jid, { member: pending.member, r: carry(pending.r, r), tries: (pending.tries || 0) + 1, sheet: pending.sheet });
    return true;
  }

  function report() {
    const all = load(USAGE_FILE, {});
    const months = Object.keys(all).sort().slice(-3);
    if (!months.length) return 'Nog geen transacties gelezen.';
    const q = load(QUEUE_FILE, []);
    return months.map((m) => {
      const rows = Object.entries(all[m]).map(([model, r]) => `• ${model.replace('claude-', '')}: ${r.calls} keer, $${r.usd.toFixed(3)}`);
      const tot = Object.values(all[m]).reduce((s, r) => s + r.usd, 0);
      return `${m}: $${tot.toFixed(3)}\n${rows.join('\n')}`;
    }).join('\n\n') + `\n\nGekoppelde nummers: ${Object.values(state.members).join(', ') || 'geen'}` +
      (q.length ? `\nWachtrij (nog niet in de sheet): ${q.length}` : '') +
      `\nWebapp: ${config().webapp_url ? 'ingesteld' : 'nog niet ingesteld'}`;
  }

  return { handle, report, _internals: { read, problems, proposal, readSmart, needsStrong, advance, candidates, normalize, sheetRows, refPrice, state } };
}
