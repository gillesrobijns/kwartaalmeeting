// Automatic messages in the group, at most ONE moment per day (breaking news not counted),
// only between 09:00 and 21:00 Brussels time. In order of priority:
//   1. Claude's and the aap's own transactions (Claude first, the aap 20 seconds later)
//   2. De Kwartaalkrant after the meeting: short text + the krant as pdf
//   3. Duvel reminders between the end of a quarter and the meeting
//   4. Aankoop-verjaardag: a position a member still holds turns 1, 2, 3... years old (from 12:00, max 2 per week)
// The laptop publishes the facts in bot/feed.json (duvel status, krant); previews go to Gilles only.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bxDate, bxMinutes, weekday } from './trader.mjs';
import { fetchDashboardData } from './clubdata.mjs';

const FEED_URL = process.env.FEED_URL || 'https://gillesrobijns.github.io/kwartaalmeeting/bot/feed.json';
const addDays = (ds, n) => { const d = new Date(`${ds}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const longDate = (ds) => new Date(`${ds}T12:00:00Z`).toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const names = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} en ${a[a.length - 1]}`);

export function startAutopost({ dataDir, log, getSock, groups, adminJid, trader, compose, remember, pdf, asClaude }) {
  const FILE = join(dataDir, 'autopost.json');
  const state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { day: '', used: false, done: {} };
  const save = () => writeFileSync(FILE, JSON.stringify(state));
  const status = { feedAt: null, feedError: null, last: null };
  let feed = null, feedFetched = 0;

  async function loadFeed() {
    if (Date.now() - feedFetched < 30 * 60 * 1000) return feed;
    feedFetched = Date.now();
    try {
      const r = await fetch(`${FEED_URL}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
      if (r.status === 404) { feed = null; return feed; }
      if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
      feed = await r.json(); status.feedAt = new Date().toISOString(); status.feedError = null;
    } catch (e) { status.feedError = e.message; }
    return feed;
  }

  async function send(jid, text) { await getSock().sendMessage(jid, { text }); remember?.(jid, text.startsWith('🐒') ? 'De aap' : 'Claude', text); }
  async function sendPdf(jid, buf, fileName, caption) {
    await getSock().sendMessage(jid, { document: buf, mimetype: 'application/pdf', fileName, ...(caption ? { caption } : {}) });
  }
  async function toGroups(fn) { for (const g of groups()) await fn(g); }

  // ---- 1. trades ----
  async function postTrades() {
    const list = trader?.pendingAnnouncements() || [];
    if (!list.length) return false;
    let first = true;
    for (const d of list) {
      if (!first) await new Promise((r) => setTimeout(r, 20000));
      const text = d.bot === 'Claude' ? asClaude(d.message) : d.message;
      await toGroups((g) => send(g, text));
      trader.markAnnounced(d.id);
      first = false;
    }
    return 'trades';
  }

  // ---- 2. krant ----
  async function krantMessages(k) {
    let buf = null;
    try { buf = await pdf.renderKrant(k.recap); } catch (e) { log('krant pdf failed:', e.message); }
    return { text: asClaude(k.text), buf, fileName: `De Kwartaalkrant ${k.recap?.quarter || k.id}.pdf` };
  }
  async function postKrant(today, m) {
    const k = feed?.krant;
    if (!k?.id || !k.recap || !k.post_from || today < k.post_from || m < 9 * 60 + 30 || state.done[`krant:${k.id}`]) return false;
    const { text, buf, fileName } = await krantMessages(k);
    await toGroups(async (g) => { await send(g, text); if (buf) await sendPdf(g, buf, fileName); });
    state.done[`krant:${k.id}`] = new Date().toISOString();
    return 'krant';
  }

  // ---- 3. duvel ----
  // feed.duvel = { quarter, label, quarter_end, meeting_date, not_yet[], proposed_losers[], status, scanned_at }
  async function postDuvel(today, m) {
    const d = feed?.duvel;
    if (!d?.quarter || !d.quarter_end || !d.meeting_date || m < 11 * 60) return false;
    if (!(today > d.quarter_end && today < d.meeting_date) || d.status === 'confirmed') return false;
    const key = (k) => `duvel:${d.quarter}:${k}`;
    const left = Math.round((new Date(d.meeting_date) - new Date(today)) / 864e5);
    const fresh = d.scanned_at && d.scanned_at.slice(0, 10) >= addDays(today, -3);
    const notYet = d.not_yet || [];
    let kind = null, facts = '';
    if (today === addDays(d.meeting_date, -1) && notYet.length && !state.done[key('final')]) {
      kind = 'final';
      facts = `Morgen (${longDate(d.meeting_date)}) is de kwartaalmeeting. Volgens de laatste scan (${longDate(String(d.scanned_at).slice(0, 10))}) gaven ${names(notYet)} nog geen transacties door voor ${d.label}. Wie het laatst is, trakteert een rondje Duvel. Dit is de laatste oproep.`;
    } else if (!notYet.length && d.proposed_losers?.length && fresh && !state.done[key('done')]) {
      kind = 'done';
      facts = `Iedereen heeft zijn transacties voor ${d.label} doorgegeven. De laatste inzending kwam van ${names(d.proposed_losers)}: die trakteert het rondje Duvel op de meeting van ${longDate(d.meeting_date)}, tenzij Gilles anders beslist.`;
    } else if (!state.done[key('kickoff')]) {
      kind = 'kickoff';
      facts = `${d.label} is afgesloten. Iedereen vult zijn transacties van dat kwartaal in zijn eigen sheet in, vóór de meeting van ${longDate(d.meeting_date)} (nog ${left} dagen). Wie het laatst is, trakteert een rondje Duvel. Noem nog geen namen.`;
    } else if (weekday(today) === 2 && fresh && notYet.length && !state.done[key(today)]) {
      kind = today;
      facts = `Duvelstand na de scan van maandag: ${names(notYet)} gaven nog geen transacties door voor ${d.label}. Nog ${left} dagen tot de meeting van ${longDate(d.meeting_date)}. Wie het laatst is, trakteert.`;
    }
    if (!kind) return false;
    let text = null;
    try {
      text = await compose(`Schrijf één kort bericht voor de groep over de Duvelteller (wie zijn transacties het laatst doorgeeft, trakteert een rondje Duvel). Feiten:\n${facts}\n\nHoogstens 2 zinnen, droog en met een knipoog, eindig met 🍺. Gebruik alleen deze feiten. Schrijf alleen het bericht.`);
    } catch (e) { log('duvel compose failed:', e.message); }
    if (!text) text = facts.replace(/ Noem nog geen namen\.$/, '') + ' 🍺';
    await toGroups((g) => send(g, asClaude(text)));
    state.done[key(kind)] = new Date().toISOString();
    return `duvel ${kind}`;
  }

  // ---- 4. aankoop-verjaardag ----
  // First purchase date per member+stock from the public dashboard (closed quarters only, no euro amounts).
  // Only positions still held and never sold since that first purchase; return = the position's return at the
  // end of the last closed quarter, so nothing from the running (secret) quarter leaks.
  let dash = null, dashAt = 0;
  async function anniversaries(today) {
    if (!dash || Date.now() - dashAt > 6 * 60 * 60 * 1000) { dash = await fetchDashboardData(); dashAt = Date.now(); }
    const meta = dash.meta || {};
    const qs = (meta.available_quarters || []).filter((q) => q !== meta.locked_quarter);
    const first = {}, sold = {};
    for (const q of qs) {
      for (const b of dash.quarters[q]?.bought_positions || []) { const k = `${b.member}|${b.stock}`, dt = String(b.date).slice(0, 10); if (!first[k] || dt < first[k]) first[k] = dt; }
      for (const t of dash.quarters[q]?.sold_positions || []) (sold[`${t.member}|${t.stock}`] ||= []).push(String(t.date).slice(0, 10));
    }
    const L = dash.quarters[meta.latest_quarter] || {};
    const held = (L.holdings || []).filter((h) => (h.current_value_eur || 0) > 0);
    const tot = {};
    for (const h of held) tot[h.member] = (tot[h.member] || 0) + h.current_value_eur;
    const out = [];
    for (const h of held) {
      const k = `${h.member}|${h.stock}`, f = first[k];
      if (!f || (sold[k] || []).some((x) => x >= f) || h.return_pct == null) continue;
      for (let y = 1; y <= 10; y++) {
        const ann = `${Number(f.slice(0, 4)) + y}${f.slice(4)}`;
        const late = (new Date(`${today}T12:00:00Z`) - new Date(`${ann}T12:00:00Z`)) / 864e5;
        if (late < 0 || late > 6) continue;
        const id = `anniv:${k}:${y}`;
        if (!state.done[id]) out.push({ id, member: h.member, stock: h.stock, years: y, first: f, late, ret: h.return_pct,
          weight: Math.round(100 * h.current_value_eur / (tot[h.member] || 1)), asOf: String(L.end_date || '').slice(0, 10) });
      }
    }
    return out.sort((a, b) => Math.abs(b.ret) - Math.abs(a.ret));
  }
  async function postAnniversary(today, m) {
    if (m < 12 * 60) return false;
    const week = addDays(today, -((weekday(today) + 6) % 7));       // monday of this week
    if (state.annivWeek !== week) { state.annivWeek = week; state.annivN = 0; }
    if (state.annivN >= 2) return false;
    let list;
    try { list = await anniversaries(today); } catch (e) { log('anniversary data failed:', e.message); return false; }
    const a = list[0];
    if (!a) return false;
    const pct = `${a.ret >= 0 ? '+' : ''}${(a.ret * 100).toFixed(1).replace('.', ',')}%`;
    const when = a.late < 1 ? 'Vandaag is het' : 'Deze week was het';
    const facts = `${when} precies ${a.years} jaar geleden (${longDate(a.first)}) dat ${a.member} voor het eerst ${a.stock} kocht, en hij heeft het nog altijd. ` +
      `Rendement op die positie: ${pct} (stand op ${longDate(a.asOf)}, het einde van het laatst afgesloten kwartaal). Gewicht in zijn portefeuille: ${a.weight}%.`;
    let text = null;
    try {
      text = await compose(`Aankoop-verjaardag. ${facts}\n\nSchrijf één kort bericht voor de groep: begin met 🎂, en feliciteer of roast ${a.member} met dat cijfer, volgens je regels voor humor. ` +
        'Hoogstens 2 zinnen. Geen eurobedragen. Schrijf alleen het bericht.');
    } catch (e) { log('anniversary compose failed:', e.message); }
    if (!text) text = `🎂 ${a.years} jaar geleden kocht ${a.member} ${a.stock}. Sindsdien: ${pct}.`;
    if (!text.startsWith('🎂')) text = `🎂 ${text}`;
    await toGroups((g) => send(g, asClaude(text)));
    state.done[a.id] = new Date().toISOString();
    state.annivN++;
    return `verjaardag ${a.member} ${a.stock}`;
  }

  // ---- previews for Gilles (no daily limit, private) ----
  async function previews() {
    const admin = adminJid();
    if (!admin) return;
    for (const p of feed?.previews || []) {
      if (!p.id || state.done[`preview:${p.id}`]) continue;
      state.done[`preview:${p.id}`] = new Date().toISOString(); save();
      try {
        if (p.krant) {
          const { text, buf, fileName } = await krantMessages(p.krant);
          await getSock().sendMessage(admin, { text: `👀 *Voorbeeld voor Gilles* (de groep ziet dit niet)\n\n${text}` });
          if (buf) await sendPdf(admin, buf, fileName);
        } else if (p.text) await getSock().sendMessage(admin, { text: `👀 *Voorbeeld voor Gilles*\n\n${p.text}` });
        log(`preview ${p.id} sent to admin`);
      } catch (e) { log('preview failed:', e.message); }
    }
  }

  let busy = false;
  async function tick() {
    if (busy || !getSock() || !groups().length) return;
    busy = true;
    try {
      const today = bxDate(), m = bxMinutes();
      if (state.day !== today) { state.day = today; state.used = false; save(); }
      await loadFeed();
      if (m >= 8 * 60 && m < 22 * 60) await previews();
      if (state.used || m < 9 * 60 || m >= 21 * 60) return;
      for (const job of [() => postTrades(), () => postKrant(today, m), () => postDuvel(today, m), () => postAnniversary(today, m)]) {
        const what = await job();
        if (what) { state.used = true; status.last = `${today} ${what}`; log(`autopost: ${what}`); break; }
      }
      save();
    } catch (e) { log('autopost:', e.message); } finally { busy = false; }
  }

  setTimeout(tick, 45 * 1000);
  setInterval(tick, 2 * 60 * 1000);
  return { status, tick, state, anniversaries };
}
