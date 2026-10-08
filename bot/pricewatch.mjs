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
