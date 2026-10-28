// Transacties doorgeven via WhatsApp (alleen in een privégesprek met de bot).
//
// Een lid stuurt een screenshot van zijn broker of typt wat hij kocht of verkocht.
// 1. Het snelle model leest het. Twijfelt het, kent het het aandeel niet of klopt er iets niet,
//    dan leest het sterke model het opnieuw. Welke modellen: models.json ("invoer_snel", "invoer").
//    Sinds 21 okt 2026 allebei Opus: dan is er maar één lezing.
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
const MODELS = (() => {                                         // models.json: "invoer" = sterk, "invoer_snel" = eerste lezing
  const m = { fast: 'claude-haiku-5-5', strong: 'claude-sonnet-5-5' };
  try { const j = JSON.parse(readFileSync(new URL('./models.json', import.meta.url), 'utf8')); m.strong = j.invoer || m.strong; m.fast = j.invoer_snel || m.fast; } catch {}
  return m;
})();
// $ per miljoen tokens (platform.claude.com/docs/en/about-claude/pricing, okt 2026)
const PRICE = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.10, cw: 2.5 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.20, cw: 5 },
};
const LIMITS = { perPersonDay: 25, totalDay: 120 };              // leesbeurten (Haiku + Sonnet samen)
const PENDING_TTL = 24 * 3600 * 1000;
const IMAGE_TTL = 60 * 60 * 1000;
const TX_WORDS = /\b(ge|aan|bij)?(kocht|koop|aankoop|verkocht|verkoop|bought|sold|buy|sell)\b|\bdividend/i;
const YES = /^\s*(ja+|jaja|jep|yes|ok(e|é|ay)?|klopt|correct|juist|in orde|doe maar|top|perfect|👍|✅)[\s!.👍✅]*$/iu;
const NO = /^\s*(nee+|neen|stop|annuleer|annuleren|laat maar|cancel|❌)[\s!.]*$/iu;
const UNDO_RE = /(zet (die|dat|de|het)?\s*(laatste\s*)?(rij\s*|transactie\s*)?terug|ongedaan|\bundo\b|haal (die|de|dat) (laatste )?(rij |transactie )?(weg|eruit)|verwijder (die|de|dat) laatste)/i;
const CHECK_RE = /(klopt|nakijken|kijk.*na|check|vergelijk|controle|controleer|sheet)/i;
const FEED_URL = process.env.FEED_URL || 'https://gillesrobijns.github.io/kwartaalmeeting/bot/feed.json';
const bxNow = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Brussels' }).replace(' ', 'T');   // 2026-10-08T14:05:00

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
            ticker: { type: ['string', 'null'], description: 'De beurscode zoals op de afbeelding of in het bericht (bv. EUNL, IWDA, ASML), anders null. Niet zelf bedenken.' },
          },
          required: ['type', 'aandeel', 'in_lijst', 'aantal', 'totaal_eur', 'munt_gezien', 'datum'],
        },
      },
      onduidelijk: { type: 'array', items: { type: 'string' }, description: 'Wat je niet zeker weet of wat ontbreekt, als korte vragen in het Nederlands aan het lid.' },
      posities: {
        type: 'array',
        description: 'Alleen bij een portefeuilleoverzicht: elke positie met het aantal stuks. Geen cash. Anders leeg.',
        items: { type: 'object', properties: { aandeel: { type: 'string', description: 'Naam uit de AANDELENLIJST als het erin staat, anders zoals op de afbeelding.' }, aantal: { type: ['number', 'null'] } }, required: ['aandeel', 'aantal'] },
      },
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
  `- Een geannuleerde, geweigerde of nog niet uitgevoerde order (bv. "Geannuleerd", "Cancelled", "Mislukt", "In behandeling", een doorstreept bedrag) is geen transactie: laat die weg.\n` +
  `- Overlappen twee screenshots (dezelfde transactie staat op beide), neem die transactie maar één keer.\n` +
  `- Buy = aankoop, Sell = verkoop, Dividend = ontvangen dividend.\n` +
  `- totaal_eur is het TOTAAL in euro, niet de koers per aandeel. Bij een aankoop: inclusief makelaarsloon en beurstaks. Bij een verkoop: wat er netto binnenkwam. Bij dividend: het netto bedrag na roerende voorheffing.\n` +
  `- Staat het totaal alleen in een andere munt (bv. dollar), zet totaal_eur op null en munt_gezien op die munt. Reken zelf NIET om.\n` +
  `- Staat er geen totaal maar wel aantal en koers in euro, reken dan aantal x koers uit en meld in "onduidelijk" dat de kosten er niet in zitten.\n` +
  `- Gebruik voor "aandeel" de naam uit de AANDELENLIJST hieronder als het hetzelfde bedrijf of fonds is (bv. "ASML Holding NV" wordt "ASML").\n` +
  `- Twijfel je tussen meerdere namen uit de AANDELENLIJST (fondsen met een gelijkaardige naam, aandelenklassen, een naam die maar half overeenkomt), zet ze dan in "kandidaten" en kies niet zelf. Is het zeker één naam, laat "kandidaten" leeg.\n` +
  `- Verzin niets. Wat je niet ziet, is null, en je zet een vraag in "onduidelijk".\n` +
  `- Een portefeuilleoverzicht (posities en waarde) is GEEN transactie. Zet dan elke positie met het aantal stuks in "posities".\n` +
  `- Komt er een vorige versie en een correctie van het lid mee, pas dan de vorige versie aan volgens de correctie. Wat het lid zegt, gaat voor op de afbeelding.\n` +
  `- "onduidelijk" bevat ALLEEN vragen die echt nog open staan, kort en aan het lid gericht ("je"). Is alles duidelijk, laat het leeg. Herhaal niet wat het lid al zei en leg niet uit wat je deed.`;

