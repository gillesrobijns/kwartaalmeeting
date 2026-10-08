// Koersen, two jobs (8 Oct 2026, replaces the 5%-step breaking news on Gilles' request):
// 1. Morning message (from 08:30 Brussels): the last completed trading day on CLOSING prices.
//    Club stocks that closed 5% or more lower (with who holds them), the indices, and the best riser.
//    By 08:30 Europe and the US have both closed, so one check covers both. Posted only when at least
//    one club stock closed 5%+ lower; quiet days stay silent. Each trading day is reported once.
// 2. Crash alert: every 15 minutes 08:00-22:00, a club stock 15%+ below the previous close is reported
//    once that day, live. Max 2 messages a day.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DIGEST_DROP = 5;      // percent, close to close
export const CRASH_DROP = 15;      // percent, live, versus the previous close
const DIGEST_FROM = 8 * 60 + 30;   // 08:30 Brussels
const DIGEST_UNTIL = 12 * 60;      // not after noon (a late restart should not post a stale morning message)
const CRASH_EVERY_MS = 15 * 60 * 1000;
const DIGEST_EVERY_MS = 5 * 60 * 1000;
const MAX_CRASH_PER_DAY = 2;
export const INDICES = [['S&P 500', '^GSPC'], ['Nasdaq', '^IXIC'], ['BEL 20', '^BFX']];

const bxl = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
};
const brusselsDate = (d = new Date()) => bxl(d).date;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function chart(ticker, range = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${ticker} HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  if (!res?.meta) throw new Error(`${ticker} no data`);
  return res;
}

// Live move versus the previous close (crash alert).
export async function quote(ticker) {
  const m = (await chart(ticker)).meta;
  if (!m?.regularMarketPrice || !m?.chartPreviousClose) throw new Error(`${ticker} no price`);
  return {
    price: m.regularMarketPrice,
    prev: m.chartPreviousClose,
    pct: (m.regularMarketPrice / m.chartPreviousClose - 1) * 100,
    marketDay: brusselsDate(new Date(m.regularMarketTime * 1000)),
  };
}

// Daily closes, dated in the exchange's own calendar. Yahoo sometimes leaves the last daily close empty
// (European stocks): then the regular market price of that same day is the close.
export async function dailyCloses(ticker) {
  const res = await chart(ticker, '10d');
  const m = res.meta, off = m.gmtoffset || 0;
  const day = (ts) => new Date((ts + off) * 1000).toISOString().slice(0, 10);
  const closes = res.indicators?.quote?.[0]?.close || [];
  const bars = (res.timestamp || []).map((ts, i) => ({ date: day(ts), close: closes[i] }));
  const last = bars[bars.length - 1];
  if (last && last.close == null && m.regularMarketTime && day(m.regularMarketTime) === last.date) last.close = m.regularMarketPrice;
  const out = [];
  for (const b of bars) if (b.close != null) { if (out.length && out[out.length - 1].date === b.date) out[out.length - 1] = b; else out.push(b); }
  return out;
}

