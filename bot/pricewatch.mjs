// Breaking news: every 15 minutes (08:00-22:00 Brussels time) the bot checks the day move of
// every stock a member holds. Each time a stock crosses another 5% down (-5%, -10%, -15%, ...)
// versus the previous close, it is reported once. Several drops in one check = one message.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STEP = 5;                 // percent
const EVERY_MS = 15 * 60 * 1000;
const MAX_ALERTS_PER_DAY = 4;   // messages, not stocks

const brusselsHour = () => Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Brussels' }));
const brusselsDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });

export async function quote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${ticker} HTTP ${r.status}`);
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice || !m?.chartPreviousClose) throw new Error(`${ticker} no price`);
  return {
    price: m.regularMarketPrice,
    prev: m.chartPreviousClose,
    pct: (m.regularMarketPrice / m.chartPreviousClose - 1) * 100,
    marketDay: brusselsDate(new Date(m.regularMarketTime * 1000)),
  };
}

export function startPriceWatch({ dir, dataDir, log, holders, announce }) {
  const stateFile = join(dataDir, 'pricewatch.json');
  let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { levels: {}, sent: {} };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));

  async function tick() {
    const h = brusselsHour();
    if (h < 8 || h >= 22) return;                                   // quiet hours
    const today = brusselsDate();
    if ((state.sent[today] || 0) >= MAX_ALERTS_PER_DAY) return;
    const tickersFile = join(dir, 'tickers.json');
    if (!existsSync(tickersFile)) return;
    const tickers = JSON.parse(readFileSync(tickersFile, 'utf8')); // { "NVIDIA": "NVDA", ... }
    const own = Object.fromEntries(Object.entries(holders()).map(([k, v]) => [k.toUpperCase(), v]));  // { "NVIDIA": ["Niels", ...] }
    const hits = [];
    for (const [stock, ticker] of Object.entries(tickers)) {
      if (!own[stock]?.length) continue;                             // only stocks somebody holds
      let q;
      try { q = await quote(ticker); } catch { continue; }
      const level = q.pct <= -STEP ? Math.floor(-q.pct / STEP) : 0;
      const key = `${stock}|${q.marketDay}`;
      if (level > (state.levels[key] || 0)) {
        state.levels[key] = level;
        hits.push({ stock, pct: q.pct, holders: own[stock], today: q.marketDay === today });
      }
      await new Promise((r) => setTimeout(r, 250));                  // be gentle with the price source
    }
    for (const k of Object.keys(state.levels)) if (k.split('|')[1] < brusselsDate(new Date(Date.now() - 7 * 864e5))) delete state.levels[k];
    if (hits.length) {
      state.sent[today] = (state.sent[today] || 0) + 1;
      for (const d of Object.keys(state.sent)) if (d !== today) delete state.sent[d];
      log(`breaking news: ${hits.map((x) => `${x.stock} ${x.pct.toFixed(1)}%`).join(', ')}`);
      try { await announce(hits); } catch (e) { log('announce failed:', e.message); }
    }
    save();
  }

  setTimeout(() => tick().catch((e) => log('pricewatch:', e.message)), 60 * 1000);
  setInterval(() => tick().catch((e) => log('pricewatch:', e.message)), EVERY_MS);
}