export function createInvoer({ anthropic, getSock, log, dataDir, hereDir, adminJid, claudeTag = '🤖 Claude: ', jobs = true }) {
  // Andere kanalen (mail, formulier, broker-meldingen: kanalen.mjs) praten via een virtueel adres zoals "mail:Kevin".
  // Berichten naar zo'n adres gaan niet naar WhatsApp maar naar een opvanger die het kanaal zelf zet.
  const virt = new Map();                                         // vjid -> { member, via, sink(text) }
  const viaOf = (jid) => virt.get(jid)?.via || 'WhatsApp';
  const STATE_FILE = join(dataDir, 'invoer.json');
  const USAGE_FILE = join(dataDir, 'invoer_usage.json');
  const QUEUE_FILE = join(dataDir, 'invoer_queue.json');
  const load = (f, d) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d; } catch { return d; } };
  const save = (f, obj) => { writeFileSync(`${f}.tmp`, JSON.stringify(obj, null, 1)); renameSync(`${f}.tmp`, f); };
  let state = load(STATE_FILE, {});
  state.members ||= {}; state.pending ||= {}; state.day ||= {};
  state.last ||= {}; state.posbuf ||= {}; state.nudged ||= {}; state.divq ||= {}; state.optout ||= {}; state.snap ||= {}; state.scan ||= {};
  const saveState = () => save(STATE_FILE, state);
  const images = new Map();                                       // jid -> { images, at } (alleen in het geheugen)

  const config = () => load(join(hereDir, 'invoer_config.json'), {});
  const token = () => createHash('sha256').update(`kwartaal-invoer|${process.env.ANTHROPIC_API_KEY || ''}`).digest('hex').slice(0, 32);
  const send = async (jid, text) => {
    const v = virt.get(jid);
    if (v) { v.sink(text); return; }
    return getSock().sendMessage(jid, { text: claudeTag + text });
  };
  const typing = (jid) => (virt.has(jid) ? Promise.resolve() : getSock().sendPresenceUpdate('composing', jid).catch(() => {}));

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
  async function read({ model, member, text, imgs, previous, correction, hint, maxTokens }) {
    const parts = [];
    for (const i of imgs || []) parts.push(i.media_type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: i.data } }
      : { type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } });
    let prompt = `Vandaag is het ${today()}.\n`;
    if (previous) prompt += `\nVORIGE VERSIE (die jij eerder las):\n${JSON.stringify(previous)}\n\nCORRECTIE VAN HET LID: "${correction}"\n`;
    else prompt += `\nBericht van het lid: "${text || '(alleen een afbeelding)'}"\n`;
    if (hint) prompt += `\n${hint}\n`;
    parts.push({ type: 'text', text: prompt });
    const req = {
      model,
      max_tokens: maxTokens || 2000,
      system: [
        { type: 'text', text: RULES },
        { type: 'text', text: `AANDELENLIJST (namen zoals in de sheets van de club):\n${stockList().join('\n')}`, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL],
      messages: [{ role: 'user', content: parts }],
    };
    if (/haiku/.test(model)) req.tool_choice = { type: 'any' };               // Haiku: gedwongen tool
    else if (/sonnet/.test(model)) req.thinking = { type: 'between_tools' };  // Sonnet 5.5: geen gedwongen tool_choice. Opus: forModel() in bot.mjs
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
  function isinOk(s) {                                             // controlecijfer (Luhn): vangt tikfouten en toevallige woorden
    if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s || '')) return false;
    const d = s.split('').map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join('');
    let sum = 0;
    for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; } sum += n; }
    return sum % 10 === 0;
  }
  function findIsin(text) {                                        // "IE00b4l5y983", "IE00 B4L5 Y983" of een ISIN in een zin
    const t = UP(text);
    for (const w of t.split(/[^A-Z0-9]+/)) if (isinOk(w)) return w;
    const flat = t.replace(/[\s.-]/g, '');
    return flat.length <= 14 && isinOk((flat.match(/[A-Z]{2}[A-Z0-9]{9}[0-9]/) || [])[0]) ? flat.match(/[A-Z]{2}[A-Z0-9]{9}[0-9]/)[0] : null;
  }
  const FLAGS = ['keuze_ok', 'dup_ok', 'prijs_ok', 'bezit_ok', 'force', 'nieuw', 'nieuw_wacht', 'herkend', 'id_tried', 'leesnaam'];
  const dayDiff = (a, b) => Math.abs((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 864e5);
  const GENERIC = new Set(['ISHARES', 'AMUNDI', 'XTRACKERS', 'VANGUARD', 'SPDR', 'LYXOR', 'INVESCO', 'WISDOMTREE', 'VANECK', 'FRANKLIN', 'MSCI', 'FTSE', 'ETF', 'UCITS', 'ACC', 'DIST', 'GLOBAL', 'WORLD', 'INDEX', 'FUND', 'CORP', 'INC', 'GROUP', 'HOLDING', 'HOLDINGS', 'THE', 'AND', 'CLASS']);
  const toks = (x) => UP(x).replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);

  function normalize(r) {                                          // namen gelijkzetten met de lijst, in_lijst door de code laten bepalen
    const byUp = new Map(stockList().map((n) => [UP(n), n]));
    for (const x of r.rijen || []) {
      x.leesnaam ||= x.aandeel;                                    // de naam zoals op de screenshot: daarop groeperen we de vragen
      const hit = byUp.get(UP(x.aandeel));
      if (hit) { x.aandeel = hit; x.in_lijst = true; } else if (!x.nieuw) x.in_lijst = false;
      if (x.isin) { const m = UP(x.isin).replace(/\s/g, '').match(ISIN_RE); x.isin = m && isinOk(m[1]) ? m[1] : null; }
      if (x.ticker) x.ticker = UP(x.ticker).replace(/[^A-Z0-9.]/g, '') || null;
    }
    // Twee screenshots die overlappen: dezelfde transactie maar één keer (het model doet dat niet altijd zelf).
    const seen = new Set();
    const before = (r.rijen || []).length;
    r.rijen = (r.rijen || []).filter((x) => {
      const k = [x.type, UP(x.leesnaam), x.aantal, x.totaal_eur, x.datum].join('|');
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    if (r.rijen.length < before) r.dubbel_weg = (r.dubbel_weg || 0) + before - r.rijen.length;
  }

  // ---------- welk fonds is het? (ISIN of beurscode tegen de fondsen van de club) ----------
  // Leden kopen hetzelfde fonds onder een andere naam of beurscode (Revolut toont EUNL, de club kent het als MSCI WORLD = IWDA).
  // Eerst de beurscode zelf, dan Yahoo: de ISIN of beurscode opzoeken en de volledige fondsnaam vergelijken met die van de club.
  const ROOT = (s) => UP(s).split('.')[0];
  const NORM = (s) => UP(s).replace(/[^A-Z0-9]/g, '');
  const yCache = new Map();
  async function yjson(url) {
    const c = yCache.get(url);
    if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.v;
    let v = null;
    try { const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }); if (res.ok) v = await res.json(); }
    catch (e) { log('invoer yahoo:', e.message); }
    yCache.set(url, { at: Date.now(), v });
    return v;
  }
  const ySearch = async (q) => (await yjson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`))?.quotes || [];
  const yLong = async (sym) => { const m = (await yjson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`))?.chart?.result?.[0]?.meta; return m?.longName || null; };
  function clubTickers() { try { return JSON.parse(readFileSync(join(hereDir, 'tickers.json'), 'utf8')); } catch { return {}; } }
  function rootWord(text) {                                        // een beurscode van de club in vrije tekst ("Iwda op Revolut")
    const byRoot = new Map(Object.entries(clubTickers()).map(([n, t]) => [ROOT(t), n]));
    // minstens 4 tekens en geen gewoon woord: "die" (D'Ieteren), "bel" of "fast" mogen niets kiezen
    const WORDS = new Set(['FAST', 'LOCK', 'HACK', 'VOLT', 'SEMI', 'CHIP']);
    for (const w of UP(text).split(/[^A-Z0-9]+/)) if (w.length >= 4 && !WORDS.has(w) && byRoot.has(w)) return { name: byRoot.get(w), code: w };
    return null;
  }
  async function identify({ isin, ticker }) {                      // -> { name, how } of null
    const club = clubTickers();
    const byRoot = new Map(Object.entries(club).map(([n, t]) => [ROOT(t), n]));
    if (ticker && byRoot.has(ROOT(ticker))) return { name: byRoot.get(ROOT(ticker)), how: ROOT(ticker) };
    const longs = new Set();
    if (isin) for (const q of await ySearch(isin)) {
      if (byRoot.has(ROOT(q.symbol))) return { name: byRoot.get(ROOT(q.symbol)), how: isin };
      if (q.longname) longs.add(NORM(q.longname));
    }
    if (ticker) {                                                  // alleen de eerste notering met precies die code (EUNL -> EUNL.DE)
      const q = (await ySearch(ROOT(ticker))).find((y) => ROOT(y.symbol) === ROOT(ticker) && y.longname);
      if (q) longs.add(NORM(q.longname));
    }
    if (!longs.size) return null;
    const fits = new Set();                                        // fondsen van de club waarvan elk woord in de volledige naam staat
    for (const l of longs) for (const n of Object.keys(club)) { const t = toks(n); if (t.length && t.every((w) => l.includes(w))) fits.add(n); }
    for (const n of [...fits].sort((a, b) => toks(b).length - toks(a).length).slice(0, 12)) {   // dan de volledige naam vergelijken
      const ln = await yLong(club[n]);
      if (ln && longs.has(NORM(ln))) return { name: n, how: isin || ROOT(ticker) };
    }
    return null;
  }
  const sameFund = (r, x) => r.rijen.filter((y) => UP(y.leesnaam || y.aandeel) === UP(x.leesnaam || x.aandeel));
  function pickFund(r, x, name, how = null) {                      // een keuze geldt voor alle rijen met dat fonds
    for (const y of sameFund(r, x)) {
      y.aandeel = name; y.in_lijst = true; y.keuze_ok = true; y.nieuw = false; y.nieuw_wacht = false; delete y.kandidaten;
      if (how) y.herkend = how;
    }
  }
  function newFund(r, x, isin) {
    for (const y of sameFund(r, x)) {
      if (isin) { y.isin = isin; y.nieuw = true; y.in_lijst = false; y.keuze_ok = true; y.nieuw_wacht = false; }
      else y.nieuw_wacht = true;
    }
  }
  const ISIN_HELP = 'De ISIN staat in je broker-app op de pagina van het fonds zelf (niet bij de transactie), meestal onder de details of "Over". Een screenshot van die pagina mag ook, net als een foto van een zoekresultaat waarop de ISIN staat.';
  const ID_TOOL = {
    name: 'fonds',
    description: 'Geef de ISIN, beurscode en naam van het fonds of aandeel dat je op de afbeelding ziet.',
    input_schema: { type: 'object', properties: {
      isin: { type: ['string', 'null'], description: 'ISIN (2 letters + 10 tekens) zoals op de afbeelding, anders null.' },
      ticker: { type: ['string', 'null'], description: 'Beurscode zoals op de afbeelding, anders null.' },
      naam: { type: ['string', 'null'], description: 'Naam van het fonds of aandeel zoals op de afbeelding, anders null.' },
    }, required: ['isin', 'ticker', 'naam'] },
  };
  async function readId(imgs, text) {                              // een foto als antwoord op "welk fonds?" of "stuur de ISIN"
    const content = imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }));
    content.push({ type: 'text', text: `Het lid stuurt deze afbeelding om te tonen welk fonds of aandeel hij bedoelt${text ? ` (bijschrift: "${text}")` : ''}. De foto kan scheef, gedraaid of een foto van een scherm zijn: lees ze zoals ze is. Neem alleen over wat je echt ziet staan; kun je iets niet lezen, zet het op null. Roep de tool aan.` });
    const req = { model: MODELS.strong, max_tokens: 600, tools: [ID_TOOL], messages: [{ role: 'user', content }] };
    if (/haiku/.test(MODELS.strong)) req.tool_choice = { type: 'any' };
    else if (/sonnet/.test(MODELS.strong)) req.thinking = { type: 'between_tools' };
    try {
      const res = await anthropic.messages.create(req);
      track(MODELS.strong, res.usage);
      const b = (res.content || []).find((c) => c.type === 'tool_use');
      if (!b) return null;
      const m = UP(b.input.isin).replace(/[\s.-]/g, '').match(/([A-Z]{2}[A-Z0-9]{9}[0-9])/);
      return { isin: m ? m[1] : null, ticker: b.input.ticker ? UP(b.input.ticker) : null, naam: b.input.naam || null };
    } catch (e) { log('invoer foto-id:', e.message); return null; }
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
  const rowTag = (r, i) => {                                       // "(aankoop van 04/08/2026)" in plaats van "(rij 3)": dat zegt het lid iets
    const x = r.rijen[i];
    return r.rijen.length > 1 && x ? ` (${(TYPE_NL[x.type] || x.type).toLowerCase()} van ${dmy(x.datum)})` : '';
  };
  const FUND_RE = /ISHARES|AMUNDI|XTRACKERS|VANGUARD|SPDR|ETF|MSCI|FTSE|INVESCO|WISDOMTREE|VANECK|UCITS/;
  const sheetLine = (h, isDiv) => (isDiv
    ? `Dividend · ${h.stock} · ${dmy(h.date)}`
    : `${TYPE_NL[h.type] || h.type} · ${num(h.qty)} × ${h.stock} · ${dmy(h.date)}`);

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
      if (!x.id_tried) {                                           // eerst zelf opzoeken: beurscode of ISIN van een fonds dat de club al heeft
        for (const y of sameFund(r, x)) y.id_tried = true;
        const code = x.ticker || (String(x.leesnaam).match(/\(([A-Z0-9]{2,6})\)\s*$/) || [])[1] || null;
        const hit = rootWord(x.leesnaam) && { name: rootWord(x.leesnaam).name, how: rootWord(x.leesnaam).code }
          || ((x.isin || code) ? await identify({ isin: x.isin, ticker: code }) : null);
        if (hit) { pickFund(r, x, hit.name, hit.how); continue; }
      }
      p.idx = i;
      const n = sameFund(r, x).length;
      const many = n > 1 ? ` (${n} transacties)` : '';
      const fund = FUND_RE.test(UP(x.leesnaam)) || opts.some((o) => FUND_RE.test(o));
      const kind = fund ? 'fonds' : 'aandeel';
      if (x.nieuw_wacht && !x.isin) {
        p.stage = 'isin';
        return `Nieuw voor de club. Stuur de ISIN van *${x.leesnaam}* (12 tekens, staat op de pagina van het ${kind} in je broker-app), dan kan de maandagscan de koers vinden.`;
      }
      if (opts.length) {
        p.stage = 'keuze'; p.opts = opts;
        return `Welk ${kind} bedoel je${x.in_lijst ? rowTag(r, i) : ` met *${x.leesnaam}*`}${many}?\n` +
          opts.map((o, k) => `${k + 1}. ${o}`).join('\n') + `\n${opts.length + 1}. Een nieuw ${kind} voor de club\n\nAntwoord met het nummer.`;
      }
      p.stage = 'isin';
      return x.isin
        ? `*${x.leesnaam}*${many} staat nog niet in de lijst van de club. Is het een nieuw ${kind} (ISIN ${x.isin})? Antwoord *nieuw*, of zeg welk ${kind} uit de lijst je bedoelt.`
        : `*${x.leesnaam}*${many} staat nog niet in de lijst van de club. Is het nieuw, stuur dan de ISIN (12 tekens, staat op de pagina van het ${kind} in je broker-app), dan kan de maandagscan de koers vinden. Bedoel je een ${kind} uit de lijst, zeg dan welk.`;
    }
    // Het fonds is gekozen of door de code herkend: een vraag van het model over welk fonds het is, valt dan weg.
    const settled = r.rijen.filter((x) => x.herkend || x.id_tried).flatMap((x) => [x.aandeel, x.leesnaam, x.ticker, x.isin]).filter(Boolean).map(UP);
    r.onduidelijk = (r.onduidelijk || []).filter((q) => !(settled.some((s) => UP(q).includes(s)) && /fonds|onder|bedoel|zelfde|dist|acc/i.test(q)));
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
      return `Volgens je sheet heb je ${held > 1e-6 ? `minder dan ${num(x.aantal)} ${x.aandeel}` : `geen ${x.aandeel}`}, dus ${num(x.aantal)} verkopen kan niet${rowTag(r, i)}.\n` +
        `Klopt het aantal, of ontbreekt er nog een aankoop in je sheet? Zeg het juiste aantal, of *ja* als het toch klopt.`;
    }
    p.stage = 'voorstel';
    return proposal(p.member, r);
  }
  async function step(jid, p, prefix = '', suffix = '') {
    await typing(jid);
    const msg = (await advance(jid, p)) + suffix;
    p.vraag = msg;                                                 // om de open vraag te herhalen na een wedervraag
    p.at = Date.now();
    state.pending[jid] = p;
    saveState();
    await send(jid, prefix + msg);
  }
  const carry = (oldR, newR) => {                                  // beslissingen van het lid bewaren na een correctie
    const used = new Set();
    for (const [i, y] of (newR.rijen || []).entries()) {
      // zelfde rij = zelfde type en datum en dezelfde naam (de gekozen naam of de naam van de screenshot); anders dezelfde plaats
      const same = (x) => x && x.type === y.type && [UP(x.aandeel), UP(x.leesnaam)].includes(UP(y.aandeel));
      let x = (oldR?.rijen || []).find((o, k) => !used.has(k) && same(o) && o.datum === y.datum);
      if (!x && same(oldR?.rijen?.[i]) && !used.has(i)) x = oldR.rijen[i];
      if (!x) continue;
      used.add(oldR.rijen.indexOf(x));
      if (x.keuze_ok && x.in_lijst && UP(y.aandeel) !== UP(x.aandeel)) { y.aandeel = x.aandeel; y.in_lijst = true; }   // gekozen fonds houden
      for (const f of ['keuze_ok', 'nieuw', 'isin', 'nieuw_wacht', 'herkend', 'leesnaam', 'id_tried']) if (x[f] && !y[f]) y[f] = x[f];
      if (x.aantal === y.aantal && x.totaal_eur === y.totaal_eur && x.datum === y.datum) for (const f of ['dup_ok', 'force', 'prijs_ok', 'bezit_ok']) if (x[f]) y[f] = x[f];
    }
    return newR;
  };
  const clean = (r) => ({ ...r, rijen: (r.rijen || []).map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !FLAGS.includes(k)))) });

  // ---------- posities nakijken (screenshot van je portefeuille tegen je sheet) ----------
  // Noemt alleen WELKE aandelen niet kloppen en of het meer of minder is, nooit aantallen.
  const holdings = (sh, upTo = null) => {
    const h = {};
    for (const t of sh.tx) {
      if (upTo && !(t.date && t.date < upTo)) continue;
      const k = UP(t.stock);
      h[k] = (h[k] || 0) + (t.type === 'Buy' ? t.qty : t.type === 'Sell' ? -t.qty : 0);
    }
    return h;
  };
  const andList = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} en ${a[a.length - 1]}`);
  async function positionsCheck(jid, member, posities) {
    const byUp = new Map(stockList().map((n) => [UP(n), n]));
    const prev = state.posbuf[jid];
    const buf = prev && Date.now() - prev.at < 30 * 60 * 1000 ? prev.list : [];
    const seen = {};
    for (const x of [...buf, ...posities]) {
      if (!x?.aandeel || !(x.aantal > 0) || /^(CASH|EUR|USD|LIQUIDITEIT|SALDO)/i.test(String(x.aandeel).trim())) continue;
      const name = byUp.get(UP(x.aandeel)) || UP(x.aandeel);
      seen[name] = (seen[name] || 0) + x.aantal;
    }
    state.posbuf[jid] = { at: Date.now(), list: Object.entries(seen).map(([aandeel, aantal]) => ({ aandeel, aantal })) };
    saveState();
    const sh = await sheetRows(member);
    if (!sh) { await send(jid, 'Ik kan je sheet nu niet lezen. Probeer het straks nog eens.'); return true; }
    const held = holdings(sh);
    const names = Object.keys(seen);
    const more = [], less = [], notIn = [], ok = [];
    for (const n of names) {
      const h = held[UP(n)] || 0, v = seen[n];
      if (h <= 1e-6) notIn.push(n);
      else if (Math.abs(v - h) <= Math.max(0.01, 0.005 * Math.max(v, h))) ok.push(n);
      else (v > h ? more : less).push(n);
    }
    const sheetOnly = Object.entries(held).filter(([k, v]) => v > 0.01 && !names.some((n) => UP(n) === k))
      .map(([k]) => byUp.get(k) || k);
    if (!more.length && !less.length && !notIn.length && !sheetOnly.length) {
      await send(jid, `✅ Alles klopt: je sheet heeft dezelfde ${names.length} aandelen en aantallen als je screenshot.`);
      return true;
    }
    const b = (a) => andList(a.map((n) => `*${n}*`));
    const lines = [`Ik vergeleek ${names.length} ${names.length === 1 ? 'lijn' : 'lijnen'} met je sheet.${ok.length ? ` ${ok.length} ${ok.length === 1 ? 'klopt' : 'kloppen'}.` : ''}`];
    if (more.length) lines.push(`Bij ${b(more)} heb je er volgens je screenshot *meer* dan in je sheet.`);
    if (less.length) lines.push(`Bij ${b(less)} heb je er volgens je screenshot *minder* dan in je sheet.`);
    if (notIn.length) lines.push(`${b(notIn)} ${notIn.length === 1 ? 'staat' : 'staan'} op je screenshot, maar niet in je sheet.`);
    if (sheetOnly.length) lines.push(`${b(sheetOnly)} ${sheetOnly.length === 1 ? 'staat' : 'staan'} niet op je screenshot, maar wel in je sheet.`);
    let t = lines.join('\n') + '\n\nOntbreekt er een transactie? Stuur ze gerust door, of zet ze zelf in je sheet.';
    if (sheetOnly.length) t += '\n(Heb je nog een andere broker? Stuur die screenshot er binnen het halfuur bij, dan tel ik ze samen.)';
    await send(jid, t);
    return true;
  }

  // ---------- ongedaan maken ----------
  const scanSince = (at) => {                                      // liep de maandagscan sinds dit tijdstip?
    const s0 = state.scan.seen;
    if (!s0) return false;
    const local = new Date(at).toLocaleString('sv-SE', { timeZone: 'Europe/Brussels' }).replace(' ', 'T').slice(0, 16);
    return s0 > local;
  };
  async function undoAsk(jid) {
    const L = state.last[jid];
    if (!L || Date.now() - L.at > 7 * 864e5) { await send(jid, 'Ik vind geen rij die ik onlangs voor je in je sheet zette. Pas het zelf aan in je sheet, de maandagscan neemt de wijziging mee.'); return true; }
    if (scanSince(L.at)) { await send(jid, 'Die rij is al door de maandagscan verwerkt. Pas ze zelf aan in je sheet; de volgende scan neemt de wijziging mee.'); return true; }
    const hhmm = new Date(L.at).toLocaleTimeString('nl-BE', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit' });
    const lines = L.rows.map((x) => `*${TYPE_NL[x.type] || x.type} · ${x.stock} · ${dmy(x.date)}*`).join('\n');
    state.pending[jid] = { stage: 'undo', member: L.member, at: Date.now() };
    saveState();
    await send(jid, `${L.rows.length > 1 ? 'Deze rijen haal' : 'Deze rij haal'} ik uit je sheet:\n${lines}\n(doorgegeven om ${hhmm})\n\nZeker? Antwoord *ja* of *nee*.`);
    return true;
  }
  async function undoDo(jid) {
    const L = state.last[jid];
    delete state.pending[jid]; saveState();
    if (!L) { await send(jid, 'Ik vind die rij niet meer.'); return true; }
    try {
      const res = await fetch(config().webapp_url, { method: 'POST', headers: { 'content-type': 'text/plain' }, redirect: 'follow',
        body: JSON.stringify({ token: token(), action: 'undo', member: L.member, rows: L.rows.map((x) => ({ tab: x.type === 'Dividend' ? 'Dividenden' : 'Transacties', row: x.row, stock: x.stock })) }) });
      const out = JSON.parse(await res.text());
      if (!out.ok) throw new Error(out.error || 'webapp weigerde');
      const gone = (out.results || []).filter((x) => x.status === 'removed').length;
      delete state.last[jid]; saveState();
      if (gone === L.rows.length) await send(jid, '↩️ Weg uit je sheet. Stuur gerust de juiste door.');
      else if (gone) await send(jid, `↩️ ${gone} van de ${L.rows.length} rijen zijn weg. De andere werden intussen in je sheet aangepast, die laat ik staan.`);
      else await send(jid, 'Die rij werd intussen in je sheet aangepast, dus ik laat ze staan. Pas het zelf aan als het nodig is.');
      const a = adminJid();
      if (a && a !== jid && gone) getSock().sendMessage(a, { text: claudeTag + `↩️ ${L.member} haalde ${gone > 1 ? `${gone} doorgegeven rijen` : 'een doorgegeven rij'} weer weg: ${[...new Set(L.rows.map((x) => x.stock))].join(', ')}` }).catch(() => {});
    } catch (e) {
      log('invoer undo:', e.message);
      await send(jid, 'Het lukte niet om de rij weg te halen. Pas het zelf aan in je sheet, of probeer het later nog eens.');
    }
    return true;
  }

  // ---------- geplande taken: dividend-seintje en bevestiging na de maandagscan ----------
  const recipients = () => {
    const out = new Map(Object.entries(state.members));
    const a = adminJid();
    if (a && ![...out.values()].includes('Gilles')) out.set(a, 'Gilles');
    return [...out.entries()];                                     // [jid, member]
  };
  const divCache = new Map();
  async function dividendsOf(ticker) {                             // [{ ex: 'YYYY-MM-DD' }] van de laatste 3 maanden
    const k = `${ticker}|${today()}`;
    if (divCache.has(k)) return divCache.get(k);
    let out = [];
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=3mo&events=div`, { headers: { 'user-agent': 'Mozilla/5.0' } });
      const res = (await r.json())?.chart?.result?.[0];
      const tz = res?.meta?.exchangeTimezoneName || 'UTC';
      out = Object.values(res?.events?.dividends || {}).map((d) => ({ ex: new Date(d.date * 1000).toLocaleDateString('sv-SE', { timeZone: tz }), amount: d.amount || 0 }));
    } catch (e) { log('invoer dividend', ticker, e.message); }
    divCache.set(k, out);
    return out;
  }
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  // Dividend: één felicitatie op de (geschatte) betaaldag, en één herinnering per kwartaal (de 21e van de laatste maand)
  // voor wat nog geen bedrag kreeg. Geen antwoord = geen nieuwe vragen tussendoor.
  const DIV_START = '2026-10-08';                                  // felicitaties alleen voor dividenden vanaf de start van deze functie
  const payDay = (ticker, ex) => addDays(ex, /\.[A-Z]{1,3}$/.test(ticker) ? 3 : 21);   // Europese beurs ± 3 dagen na ex, VS ± 3 weken
  async function divCandidates(member, sh, tickers, from, to) {    // dividenden met ex-datum in [from, to] die het lid toen had en die nog niet in de sheet staan
    const byUp = new Map(Object.keys(tickers).map((n) => [UP(n), n]));
    const out = [];
    for (const stock of [...new Set(sh.tx.map((t) => byUp.get(UP(t.stock))).filter(Boolean))]) {
      for (const ev of await dividendsOf(tickers[stock])) {
        if (ev.ex < from || ev.ex > to) continue;
        const had = holdings(sh, ev.ex)[UP(stock)] || 0;
        if (!(had > 1e-6) || had * ev.amount < 1) continue;        // geen positie, of minder dan ± 1 euro bruto: niet storen
        if ((sh.div || []).some((d) => UP(d.stock) === UP(stock) && d.date && d.date >= addDays(ev.ex, -7) && d.date <= addDays(ev.ex, 75))) continue;
        out.push({ stock, ex: ev.ex, key: `${member}|${stock}|${ev.ex}`, pay: payDay(tickers[stock], ev.ex) });
      }
    }
    return out.sort((a, b) => a.ex.localeCompare(b.ex));
  }
  async function askDividend(jid, member, d, intro) {
    state.nudged[d.key] = state.nudged[d.key] === 'herinnerd' ? 'herinnerd' : 'gevraagd';
    state.pending[jid] = { stage: 'dividend', member, stock: d.stock, ex: d.ex, key: d.key, at: Date.now() };
    saveState();
    await send(jid, `${intro}\nHoeveel kwam er netto binnen (na roerende voorheffing)? Of zeg *nee* als je het al ingaf of geen dividend kreeg.`).catch((e) => log('invoer dividend:', e.message));
  }
  async function nextDividend(jid, member) {                       // na een antwoord: de volgende uit de herinnering van het kwartaal
    const q = state.divq[jid] || [];
    const d = q.shift();
    state.divq[jid] = q; saveState();
    if (!d) return false;
    await askDividend(jid, member, d, `Nog een: *${d.stock}* (ex-dividenddatum ${dmy(d.ex)}).`);
    return true;
  }
  async function dividendJob(t0 = today(), divStart = DIV_START) {   // parameters alleen voor tests
    let tickers = {};
    try { tickers = JSON.parse(readFileSync(join(hereDir, 'tickers.json'), 'utf8')); } catch { return; }
    const [y, m, dd] = t0.split('-').map(Number);
    const reminderDay = m % 3 === 0 && dd === 21;                  // 21 maart, juni, september, december
    const qStart = `${y}-${String(m - ((m - 1) % 3)).padStart(2, '0')}-01`;
    for (const [jid, member] of recipients()) {
      if (state.optout[member] || state.pending[jid]) continue;
      const sh = await sheetRows(member);
      if (!sh) continue;
      if (reminderDay) {
        const open = (await divCandidates(member, sh, tickers, qStart, t0)).filter((d) => d.pay <= t0 && !['beantwoord', 'nee', 'herinnerd'].includes(state.nudged[d.key]));
        if (!open.length) continue;
        open.forEach((d) => { state.nudged[d.key] = 'herinnerd'; });
        const first = open.shift();
        state.divq[jid] = open;
        const all = [first, ...open].map((d) => d.stock);
        await askDividend(jid, member, first, `📅 Het kwartaal loopt bijna af. Van ${all.length === 1 ? 'dit dividend' : `deze ${all.length} dividenden`} heb ik nog geen bedrag: ${andList(all.map((n) => `*${n}*`))}.\n\nEerst *${first.stock}* (ex-dividenddatum ${dmy(first.ex)}).`);
        continue;
      }
      const due = (await divCandidates(member, sh, tickers, addDays(t0, -40), t0))
        .filter((d) => d.ex >= divStart && d.pay <= t0 && d.pay >= addDays(t0, -7) && !state.nudged[d.key]);
      if (!due.length) continue;
      const d = due[0];                                            // hoogstens één felicitatie per dag
      await askDividend(jid, member, d, `🎉 Proficiat, *${d.stock}* keerde dividend uit (ex-dividenddatum ${dmy(d.ex)}).`);
    }
    saveState();
  }
  const rowKey = (x, div) => (div ? `D|${UP(x.stock)}|${x.date}|${x.amount}` : `T|${UP(x.stock)}|${x.type}|${x.qty}|${x.date}|${x.total}`);
  async function scanReceipts(baselineOnly = false) {
    for (const [jid, member] of recipients()) {
      const sh = await sheetRows(member);
      if (!sh) continue;
      const now = [...sh.tx.map((x) => ({ x, div: false })), ...(sh.div || []).map((x) => ({ x, div: true }))];
      const prev = state.snap[member];
      state.snap[member] = now.map((e) => rowKey(e.x, e.div));
      if (baselineOnly || !prev) continue;
      const left = new Map();
      for (const k of prev) left.set(k, (left.get(k) || 0) + 1);
      const fresh = [];
      for (const e of now) { const k = rowKey(e.x, e.div); if (left.get(k) > 0) left.set(k, left.get(k) - 1); else fresh.push(e); }
      if (!fresh.length) continue;
      const names = [...new Set(fresh.map((e) => (e.div ? `dividend ${e.x.stock}` : e.x.stock)))];
      let t = `📬 De maandagscan verwerkte deze week ${fresh.length} ${fresh.length === 1 ? 'nieuwe rij' : 'nieuwe rijen'} uit je sheet: ${andList(names)}. Ze tellen mee voor de volgende meeting.`;
      const bad = fresh.filter((e) => !e.x.date || (!e.div && (!['Buy', 'Sell'].includes(e.x.type) || !(e.x.qty > 0))))
        .map((e) => `rij ${e.x.row} (${!e.x.date ? 'datum ontbreekt' : !['Buy', 'Sell'].includes(e.x.type) ? 'type ontbreekt' : 'aantal ontbreekt'})`);
      if (bad.length) t += `\n\n⚠️ Bij ${bad.length === 1 ? 'één nieuwe rij' : `${bad.length} nieuwe rijen`} ontbreekt iets: ${andList(bad)}. Kijk je die even na?`;
      await send(jid, t).catch((e) => log('invoer receipt:', e.message));
    }
    saveState();
  }
  // ---------- opvolging (invoer_config.json "opvolgen") ----------
  // Gilles laat de bot zelf een voorstel sturen aan een lid, bv. nadat de bot een gesprek verknoeide. Eén keer per id,
  // alleen aan een gekoppeld nummer, tussen 9 en 21 uur, tot de datum "tot". Het voorstel gaat door dezelfde controles
  // (dubbel, prijs, bezit) en schrijft pas na *ja* van het lid.
  // { "id": "…", "lid": "Haakon", "intro": "…", "slot": "…", "tot": "JJJJ-MM-DD", "rijen": [{ "type", "aandeel", "aantal", "totaal_eur", "datum" }] }
  state.followed ||= {};
  async function followUps(hour = +bxNow().slice(11, 13)) {
    if (hour < 9 || hour >= 21) return;
    for (const f of config().opvolgen || []) {
      if (!f?.id || !f.lid || !(f.rijen || []).length || state.followed[f.id] || (f.tot && today() > f.tot)) continue;
      const jid = Object.keys(state.members).find((j) => state.members[j] === f.lid);
      if (!jid) continue;                                          // nummer nog niet gekoppeld: wachten
      const r = { is_transactie: true, zekerheid: 1, onduidelijk: [], rijen: f.rijen.map((x) => ({ in_lijst: true, munt_gezien: 'EUR', ...x })) };
      delete state.pending[jid];
      try {
        await step(jid, { member: f.lid, r, tries: 0 }, f.intro ? `${f.intro}\n\n` : '', f.slot ? `\n\n${f.slot}` : '');
        state.followed[f.id] = new Date().toISOString(); saveState();
        log('invoer opvolging verstuurd:', f.id);
        const a = adminJid();
        if (a && a !== jid) getSock().sendMessage(a, { text: claudeTag + `📨 Opvolging "${f.id}" is naar ${f.lid} gestuurd. Na zijn *ja* staat het in zijn sheet.` }).catch(() => {});
      } catch (e) { log('invoer opvolging:', f.id, e.message); }
    }
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const now = bxNow(), hour = +now.slice(11, 13), day = now.slice(0, 10);
      await followUps(hour).catch((e) => log('invoer opvolging:', e.message));
      try {
        const feed = await (await fetch(FEED_URL, { headers: { 'cache-control': 'no-cache' } })).json();
        const sc = feed?.duvel?.scanned_at;
        if (sc && sc !== state.scan.seen) {
          const first = !state.scan.seen;
          state.scan.seen = sc;
          if (first) await scanReceipts(true); else state.scan.due = true;
          saveState();
        }
      } catch (e) { log('invoer feed:', e.message); }
      if (state.scan.due && hour >= 8 && hour < 22) { state.scan.due = false; saveState(); await scanReceipts(); }
      if (hour === 10 && state.scan.divday !== day) { state.scan.divday = day; saveState(); await dividendJob(); }
    } catch (e) { log('invoer tick:', e.message); }
    busy = false;
  }
  if (jobs && config().webapp_url !== undefined) {
    setTimeout(tick, 2 * 60 * 1000);
    setInterval(tick, 15 * 60 * 1000);
  }

  async function readSmart(args, jid, forceStrong = false) {
    let r = null;
    if (MODELS.fast === MODELS.strong) forceStrong = true;         // één model: meteen de sterke lezing, geen tweede pass
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
      const first = r.rijen.findIndex((y) => !y.in_lijst && UP(y.aandeel) === UP(x.aandeel)) === i;   // "nieuw voor de club" één keer per fonds
      return `${r.rijen.length > 1 ? `${i + 1}. ` : ''}${what}${x.in_lijst || !first ? '' : ` (nieuw voor de club${x.isin ? `, ISIN ${x.isin}` : ''})`}`;
    });
    const pr = problems(r);
    const ask = pr.length ? pr : (r.onduidelijk || []).slice(0, 3);
    let t = `Dit zet ik in de sheet van ${member}:\n${lines.join('\n')}`;
    const label = (x) => (UP(x.leesnaam) !== UP(x.aandeel) ? x.leesnaam : x.ticker || x.herkend);
    const notes = [...new Map(r.rijen.filter((x) => x.herkend && UP(label(x)) !== UP(x.aandeel))
      .map((x) => [x.aandeel, `${label(x)} op je screenshot is hetzelfde fonds als *${x.aandeel}* van de club, dus ik zet het als ${x.aandeel} in je sheet.`])).values()];
    if (r.dubbel_weg) notes.push(`${r.dubbel_weg === 1 ? 'Eén transactie stond' : `${r.dubbel_weg} transacties stonden`} op beide screenshots; die tel ik maar één keer.`);
    if (notes.length) t += `\n\n${notes.join('\n')}`;
    if (pr.length) t += `\n\nNog even checken:\n${ask.map((q) => `• ${q}`).join('\n')}\n\nAntwoord gewoon met wat ontbreekt.`;
    else if (ask.length) t += `\n\nNog even checken:\n${ask.map((q) => `• ${q}`).join('\n')}\n\nKlopt alles? Antwoord *ja*, of zeg wat er anders moet.`;
    else t += `\n\nKlopt dit? Antwoord *ja*, of zeg wat er anders moet. *stop* om te annuleren.`;
    return t;
  }

  // ---------- schrijven ----------
  async function write(jid, member, rows, via = viaOf(jid)) {
    const url = config().webapp_url;
    if (!url) {
      const q = load(QUEUE_FILE, []);
      q.push({ member, rows, at: new Date().toISOString() });
      save(QUEUE_FILE, q);
      const a = adminJid();
      if (a) await getSock().sendMessage(a, { text: claudeTag + `📥 ${member} gaf via ${via} door (nog niet automatisch in de sheet, zet het er zelf in):\n` +
        rows.map((x) => `• ${TYPE_NL[x.type]} ${x.type === 'Dividend' ? '' : `${num(x.shares)} × `}${x.stock} · ${eur(x.total_eur)} · ${dmy(x.date)}`).join('\n') }).catch(() => {});
      return { queued: true };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },                // Apps Script: geen CORS-preflight nodig
      body: JSON.stringify({ token: token(), action: 'append', member, source: via, rows }),
      redirect: 'follow',
    });
    const txt = await res.text();
    let out; try { out = JSON.parse(txt); } catch { throw new Error(`webapp gaf geen JSON (HTTP ${res.status})`); }
    if (!out.ok) throw new Error(out.error || 'webapp weigerde');
    return out;
  }

  // ---------- gesprek ----------
  // Berichten van hetzelfde nummer één voor één afhandelen. Anders kan een tweede bericht (bv. een vraag net na een
  // screenshot) binnenkomen terwijl de screenshot nog gelezen wordt, en dan belandt het bij de gewone Claude.
  const queues = new Map();
  function handle(args) {
    const prev = queues.get(args.jid) || Promise.resolve();
    const run = prev.then(() => handleOne(args), () => handleOne(args));
    const tail = run.catch(() => {});
    queues.set(args.jid, tail);
    tail.then(() => { if (queues.get(args.jid) === tail) queues.delete(args.jid); });
    return run;
  }
  async function handleOne({ jid, name, text, imgs = [] }) {
    const raw = (text || '').trim();
    const isAdmin = jid === adminJid();
    if (isAdmin && /^\/invoer\b/i.test(raw)) { await send(jid, report()); return true; }

    const p = state.pending[jid];
    if (p && Date.now() - p.at > PENDING_TTL) { delete state.pending[jid]; saveState(); }
    const pending = state.pending[jid];
    const member = state.members[jid] || virt.get(jid)?.member || (isAdmin ? 'Gilles' : null);

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
      } else if (saved?.pos) {
        saveState(); await send(jid, `Dag ${pick}, genoteerd.`); await positionsCheck(jid, pick, saved.pos);
      } else { saveState(); await send(jid, `Dag ${pick}, genoteerd.`); }
      return true;
    }

    // Ongedaan maken
    if (pending?.stage === 'undo') {
      if (YES.test(raw)) return undoDo(jid);
      delete state.pending[jid]; saveState();
      if (NO.test(raw)) { await send(jid, 'Oké, ik laat ze staan.'); return true; }
    } else if (UNDO_RE.test(raw) && raw.length < 80 && !imgs.length) return undoAsk(jid);

    // Antwoord op een dividend-seintje
    if (pending?.stage === 'dividend') {
      if (/(geen seintjes|niet meer vragen|nooit meer|stop met (de )?seintjes)/i.test(raw)) {
        state.optout[pending.member] = true; state.divq[jid] = []; delete state.pending[jid]; saveState();
        await send(jid, 'Oké, ik stuur je geen dividend-seintjes meer.'); return true;
      }
      if (NO.test(raw)) {
        if (pending.key) state.nudged[pending.key] = 'nee';
        delete state.pending[jid]; saveState();
        if (!(await nextDividend(jid, pending.member))) await send(jid, 'Oké, genoteerd.');
        return true;
      }
      const m = raw.match(/(\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
      if (m && raw.length < 60) {
        const v = m[1].includes(',') ? +m[1].replace(/[.\s]/g, '').replace(',', '.') : +m[1].replace(/\s/g, '');
        if (v > 0) {
          if (pending.key) state.nudged[pending.key] = 'beantwoord';
          const r = { is_transactie: true, zekerheid: 1, onduidelijk: [], rijen: [{ type: 'Dividend', aandeel: pending.stock, in_lijst: true, keuze_ok: true, aantal: null, totaal_eur: v, munt_gezien: 'EUR', datum: pending.ex }] };
          await step(jid, { member: pending.member, r, tries: 0 });
          return true;
        }
      }
      delete state.pending[jid]; state.divq[jid] = []; saveState();   // iets anders: gewoon gesprek, geen verdere vragen
      return false;
    }

    // Een controlevraag staat open
    if (['keuze', 'isin', 'dubbel', 'prijs', 'bezit'].includes(pending?.stage)) {
      if (NO.test(raw)) { delete state.pending[jid]; saveState(); await send(jid, 'Oké, niets ingegeven.'); return true; }
      const x = pending.r.rijen[pending.idx];
      if (!x) { delete state.pending[jid]; saveState(); return false; }
      if (pending.stage === 'keuze' || pending.stage === 'isin') {
        const r = pending.r;
        // Een ISIN als antwoord: hoort ze bij een fonds dat de club al heeft, dan dat fonds; anders nieuw. Geldt voor alle rijen van dat fonds.
        const byIsin = async (isin, intro = '') => {
          const hit = await identify({ isin });
          if (hit) { pickFund(r, x, hit.name, isin); await step(jid, pending, `${intro}Dat is *${hit.name}*: dat fonds heeft de club al, dus ik zet het daaronder.\n\n`); return true; }
          newFund(r, x, isin); await step(jid, pending, intro); return true;
        };
        if (imgs.length) {                                         // een foto als antwoord: de ISIN of beurscode erop lezen
          if (!budgetOk(jid)) { await send(jid, 'Genoeg gelezen voor vandaag. Morgen weer, of zet het zelf in je sheet.'); return true; }
          spend(jid); await typing(jid);
          const id = await readId(imgs, raw);
          if (id?.isin && isinOk(id.isin)) return byIsin(id.isin, `Op je foto staat ISIN ${id.isin}.\n\n`);
          const hit = id?.ticker ? await identify({ ticker: id.ticker }) : null;
          if (hit) { pickFund(r, x, hit.name, ROOT(id.ticker)); await step(jid, pending, `${ROOT(id.ticker)} is *${hit.name}* van de club.\n\n`); return true; }
          await send(jid, `Ik zie geen ISIN op die foto. ${ISIN_HELP}\n\n${pending.vraag || ''}`.trim()); return true;
        }
        const isin = findIsin(raw);
        if (isin) return byIsin(isin);
        if (/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(UP(raw).replace(/[\s.-]/g, ''))) {
          await send(jid, 'Die ISIN klopt niet: er staat een teken verkeerd. Kijk ze nog eens na, of stuur een screenshot van de pagina van het fonds.'); return true;
        }
        const rw = rootWord(raw);                                  // een beurscode van de club in de tekst ("3. Iwda op Revolut")
        if (rw) { pickFund(r, x, rw.name, rw.code); await step(jid, pending, `${rw.code} is *${rw.name}* van de club.\n\n`); return true; }
        if (/\?\s*$/.test(raw) || /^\s*(waar|hoe|wat|waarom|welk|welke|wanneer|kan|moet)\b/i.test(raw)) {   // een wedervraag: antwoorden, keuze niet kwijt
          await send(jid, `${ISIN_HELP}\n\n${pending.vraag || ''}`.trim()); return true;
        }
      }
      if (pending.stage === 'keuze') {
        const n = (raw.match(/^\s*(\d)\b/) || [])[1];
        const byName = pending.opts.find((o) => UP(raw) === UP(o) || (UP(raw).length >= 4 && UP(o).includes(UP(raw))));
        if ((n && +n === pending.opts.length + 1) || /\bnieuw/i.test(raw)) {
          newFund(pending.r, x, x.isin || null);                   // zonder ISIN vraagt advance() ze nu één keer voor dat fonds
          await step(jid, pending); return true;
        }
        const pick = n && +n >= 1 && +n <= pending.opts.length ? pending.opts[+n - 1] : byName;
        if (pick) { pickFund(pending.r, x, pick); await step(jid, pending); return true; }
        if (n && raw.trim().length <= 3) { await send(jid, `Antwoord met een nummer van 1 tot ${pending.opts.length + 1}.\n\n${pending.vraag || ''}`.trim()); return true; }
        return correct(jid, pending, raw);
      }
      if (pending.stage === 'isin') {
        const byUp = new Map(stockList().map((s) => [UP(s), s]));
        if (x.isin && (YES.test(raw) || /\bnieuw/i.test(raw))) { newFund(pending.r, x, x.isin); await step(jid, pending); return true; }
        if (byUp.has(UP(raw))) { pickFund(pending.r, x, byUp.get(UP(raw))); await step(jid, pending); return true; }
        if (raw.split(/\s+/).length <= 3 && !/\d/.test(raw)) {
          await send(jid, `Dat is geen ISIN. Een ISIN heeft 12 tekens: 2 letters en dan 10 cijfers of letters, bv. IE00BMC38736. ${ISIN_HELP} Of zeg welk fonds uit de lijst je bedoelt, of *stop*.`);
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
    if (pending?.stage === 'voorstel' && /\?\s*$/.test(raw) && /(heb je|staat|zit|is).{0,30}\b(al|er al)\b|al in (mijn|je|de) sheet|dubbel/i.test(raw)
        && pending.sheet && pending.r.rijen.every((x) => x.dup_ok)) {
      await send(jid, `Nog niet: ik vond ${pending.r.rijen.length > 1 ? 'deze rijen' : 'deze rij'} niet in je sheet, dus het wordt niet dubbel. Antwoord *ja* om ${pending.r.rijen.length > 1 ? 'ze' : 'ze'} toe te voegen, of *stop*.`);
      return true;
    }
    if (pending?.stage === 'voorstel') {
      if (NO.test(raw)) { delete state.pending[jid]; saveState(); await send(jid, 'Oké, niets ingegeven.'); await nextDividend(jid, pending.member); return true; }
      if (YES.test(raw)) {
        if (problems(pending.r).length) { await send(jid, `Er ontbreekt nog iets:\n${problems(pending.r).map((q) => `• ${q}`).join('\n')}`); return true; }
        const rows = pending.r.rijen.map((x) => ({ type: x.type, stock: x.aandeel, shares: x.type === 'Dividend' ? null : x.aantal, total_eur: x.totaal_eur, date: x.datum,
          ...(x.force ? { force: true } : {}), ...(x.nieuw && x.isin ? { isin: x.isin } : {}) }));
        delete state.pending[jid]; saveState();
        try {
          const out = await write(jid, pending.member, rows, pending.via || viaOf(jid));
          if (out.queued) await send(jid, '✅ Goedgekeurd. Gilles zet het in je sheet; de maandagscan neemt het daarna mee.');
          else {
            const done = (out.results || []).filter((x) => x.status === 'written').length;
            const wrote = (out.results || []).map((x, k) => (x.status === 'written' && x.row ? { row: x.row, stock: x.stock || rows[k].stock, type: rows[k].type, date: rows[k].date } : null)).filter(Boolean);
            if (wrote.length) { state.last[jid] = { member: pending.member, at: Date.now(), rows: wrote }; saveState(); }
            const dup = (out.results || []).filter((x) => x.status === 'duplicate').length;
            let t = done ? `✅ Staat in je sheet${done > 1 ? ` (${done} rijen)` : ''}. De maandagscan neemt het mee.` : '';
            if (dup) t += `${t ? '\n' : ''}${dup > 1 ? `${dup} rijen stonden` : 'Die rij stond'} al in je sheet, dus niets dubbel ingegeven.`;
            await send(jid, t || 'Niets ingegeven.');
            const a = adminJid();
            if (a && a !== jid && done) getSock().sendMessage(a, { text: claudeTag + `📥 ${pending.member} gaf ${done} transactie${done > 1 ? 's' : ''} door via ${pending.via || viaOf(jid)}: ${rows.map((x) => `${TYPE_NL[x.type]} ${x.stock}`).join(', ')}` }).catch(() => {});
            const fresh = rows.filter((x) => x.isin);
            if (a && done && fresh.length) getSock().sendMessage(a, { text: claudeTag + `🆕 ${pending.member} gaf een nieuw aandeel door: ${fresh.map((x) => `${x.stock} (ISIN ${x.isin})`).join(', ')}. Staat nog niet in de lijst; de maandagscan vraagt de classificatie.` }).catch(() => {});
          }
        } catch (e) {
          log('invoer write:', e.message);
          await send(jid, 'Het lukte niet om het in je sheet te zetten. Ik heb Gilles verwittigd; probeer het later nog eens of zet het er zelf in.');
          const a = adminJid();
          if (a) getSock().sendMessage(a, { text: claudeTag + `⚠️ Invoer voor ${pending.member} mislukt: ${e.message}` }).catch(() => {});
        }
        await nextDividend(jid, pending.member);
        return true;
      }
      return correct(jid, pending, raw);                            // correctie of aanvulling
    }

    // Nieuw bericht: is het een transactie?
    if (!imgs.length && !(TX_WORDS.test(raw) && /\d/.test(raw))) return false;
    if (imgs.length) images.set(jid, { images: imgs, at: Date.now() }); else images.delete(jid);   // een nieuwe transactie: oude screenshot vergeten
    for (const [j, v] of images) if (Date.now() - v.at > IMAGE_TTL) images.delete(j);
    if (!budgetOk(jid)) return false;

    await typing(jid);
    const r = await readSmart({ member, text: raw, imgs }, jid);
    saveState();
    if (r && !r.is_transactie && imgs.length && (r.posities || []).length && (!raw || CHECK_RE.test(raw))) {
      if (member) return positionsCheck(jid, member, r.posities);
      state.pending[jid] = { stage: 'wie', at: Date.now(), saved: { pos: r.posities } };
      saveState();
      await send(jid, `Ik vergelijk je screenshot graag met je sheet, maar ik ken je nummer nog niet. Wie ben je? Antwoord met je voornaam: ${MEMBERS.join(', ')}.`);
      return true;
    }
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
    await typing(jid);
    const r = await readSmart({ member: pending.member, imgs: images.get(jid)?.images || [], previous: clean(pending.r), correction: raw }, jid, (pending.tries || 0) >= 1);
    saveState();
    if (!r || !r.rijen?.length) { await send(jid, 'Dat begrijp ik niet goed. Zeg wat er anders moet, of *stop*.'); return true; }
    await step(jid, { member: pending.member, r: carry(pending.r, r), tries: (pending.tries || 0) + 1, sheet: pending.sheet, ...(pending.via ? { via: pending.via } : {}) });
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

  return { handle, report, tick, MODELS, _internals: { followUps, identify, rootWord, findIsin, isinOk, read, problems, proposal, readSmart, needsStrong, advance, candidates, normalize, sheetRows, refPrice, state, positionsCheck, dividendJob, scanReceipts, tick,
    virt, send, step, write, budgetOk, spend, saveState, token, config, stockList, holdings, YES, NO, UP, eur, num, dmy, TYPE_NL, MEMBERS } };
}