// Last hourly close per day. Yahoo skips whole daily bars for many ETFs (IWDA, VWCE, ... on 7 Oct 2026);
// the hourly series still has them.
export async function hourlyCloses(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=60m&range=10d`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${ticker} HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  const off = res?.meta?.gmtoffset || 0, closes = res?.indicators?.quote?.[0]?.close || [];
  const by = new Map();
  (res?.timestamp || []).forEach((ts, i) => { if (closes[i] != null) by.set(new Date((ts + off) * 1000).toISOString().slice(0, 10), closes[i]); });
  return [...by].sort().map(([date, close]) => ({ date, close }));
}

function moveOn(bars, date) {
  const i = bars.findIndex((b) => b.date === date);
  if (i < 1) return null;
  return (bars[i].close / bars[i - 1].close - 1) * 100;
}

// Club stocks somebody holds, one entry per ticker (two names on one ticker share their holders).
export function heldTickers(dir, holders) {
  const tickersFile = join(dir, 'tickers.json');
  if (!existsSync(tickersFile)) return [];
  const tickers = JSON.parse(readFileSync(tickersFile, 'utf8'));          // { "NVIDIA": "NVDA", ... }
  const own = Object.fromEntries(Object.entries(holders).map(([k, v]) => [k.toUpperCase(), v]));
  const byTicker = new Map();
  for (const [stock, ticker] of Object.entries(tickers)) {
    if (stock.startsWith('_') || !own[stock.toUpperCase()]?.length) continue;
    const e = byTicker.get(ticker) || { stock, ticker, holders: new Set() };
    own[stock.toUpperCase()].forEach((h) => e.holders.add(h));
    byTicker.set(ticker, e);
  }
  return [...byTicker.values()].map((e) => ({ ...e, holders: [...e.holders] }));
}

// The morning message's data: the last trading day before `today` (Brussels date).
export async function buildDigest({ dir, holders, today = brusselsDate(), log = () => {} }) {
  const idx = [];
  for (const [name, t] of INDICES) {
    try { idx.push({ name, bars: await dailyCloses(t) }); } catch (e) { log('digest index', t, e.message); }
  }
  const days = idx.flatMap((x) => x.bars.map((b) => b.date)).filter((d) => d < today).sort();
  const date = days[days.length - 1];
  if (!date) return null;
  const indices = idx.map((x) => ({ name: x.name, pct: moveOn(x.bars, date) })).filter((x) => x.pct != null);
  const moves = [];
  for (const h of heldTickers(dir, holders)) {
    try {
      let pct = moveOn(await dailyCloses(h.ticker), date);
      if (pct == null) { await pause(150); pct = moveOn(await hourlyCloses(h.ticker), date); }   // still null: that exchange did not trade that day
      if (pct != null) moves.push({ stock: h.stock, ticker: h.ticker, holders: h.holders, pct });
    } catch (e) { log('digest', h.ticker, e.message); }
    await pause(150);                                                  // be gentle with the price source
  }
  moves.sort((a, b) => a.pct - b.pct);
  const drops = moves.filter((m) => m.pct <= -DIGEST_DROP);
  const best = moves.length && moves[moves.length - 1].pct > 0 ? moves[moves.length - 1] : null;
  return { date, today, indices, drops, best, checked: moves.length };
}

export function startPriceWatch({ dir, dataDir, log, holders, announce, announceDigest }) {
  const stateFile = join(dataDir, 'pricewatch.json');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
  state = { crash: state.crash || {}, sent: state.sent || {}, digest: state.digest || {} };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));

  async function crashTick() {
    const { date: today, minutes } = bxl();
    if (minutes < 8 * 60 || minutes >= 22 * 60) return;              // quiet hours
    if ((state.sent[today] || 0) >= MAX_CRASH_PER_DAY) return;
    const hits = [];
    for (const h of heldTickers(dir, holders())) {
      let q;
      try { q = await quote(h.ticker); } catch { continue; }
      const key = `${h.ticker}|${q.marketDay}`;
      if (q.marketDay === today && q.pct <= -CRASH_DROP && !state.crash[key]) {
        state.crash[key] = 1;
        hits.push({ stock: h.stock, pct: q.pct, holders: h.holders, today: true });
      }
      await pause(250);
    }
    const weekAgo = brusselsDate(new Date(Date.now() - 7 * 864e5));
    for (const k of Object.keys(state.crash)) if (k.split('|')[1] < weekAgo) delete state.crash[k];
    if (hits.length) {
      state.sent[today] = (state.sent[today] || 0) + 1;
      for (const d of Object.keys(state.sent)) if (d !== today) delete state.sent[d];
      log(`crash alert: ${hits.map((x) => `${x.stock} ${x.pct.toFixed(1)}%`).join(', ')}`);
      try { await announce(hits); } catch (e) { log('crash announce failed:', e.message); }
    }
    save();
  }

  async function digestTick() {
    const { date: today, minutes } = bxl();
    if (minutes < DIGEST_FROM || minutes >= DIGEST_UNTIL || state.digest.checked === today) return;
    const d = await buildDigest({ dir, holders: holders(), today, log });
    if (!d || !d.checked) return;                                      // price source down: try again in 5 minutes
    state.digest.checked = today;
    const stale = (Date.parse(today) - Date.parse(d.date)) / 864e5 > 4;
    if (state.digest.done === d.date || stale) { save(); return; }    // e.g. Monday: Friday was reported on Saturday
    state.digest.done = d.date;
    save();
    log(`morning digest ${d.date}: ${d.drops.length} drops of ${d.checked} stocks`);
    if (d.drops.length) { try { await announceDigest(d); } catch (e) { log('digest announce failed:', e.message); } }
  }

  setTimeout(() => crashTick().catch((e) => log('pricewatch:', e.message)), 60 * 1000);
  setInterval(() => crashTick().catch((e) => log('pricewatch:', e.message)), CRASH_EVERY_MS);
  setTimeout(() => digestTick().catch((e) => log('digest:', e.message)), 90 * 1000);
  setInterval(() => digestTick().catch((e) => log('digest:', e.message)), DIGEST_EVERY_MS);
}

// ---------- koers tool for chat Claude (8 Oct 2026) ----------
// Claude answered "D'Ieteren is not up" while it was +3.8% that afternoon: web search had only older articles.
// This gives him the live move from the same Yahoo source as the crash alert, before he writes anything.
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const ALIASES = { sp500: '^GSPC', sp: '^GSPC', nasdaq: '^IXIC', bel20: '^BFX', aex: '^AEX', dax: '^GDAXI', cac40: '^FCHI',
  eurostoxx50: '^STOXX50E', stoxx600: '^STOXX', dowjones: '^DJI', dow: '^DJI', bitcoin: 'BTC-EUR', btc: 'BTC-EUR', ethereum: 'ETH-EUR', goud: 'GC=F', gold: 'GC=F' };

function nameMap(dir) {
  const out = [];
  try { for (const [n, t] of Object.entries(JSON.parse(readFileSync(join(dir, 'tickers.json'), 'utf8')))) if (!n.startsWith('_')) out.push([n, t]); } catch {}
  try { for (const u of JSON.parse(readFileSync(join(dir, 'universe.json'), 'utf8'))) out.push([u.name, u.ticker]); } catch {}
  return out;
}

async function resolveTicker(dir, query) {
  const q = norm(query);
  if (!q) return null;
  if (ALIASES[q]) return ALIASES[q];
  const names = nameMap(dir);
  const exact = names.find(([n]) => norm(n) === q);
  if (exact) return exact[1];
  const tick = names.find(([, t]) => norm(t) === q || norm(t.split('.')[0]) === q);
  if (tick) return tick[1];
  if (q.length >= 4) {
    const part = names.find(([n]) => norm(n).startsWith(q) || (norm(n).length >= 4 && q.startsWith(norm(n))));
    if (part) return part[1];
  }
  try {                                                                 // anything else: Yahoo's own search
    const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const hits = ((await r.json())?.quotes || []).filter((x) => ['EQUITY', 'ETF', 'INDEX', 'CRYPTOCURRENCY', 'MUTUALFUND', 'FUTURE'].includes(x.quoteType));
    if (hits[0]) return hits[0].symbol;
  } catch {}
  if (/^[\^A-Za-z0-9.=-]{1,12}$/.test(String(query).trim())) return String(query).trim().toUpperCase();
  return null;
}

const nl = (x, d = 2) => x.toLocaleString('nl-BE', { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = (p) => `${p >= 0 ? '+' : '−'}${nl(Math.abs(p), 1)}%`;
const CUR = { EUR: '€', USD: '$', GBP: '£', GBp: 'pence ', CHF: 'CHF ', SEK: 'SEK ', CAD: 'CAD ', JPY: '¥' };

// Fresh headlines (Google News RSS, last 2 days). Web search often lags hours behind: on 8 Oct the Belron-banks
// story (15:52) was in this feed within the hour but not in web search. Dutch/Belgian feed first, English if thin.
function cleanName(n) {
  return String(n || '').replace(/,?\s+(group|holding|holdings|corporation|corp\.?|incorporated|inc\.?|n\.?v\.?|s\.?a\.?|plc|ag|se|ab|asa|ltd\.?|limited|co\.?|company|the)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
async function newsFor(name) {
  const items = [];
  for (const [hl, gl, ceid] of [['nl', 'BE', 'BE:nl'], ['en-US', 'US', 'US:en']]) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${name}" when:2d`)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
      const xml = await (await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) })).text();
      for (const it of xml.split('<item>').slice(1)) {
        const tag = (t) => (it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
        const title = tag('title').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
        const when = Date.parse(tag('pubDate'));
        if (title && when && !items.some((x) => x.title === title)) items.push({ title, when });
      }
    } catch {}
    if (items.length >= 3) break;
  }
  return items.sort((a, b) => b.when - a.when).slice(0, 6).map((x) =>
    `${new Date(x.when).toLocaleString('nl-BE', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Brussels' })} · ${x.title}`);
}

