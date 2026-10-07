// Claude (lid 11) and de beleggende aap (lid 12) invest with €50.000 virtual money each.
// - Orders are "op slotkoers": decided during the day, booked at that day's close (+ €7,50 per transaction).
// - Claude decides on his start day and every Monday (max 2 transactions), following claude_strategie.md.
// - The aap sells everything on the first Monday of each quarter and buys 10 random S&P 500 / BEL 20 stocks.
// - The ledger lives in DATA_DIR/ledger.json and is published read-only at /feed/ledger.json
//   (the laptop mirrors it into data/bot_transactions.json).

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

export const CAPITAL = 50000;
export const FEE = 7.5;
export const START_DATE = '2026-10-07';
const MAX_POS = 0.15;
const FILL_AFTER = 22 * 60 + 45;            // book today's orders after 22:45 Brussels (all big markets closed)
const EUROPE = new Set(['EUR', 'CHF', 'GBP', 'DKK', 'SEK', 'NOK', 'PLN', 'CZK', 'HUF']);
const MONKEY_TAG = '🐒 Aap: ';

// ---------- time (Brussels) ----------
const TZ = 'Europe/Brussels';
export const bxDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
export const bxMinutes = (d = new Date()) => {
  const [h, m] = d.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return (h % 24) * 60 + m;
};
export const weekday = (ds) => new Date(`${ds}T12:00:00Z`).getUTCDay();          // 1 = Monday
export const quarterOf = (ds) => { const [y, m] = ds.split('-').map(Number); return `Q${Math.floor((m - 1) / 3) + 1}_${y}`; };
const addDays = (ds, n) => { const d = new Date(`${ds}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nl = (x, dec = 1) => x.toFixed(dec).replace('.', ',');
const pct = (x) => `${x >= 0 ? '+' : ''}${nl(x * 100)}%`;
const eur = (x) => `€${Math.round(x).toLocaleString('nl-BE')}`;

// ---------- prices (Yahoo) ----------
function normCur(c) {
  if (c === 'GBp' || c === 'GBX') return { cur: 'GBP', div: 100 };
  if (c === 'ZAc') return { cur: 'ZAR', div: 100 };
  if (c === 'ILA') return { cur: 'ILS', div: 100 };
  return { cur: (c || '').toUpperCase(), div: 1 };
}
async function chart(ticker, range = '1mo', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${ticker}: HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  if (!res?.meta?.currency) throw new Error(`${ticker}: onbekende ticker`);
  const tz = res.meta.exchangeTimezoneName || 'UTC';
  const q = res.indicators?.quote?.[0] || {};
  const closes = (res.timestamp || [])
    .map((t, i) => ({ date: new Date(t * 1000).toLocaleDateString('sv-SE', { timeZone: tz }), close: q.close?.[i] ?? null }));
  return { meta: res.meta, closes };
}
const fxCache = new Map();
async function fxOn(cur, date) {                       // units of `cur` per 1 EUR, at the close of `date` (or the last one before)
  if (cur === 'EUR') return 1;
  const key = `${cur}|${date || 'now'}`;
  if (fxCache.has(key) && (date || Date.now() - fxCache.get(key).at < 10 * 60 * 1000)) return fxCache.get(key).v;
  const { meta, closes } = await chart(`EUR${cur}=X`, '3mo');
  let v = meta.regularMarketPrice;
  if (date) {
    const before = closes.filter((c) => c.date <= date && c.close != null);
    if (before.length) v = before[before.length - 1].close;
  }
  if (!v) throw new Error(`geen wisselkoers EUR/${cur}`);
  fxCache.set(key, { v, at: Date.now() });
  return v;
}
const quoteCache = new Map();
export async function quote(ticker) {
  ticker = String(ticker || '').trim().toUpperCase();
  const hit = quoteCache.get(ticker);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.q;
  const { meta } = await chart(ticker, '5d');
  if (!meta.regularMarketPrice) throw new Error(`${ticker}: geen koers`);
  const { cur, div } = normCur(meta.currency);
  const price = meta.regularMarketPrice / div;
  const q = {
    ticker, currency: cur, price,
    price_eur: price / (await fxOn(cur)),
    name: meta.longName || meta.shortName || ticker,
    exchange: meta.fullExchangeName || meta.exchangeName || '',
  };
  quoteCache.set(ticker, { q, at: Date.now() });
  return q;
}
async function closeOn(ticker, date) {               // the close of `date`, or the first trading day after it
  const { meta, closes } = await chart(ticker, '3mo');
  let c = closes.find((x) => x.date === date && x.close != null);
  if (!c && closes.some((x) => x.date === date)) {
    // Yahoo sometimes leaves a daily close empty: take the last hourly price of that day
    const h = (await chart(ticker, '1mo', '60m')).closes.filter((x) => x.date === date && x.close != null);
    if (h.length) c = h[h.length - 1];
  }
  if (!c) c = closes.find((x) => x.date > date && x.close != null);   // exchange closed that day: next trading day
  if (!c) return null;                               // not traded yet: try again later
  const { cur, div } = normCur(meta.currency);
  const price = c.close / div;
  const fx = await fxOn(cur, c.date);
  return { date: c.date, price, currency: cur, fx, price_eur: price / fx };
}

// ---------- the trader ----------
export function createTrader({ dir, dataDir, log, anthropic, model, persona, clubSummary, clubNames }) {
  const FILE = join(dataDir, 'ledger.json');
  let L = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8'))
    : { version: 1, start_date: START_DATE, capital: CAPITAL, fee: FEE, orders: [], decisions: [], strategy_changes: [] };
  const save = () => { writeFileSync(FILE + '.tmp', JSON.stringify(L, null, 1)); renameSync(FILE + '.tmp', FILE); };
  const status = { lastTick: null, lastError: null, lastDecision: null, attempts: {} };
  const universe = () => JSON.parse(readFileSync(join(dir, 'universe.json'), 'utf8'));
  const strategy = () => {
    let s = existsSync(join(dir, 'claude_strategie.md')) ? readFileSync(join(dir, 'claude_strategie.md'), 'utf8') : '';
    const fresh = L.strategy_changes.filter((c) => !s.includes(c.wijziging));      // the laptop copies them into the .md
    if (fresh.length) s += '\n\nLatere wijzigingen (door jou beslist, gaan voor op wat hierboven staat):\n' +
      fresh.map((c) => `- ${c.date}: ${c.wijziging} (reden: ${c.reden})`).join('\n');
    return s;
  };
  const nextId = (p) => `${p}${Date.now().toString(36)}${randomInt(1000)}`;

  // Display name: the club's own name when the club already knows the ticker, else the universe, else Yahoo.
  function displayName(ticker, fallback) {
    const club = clubNames?.() || {};
    for (const [n, t] of Object.entries(club)) if (String(t).toUpperCase() === ticker) return n;
    const u = universe().find((x) => x.ticker === ticker);
    return u?.name || String(fallback || ticker).toUpperCase().replace(/,?\s+(INC\.?|CORP\.?|CORPORATION|N\.V\.|S\.A\.|SE|AG|PLC|NV|SA)$/i, '').trim();
  }

  // Cash and positions from FILLED orders only.
  function book(bot) {
    let cash = CAPITAL;
    const pos = {};
    const filled = L.orders.filter((o) => o.bot === bot && o.status === 'filled')
      .sort((a, b) => a.fill.date.localeCompare(b.fill.date) || (a.action === 'Sell' ? -1 : 1) - (b.action === 'Sell' ? -1 : 1));
    for (const o of filled) {
      const f = o.fill;
      if (o.action === 'Buy') {
        cash -= f.total_eur;
        const p = (pos[o.ticker] ||= { ticker: o.ticker, name: o.name, shares: 0, cost: 0, since: f.date });
        p.shares += f.shares; p.cost += f.total_eur;
        if (o.reason) { p.reason = o.reason; p.sell_condition = o.sell_condition; }
      } else {
        cash += f.total_eur;
        const p = pos[o.ticker];
        if (!p) continue;
        const avg = p.cost / p.shares;
        p.shares -= f.shares; p.cost -= avg * f.shares;
        if (p.shares < 1e-6) delete pos[o.ticker];
      }
    }
    return { cash, pos };
  }

  async function valuation(bot) {
    const { cash, pos } = book(bot);
    const rows = [];
    for (const p of Object.values(pos)) {
      let price_eur = p.cost / p.shares;
      try { price_eur = (await quote(p.ticker)).price_eur; } catch (e) { log(`trader: no quote for ${p.ticker}: ${e.message}`); }
      rows.push({ ...p, price_eur, value: p.shares * price_eur, ret: (p.shares * price_eur) / p.cost - 1 });
    }
    const total = cash + rows.reduce((s, r) => s + r.value, 0);
    rows.sort((a, b) => b.value - a.value);
    for (const r of rows) r.weight = r.value / total;
    return { cash, rows, total, ret: total / CAPITAL - 1 };
  }

  const openOrders = (bot) => L.orders.filter((o) => o.bot === bot && o.status === 'open');

  // ---------- Claude decides ----------
  const TOOLS = [
    { type: 'web_search_20260318', name: 'web_search', max_uses: 6 },
    {
      name: 'koers_opzoeken',
      description: 'Zoek de actuele koers van één of meer aandelen op Yahoo Finance. Geef Yahoo-tickers: VS zonder achtervoegsel (MSFT), Europa met beurs (ASML.AS, MC.PA, SAP.DE, NOVO-B.CO, NESN.SW, ULVR.L, UCB.BR). Gebruik dit om elke ticker te controleren voor je hem in een order zet.',
      input_schema: { type: 'object', properties: { tickers: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, required: ['tickers'] },
    },
    {
      name: 'beslissing',
      description: 'Leg je beslissing vast. Roep dit precies één keer aan, als laatste stap. Orders worden geboekt tegen de slotkoers van vandaag, min €7,50 per transactie.',
      input_schema: {
        type: 'object',
        properties: {
          orders: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                actie: { type: 'string', enum: ['koop', 'verkoop'] },
                ticker: { type: 'string', description: 'Yahoo-ticker, gecontroleerd met koers_opzoeken' },
                naam: { type: 'string', description: 'Korte bedrijfsnaam, bv. ASML' },
                bedrag_eur: { type: 'number', description: 'Bij koop: hoeveel euro je investeert (kosten inbegrepen). Bij verkoop: weglaten (je verkoopt de hele positie) of het deel in euro.' },
                reden: { type: 'string', description: 'Eén zin: waarom' },
                verkoopvoorwaarde: { type: 'string', description: 'Bij koop: wat er moet gebeuren om te verkopen' },
              },
              required: ['actie', 'ticker', 'naam', 'reden'],
            },
          },
          bericht: { type: 'string', description: 'Je bericht voor de WhatsApp-groep (leeg als je niets doet)' },
          strategie_wijziging: {
            type: 'object',
            description: 'Alleen als je je strategie echt aanpast',
            properties: { wijziging: { type: 'string' }, reden: { type: 'string' } },
          },
        },
        required: ['orders'],
      },
    },
  ];

  function portfolioText(v) {
    if (!v.rows.length) return `Je hebt nog niets: €${CAPITAL.toLocaleString('nl-BE')} cash.`;
    return [
      `Cash: ${eur(v.cash)} (${nl(100 * v.cash / v.total)}% van je portefeuille).`,
      ...v.rows.map((r) => `- ${r.name} (${r.ticker}): ${nl(100 * r.weight)}% van je portefeuille, ${eur(r.value)}, rendement ${pct(r.ret)}, gekocht ${r.since}. Reden: ${r.reason || '-'} Verkoop als: ${r.sell_condition || '-'}`),
      `Totale waarde: ${eur(v.total)} (${pct(v.ret)} sinds de start met €50.000 op ${START_DATE}).`,
    ].join('\n');
  }

  async function validate(kind, input, v, quotes) {
    const errs = [];
    const orders = Array.isArray(input.orders) ? input.orders : [];
    const buys = orders.filter((o) => o.actie === 'koop');
    const sells = orders.filter((o) => o.actie === 'verkoop');
    if (kind === 'initial' && (buys.length < 8 || buys.length > 12)) errs.push(`Bij de start koop je 8 tot 12 aandelen (nu ${buys.length}).`);
    if (kind === 'weekly' && orders.length > 2) errs.push(`Hoogstens 2 transacties per week (nu ${orders.length}).`);
    let sellCash = 0;
    for (const o of sells) {
      const p = v.rows.find((r) => r.ticker === String(o.ticker).toUpperCase());
      if (!p) { errs.push(`Je hebt geen ${o.ticker} om te verkopen.`); continue; }
      sellCash += (o.bedrag_eur ? Math.min(o.bedrag_eur, p.value) : p.value) - FEE;
    }
    let buyTotal = 0, europe = 0;
    const seen = new Set();
    for (const o of buys) {
      const t = String(o.ticker || '').toUpperCase();
      if (seen.has(t)) errs.push(`${t} staat twee keer in je orders.`);
      seen.add(t);
      if (!o.reden?.trim() || !o.verkoopvoorwaarde?.trim()) errs.push(`${t}: elke aankoop heeft een reden én een verkoopvoorwaarde.`);
      if (!(o.bedrag_eur > 0)) { errs.push(`${t}: geef een bedrag in euro.`); continue; }
      let q = quotes.get(t);
      if (!q) { try { q = await quote(t); quotes.set(t, q); } catch (e) { errs.push(`${t}: ${e.message}. Zoek de juiste Yahoo-ticker op.`); continue; } }
      const after = (v.rows.find((r) => r.ticker === t)?.value || 0) + o.bedrag_eur;
      if (after > MAX_POS * v.total + 1) errs.push(`${t}: ${eur(after)} is meer dan 15% van je portefeuille (max ${eur(MAX_POS * v.total)}).`);
      if (o.bedrag_eur < 1000) errs.push(`${t}: koop voor minstens €1.000, anders eten de kosten je rendement op.`);
      if (EUROPE.has(q.currency)) europe += o.bedrag_eur;
      buyTotal += o.bedrag_eur;
    }
    const available = v.cash + sellCash;
    if (buyTotal > available + 1) errs.push(`Je koopt voor ${eur(buyTotal)} maar je hebt maar ${eur(available)} (cash plus verkopen).`);
    if (kind === 'initial') {
      if (buyTotal < 0.9 * CAPITAL) errs.push(`Investeer bij de start minstens 90% (nu ${eur(buyTotal)}): cash blijft tussen 0 en 10%.`);
      if (europe < 0.2 * buyTotal) errs.push(`Minstens 20% Europese aandelen (nu ${nl(100 * europe / (buyTotal || 1))}%).`);
    }
    if (orders.length && !input.bericht?.trim()) errs.push('Schrijf een bericht voor de groep.');
    if (input.bericht && /€\s?\d|\d\s?€|\d+\s?euro\b/i.test(input.bericht)) errs.push('Geen eurobedragen in het bericht voor de groep: gebruik gewichten in %.');
    return errs;
  }

  async function decideClaude(kind, today) {
    const v = await valuation('Claude');
    const club = clubSummary();
    const task = kind === 'initial'
      ? `Vandaag is je START als belegger. De WhatsApp-groep is net gemaakt en iedereen kijkt. Stel je eerste portefeuille samen volgens je strategie: 8 tot 12 aankopen, samen 90 tot 100% van €50.000 (elke aankoop kost €7,50, dat zit in je bedrag), geen positie boven 15%, minstens 20% Europees, minstens vier sectoren, hoogstens 25% in aandelen die een clublid in zijn top 3 heeft. De regel van twee transacties per week geldt niet voor deze eerste keer.\n\n` +
        'Je bericht voor de groep: begin met één korte zin over je aanpak, dan één regel per aandeel: *naam*, gewicht in %, waarom in een paar woorden. Eindig met één droge zin. Zeg dat alles geboekt wordt tegen de slotkoers van vandaag. Geen eurobedragen.'
      : 'Het is maandag: je wekelijkse beslissing. Lees eerst het nieuws over je posities (web search). Toets elke positie aan haar verkoopvoorwaarde. Hoogstens 2 transacties; de meeste weken is niets doen de beste beslissing. Doe je niets, geef dan een lege lijst orders en een leeg bericht.\n\n' +
        'Doe je iets: je bericht voor de groep noemt elk aandeel met *vet*, wat je doet en waarom in één zin, en bij een aankoop wanneer je verkoopt. Zeg dat het tegen de slotkoers van vandaag geboekt wordt. Hoogstens 5 korte zinnen, geen eurobedragen.';
    const messages = [{
      role: 'user',
      content: `Vandaag is het ${new Date(`${today}T12:00:00Z`).toLocaleDateString('nl-BE', { dateStyle: 'full', timeZone: 'UTC' })}.\n\n` +
        `JOUW PORTEFEUILLE (virtueel, koersen van nu):\n${portfolioText(v)}\n\n${task}\n\n` +
        'Werkwijze: zoek wat je nodig hebt, controleer elke ticker met koers_opzoeken, en roep als laatste beslissing aan. Krijg je fouten terug, pas dan je orders aan en roep beslissing opnieuw aan.',
    }];
    const system = [
      { type: 'text', text: persona },
      { type: 'text', text: `JOUW BELEGGINGSSTRATEGIE (die volg je):\n${strategy()}` },
      { type: 'text', text: club, cache_control: { type: 'ephemeral' } },
    ];
    const quotes = new Map();
    for (let round = 0; round < 14; round++) {
      const res = await anthropic.messages.create({ model, max_tokens: 4000, system, tools: TOOLS, messages });
      const u = res.usage || {};
      log(`trader claude r${round}: in=${u.input_tokens} cache=${u.cache_read_input_tokens || 0} out=${u.output_tokens} searches=${u.server_tool_use?.web_search_requests || 0} stop=${res.stop_reason}`);
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;
      if (res.stop_reason !== 'tool_use') {
        messages.push({ role: 'user', content: 'Roep nu beslissing aan (een lege lijst orders als je niets doet).' });
        continue;
      }
      const results = [];
      let accepted = null;
      for (const b of res.content) {
        if (b.type !== 'tool_use') continue;
        if (b.name === 'koers_opzoeken') {
          const lines = [];
          for (const t of (b.input.tickers || []).slice(0, 20)) {
            try { const q = await quote(t); quotes.set(q.ticker, q); lines.push(`${q.ticker}: ${q.name}, ${q.exchange}, ${nl(q.price, 2)} ${q.currency} = €${nl(q.price_eur, 2)}`); }
            catch (e) { lines.push(`${String(t).toUpperCase()}: ${e.message}`); }
          }
          results.push({ type: 'tool_result', tool_use_id: b.id, content: lines.join('\n') || 'Geen tickers.' });
        } else if (b.name === 'beslissing') {
          const errs = await validate(kind, b.input, v, quotes);
          if (errs.length) results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: `Niet aanvaard:\n- ${errs.join('\n- ')}` });
          else { accepted = b.input; results.push({ type: 'tool_result', tool_use_id: b.id, content: 'Aanvaard.' }); }
        } else results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Onbekende tool.' });
      }
      if (accepted) return record('Claude', kind, today, accepted, v);
      messages.push({ role: 'user', content: results });
    }
    throw new Error('Claude kwam niet tot een geldige beslissing');
  }

  function record(bot, kind, today, input, v) {
    const ids = [];
    for (const o of input.orders || []) {
      const t = String(o.ticker).toUpperCase();
      const held = v?.rows.find((r) => r.ticker === t);
      const order = {
        id: nextId('o'), bot, date: today, action: o.actie === 'koop' ? 'Buy' : 'Sell', ticker: t,
        name: held?.name || displayName(t, o.naam),
        amount_eur: o.actie === 'koop' ? Math.round(o.bedrag_eur * 100) / 100 : (o.bedrag_eur || null),
        sell_all: o.actie === 'verkoop' && !o.bedrag_eur,
        equal_split: !!o.equal_split,
        reason: o.reden || '', sell_condition: o.verkoopvoorwaarde || '',
        status: 'open', created_at: new Date().toISOString(),
      };
      L.orders.push(order); ids.push(order.id);
    }
    const d = { id: nextId('d'), bot, date: today, quarter: quarterOf(today), kind, orders: ids,
      message: (input.bericht || '').trim() || null, announced: !(input.bericht || '').trim() };
    L.decisions.push(d);
    if (input.strategie_wijziging?.wijziging) L.strategy_changes.push({ date: today, ...input.strategie_wijziging });
    save();
    status.lastDecision = `${bot} ${kind} ${today}: ${ids.length} orders`;
    log(`trader: ${status.lastDecision}`);
    return d;
  }

  // ---------- the aap picks ----------
  const PICK_WAYS = [
    'Aap schudden boom. Tien bananen vallen. Op elke banaan staan naam.',
    'Aap blinddoek om. Aap gooien tien kokosnoten op lijst. Waar kokosnoot landen, aap kopen. 🥥',
    'Aap laten vlo springen over krant. Tien keer. Vlo moe nu.',
    'Aap zitten op laptop. Tien keer. Laptop kapot. Scherm zeggen:',
    'Aap snuffelen aan krat. Tien aandelen ruiken naar banaan.',
  ];
  async function decideAap(today) {
    const v = await valuation('Aap');
    const pool = universe();
    const picks = [];
    const used = new Set();
    while (picks.length < 10 && used.size < pool.length) {
      const u = pool[randomInt(pool.length)];
      if (used.has(u.ticker)) continue;
      used.add(u.ticker);
      try { await quote(u.ticker); picks.push(u); } catch (e) { log(`aap skips ${u.ticker}: ${e.message}`); }
    }
    const orders = [
      ...v.rows.map((r) => ({ actie: 'verkoop', ticker: r.ticker, naam: r.name, reden: 'Nieuw kwartaal: aap verkopen alles.' })),
      ...picks.map((u) => ({ actie: 'koop', ticker: u.ticker, naam: u.name, bedrag_eur: 1, equal_split: true, reden: 'Willekeurig.' })),
    ];
    const first = !L.decisions.some((d) => d.bot === 'Aap');
    const way = PICK_WAYS[randomInt(PICK_WAYS.length)];
    const names = picks.map((u) => `*${displayName(u.ticker, u.name)}*`).join(', ');
    const q = quarterOf(today)[1];
    const until = q === '4' ? 'januari' : q === '1' ? 'april' : q === '2' ? 'juli' : 'oktober';
    const message = MONKEY_TAG + [
      first ? 'Groep nieuw. Aap ook nieuw. Aap krijgen vijftigduizend.' : `Nieuw kwartaal. Aap verkopen alles. Aap ${pct(v.ret)}. Aap niet weten of dat goed.`,
      way, names + '.',
      `Aap kopen. Elk evenveel. Aap niet meer kijken tot ${until}.`,
      'Wie onder aap? Ad fundum. 🍺',
    ].join('\n');
    return record('Aap', first ? 'initial' : 'quarter', today, { orders, bericht: message }, v);
  }

  // ---------- fills at the close ----------
  async function fillDue(now = new Date()) {
    const today = bxDate(now);
    const due = L.orders.filter((o) => o.status === 'open' && (o.date < today || (o.date === today && bxMinutes(now) >= FILL_AFTER)));
    const groups = new Map();
    for (const o of due) { const k = `${o.bot}|${o.date}`; (groups.get(k) || groups.set(k, []).get(k)).push(o); }
    for (const [k, orders] of groups) {
      const [bot, date] = k.split('|');
      const px = new Map();
      let waiting = false;
      for (const o of orders) {
        try { const c = await closeOn(o.ticker, date); if (c) px.set(o.id, c); else waiting = true; }
        catch (e) { log(`fill ${o.ticker}: ${e.message}`); if (date < addDays(today, -5)) { o.status = 'failed'; o.note = e.message; } else waiting = true; }
      }
      if (waiting) continue;                          // all orders of one day are booked together
      const { cash: cash0, pos } = book(bot);
      let cash = cash0;
      for (const o of orders.filter((x) => x.action === 'Sell' && x.status === 'open')) {
        const c = px.get(o.id), held = pos[o.ticker]?.shares || 0;
        if (!c || !held) { o.status = 'failed'; o.note = 'geen positie of geen koers'; continue; }
        const shares = o.sell_all ? held : Math.min(held, Math.floor((o.amount_eur / c.price_eur) * 1000) / 1000);
        const total = Math.round((shares * c.price_eur - FEE) * 100) / 100;
        o.fill = { ...c, shares, total_eur: total, filled_at: new Date().toISOString() };
        o.status = 'filled'; cash += total;
      }
      const buys = orders.filter((x) => x.action === 'Buy' && x.status === 'open' && px.get(x.id));
      const want = buys.reduce((s, o) => s + (o.equal_split ? 0 : o.amount_eur), 0);
      const scale = want > cash ? cash / want : 1;
      const equal = buys.filter((o) => o.equal_split);
      const perEqual = equal.length ? (cash - want * scale) / equal.length : 0;
      for (const o of buys) {
        const c = px.get(o.id);
        const amount = o.equal_split ? perEqual : o.amount_eur * scale;
        const shares = Math.floor(((amount - FEE) / c.price_eur) * 1000) / 1000;
        if (shares <= 0) { o.status = 'failed'; o.note = 'te weinig cash'; continue; }
        const total = Math.round((shares * c.price_eur + FEE) * 100) / 100;
        o.fill = { ...c, shares, total_eur: total, filled_at: new Date().toISOString() };
        o.status = 'filled';
      }
      for (const o of orders) if (o.status === 'open' && !px.get(o.id)) { o.status = 'failed'; o.note = 'geen koers'; }
      save();
      log(`trader: booked ${orders.length} orders for ${bot} at the close of ${date}`);
    }
  }

  // ---------- schedule ----------
  let busy = false;
  async function tick(now = new Date()) {
    if (busy) return;
    busy = true;
    try {
      status.lastTick = now.toISOString();
      await fillDue(now);
      const today = bxDate(now), m = bxMinutes(now);
      if (today < START_DATE || m < 9 * 60 || m > 20 * 60) return;
      const tries = (status.attempts[today] ||= {});
      const q = quarterOf(today);
      const aap = L.decisions.filter((d) => d.bot === 'Aap');
      if (!aap.some((d) => d.quarter === q) && (!aap.length || weekday(today) === 1) && (tries.Aap || 0) < 3) {
        tries.Aap = (tries.Aap || 0) + 1;
        try { await decideAap(today); } catch (e) { status.lastError = `aap: ${e.message}`; log('trader aap:', e.message); }
      }
      const cl = L.decisions.filter((d) => d.bot === 'Claude');
      const kind = !cl.length ? 'initial' : (weekday(today) === 1 && !cl.some((d) => d.date >= today)) ? 'weekly' : null;
      if (kind && (tries.Claude || 0) < 3) {
        tries.Claude = (tries.Claude || 0) + 1;
        try { await decideClaude(kind, today); } catch (e) { status.lastError = `claude: ${e.message}`; log('trader claude:', e.status || '', e.message); }
      }
    } finally { busy = false; }
  }

  // ---------- what others read ----------
  function pendingAnnouncements() {
    return L.decisions.filter((d) => d.message && !d.announced).sort((a, b) => (a.bot === 'Claude' ? -1 : 1) - (b.bot === 'Claude' ? -1 : 1));
  }
  function markAnnounced(id) { const d = L.decisions.find((x) => x.id === id); if (d) { d.announced = true; d.announced_at = new Date().toISOString(); save(); } }

  async function summaryText() {
    if (!L.orders.length) return '';
    const out = [`PORTEFEUILLES VAN CLAUDE (JIJ) EN DE AAP (virtueel, elk €50.000 bij de start op ${START_DATE}, €7,50 per transactie). Noem ook hier geen eurobedragen, alleen gewichten en rendementen.`];
    for (const bot of ['Claude', 'Aap']) {
      const v = await valuation(bot);
      const open = openOrders(bot);
      const who = bot === 'Claude' ? 'Claude (jij)' : 'De aap';
      if (!v.rows.length && !open.length) continue;
      out.push(`${who}: ${v.rows.map((r) => `${r.name} ${Math.round(100 * r.weight)}% (${pct(r.ret)})`).join(', ') || 'nog niets geboekt'}; cash ${Math.round(100 * v.cash / v.total)}%; totaal ${pct(v.ret)} sinds de start.`);
      if (open.length) out.push(`  Nog te boeken tegen de slotkoers van ${open[0].date}: ${open.map((o) => `${o.action === 'Buy' ? 'koop' : 'verkoop'} ${o.name}`).join(', ')}.`);
      if (bot === 'Claude') for (const r of v.rows) if (r.reason) out.push(`  ${r.name}: ${r.reason} Verkoop als: ${r.sell_condition}`);
    }
    if (L.strategy_changes.length) out.push(`Jouw strategiewijzigingen: ${L.strategy_changes.map((c) => `${c.date}: ${c.wijziging}`).join('; ')}`);
    return out.join('\n');
  }

  const publicLedger = () => ({ generated_at: new Date().toISOString(), ...L });

  return { tick, fillDue, decideClaude, decideAap, book, valuation, pendingAnnouncements, markAnnounced, summaryText, publicLedger, status, ledger: () => L };
}