// One line of facts in Dutch for the model, plus fresh headlines.
export async function koersInfo(dir, query) {
  const ticker = await resolveTicker(dir, query);
  if (!ticker) return `Geen koers gevonden voor "${query}".`;
  let res;
  try { res = await chart(ticker, '1mo'); } catch { return `Geen koers gevonden voor "${query}" (${ticker}).`; }
  const m = res.meta;
  const day = await chart(ticker, '1d').then((r) => r.meta).catch(() => m);
  const price = day.regularMarketPrice ?? m.regularMarketPrice, prev = day.chartPreviousClose;
  if (!price) return `Geen koers gevonden voor "${query}" (${ticker}).`;
  const off = m.gmtoffset || 0;
  const closes = (res.timestamp || []).map((ts, i) => ({ d: new Date((ts + off) * 1000).toISOString().slice(0, 10), c: res.indicators?.quote?.[0]?.close?.[i] })).filter((b) => b.c != null);
  const first = closes[0], fiveAgo = closes.length > 6 ? closes[closes.length - 6] : null;
  const now = bxl(), t = new Date((day.regularMarketTime || m.regularMarketTime) * 1000), lastDay = brusselsDate(t);
  const hhmm = t.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Brussels' });
  const datum = t.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Brussels' });
  const reg = day.currentTradingPeriod?.regular, open = reg && Date.now() / 1000 >= reg.start && Date.now() / 1000 < reg.end;
  const cur = m.instrumentType === 'INDEX' ? '' : (CUR[m.currency] ?? `${m.currency || ''} `);   // an index is in points, not euro
  const naam = m.longName || m.shortName || query;
  const when = lastDay !== now.date ? `De beurs is vandaag nog niet open of was dicht: laatste koers is van ${datum} ${hhmm}, en de beweging hieronder is die van ${datum}.`
    : open ? `Beurs open, koers van vandaag ${hhmm} (Brussel), kan tot 15 minuten vertraagd zijn.`
    : `Slotkoers van vandaag (${hhmm}).`;
  const parts = [`${naam} (${ticker}): ${cur}${nl(price)}.`, when];
  if (prev) parts.push(`${lastDay === now.date ? 'Vandaag' : 'Die dag'}: ${sgn((price / prev - 1) * 100)} tegenover de vorige slotkoers (${cur}${nl(prev)}).`);
  if (day.regularMarketDayLow && day.regularMarketDayHigh) parts.push(`Dagbereik ${cur}${nl(day.regularMarketDayLow)} - ${cur}${nl(day.regularMarketDayHigh)}.`);
  if (fiveAgo) parts.push(`5 beursdagen: ${sgn((price / fiveAgo.c - 1) * 100)}.`);
  if (first) parts.push(`Sinds ${first.d} (ongeveer een maand): ${sgn((price / first.c - 1) * 100)}.`);
  if (m.fiftyTwoWeekHigh) parts.push(`52 weken: ${cur}${nl(m.fiftyTwoWeekLow)} - ${cur}${nl(m.fiftyTwoWeekHigh)}.`);
  if (m.instrumentType !== 'INDEX') {
    const news = await newsFor(cleanName(m.shortName && m.shortName.length < (m.longName || '').length ? m.longName : (m.longName || m.shortName || query))).catch(() => []);
    parts.push(news.length ? `\nNieuwskoppen van de laatste twee dagen (nieuwste eerst, tijd in Brussel):\n${news.join('\n')}` : '\nGeen nieuwskoppen van de laatste twee dagen gevonden.');
  }
  return parts.join(' ');
}
