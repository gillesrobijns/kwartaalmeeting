// Reads the PUBLIC dashboard (GitHub Pages) and turns it into a compact text
// summary for Claude. The public dashboard holds no euro amounts (values are
// indexed), so nothing private can leak through the bot.

const PUBLIC_URL = process.env.DASHBOARD_URL || 'https://gillesrobijns.github.io/kwartaalmeeting/';
const MARKER = 'const DASHBOARD_DATA = ';

const pct = (x) => (x == null || Number.isNaN(x)) ? '?' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const label = (k) => k.replace('_', ' ');

function extractJson(html) {
  const i = html.indexOf(MARKER);
  if (i < 0) throw new Error('DASHBOARD_DATA not found');
  let depth = 0, inStr = false, esc = false, start = i + MARKER.length;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(html.slice(start, j + 1)); }
  }
  throw new Error('DASHBOARD_DATA not terminated');
}

function ranking(rows) {
  return [...(rows || [])]
    .sort((a, b) => (b.return_pct ?? -9) - (a.return_pct ?? -9))
    .map((r, i) => `${i + 1}. ${r.member} ${pct(r.return_pct)}`)
    .join(' | ');
}

export function buildSummary(d) {
  const meta = d.meta || {};
  const locked = meta.locked_quarter;
  const quarters = (meta.available_quarters || []).filter((q) => q !== locked);
  const latest = quarters.includes(meta.latest_quarter) ? meta.latest_quarter : quarters[quarters.length - 1];
  const q = d.quarters[latest];
  const out = [];

  out.push(`CLUBDATA (bron: publiek dashboard, gegenereerd ${String(meta.generated_at || '').slice(0, 16)})`);
  out.push(`Leden: ${(meta.members || []).join(', ')}. Club gestart ${meta.inception_date}.`);
  out.push(`Laatst afgesloten kwartaal: ${label(latest)} (${String(q.start_date).slice(0, 10)} t.e.m. ${String(q.end_date).slice(0, 10)}).`);
  if (locked) out.push(`${label(locked)} loopt nog en is geheim tot de volgende kwartaalmeeting: geef daar geen cijfers over.`);
  out.push('Alle rendementen zijn procenten. Er staan bewust GEEN eurobedragen in deze data.');
  out.push('');
  out.push(`Rendement kwartaal ${label(latest)}: ${ranking(q.quarterly_returns)}`);
  out.push(`Rendement dit jaar (YTD): ${ranking(q.ytd_returns)}`);
  out.push(`Rendement sinds de start (lifetime): ${ranking(q.lifetime_returns)}`);
  const b = q.benchmarks || {};
  if (b.quarterly) out.push(`Benchmarks kwartaal: ${Object.entries(b.quarterly).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}`);
  if (b.ytd) out.push(`Benchmarks YTD: ${Object.entries(b.ytd).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}`);
  const gs = q.group_stats || {};
  out.push(`Groepsgemiddelde kwartaal ${pct(gs.avg_return)}; ${gs.beat_sp500_count ?? '?'} leden versloegen de S&P 500; ${gs.num_transactions ?? '?'} transacties.`);
  out.push('');

  const jw = q.jersey_winners || {};
  out.push(`Truien ${label(latest)}: ${Object.entries(jw).map(([k, v]) => `${k}: ${v.winner}${v.stock ? ` (${v.stock} ${pct(v.value)})` : ` (${pct(v.value)})`}`).join('; ')}`);
  const defs = meta.jersey_definitions || {};
  out.push(`Betekenis truien: ${Object.entries(defs).map(([k, v]) => `${k} = ${v.description}`).join('; ')}`);

  // Jersey history (last 8 closed quarters)
  const hist = quarters.slice(-8).map((k) => {
    const w = d.quarters[k]?.jersey_winners || {};
    return `${label(k)}: geel ${w['Gele trui']?.winner ?? '-'}, etappe ${w['Etappeprijs']?.winner ?? '-'}, rode lantaarn ${w['Rode lantaarn']?.winner ?? '-'}`;
  });
  out.push(`Truiengeschiedenis: ${hist.join(' | ')}`);
  out.push('');

  // Holdings per member: biggest positions by weight within their own portfolio
  const byMember = {};
  for (const h of q.holdings || []) (byMember[h.member] ||= []).push(h);
  out.push('Portefeuilles (gewicht binnen eigen portefeuille, rendement op de positie):');
  for (const [m, all] of Object.entries(byMember)) {
    const rows = all.filter((r) => (r.current_value_eur || 0) > 0);
    if (!rows.length) { out.push(`- ${m}: portefeuilledata onvolledig`); continue; }
    const tot = rows.reduce((s, r) => s + (r.current_value_eur || 0), 0) || 1;
    const top = rows.sort((a, b) => (b.current_value_eur || 0) - (a.current_value_eur || 0)).slice(0, 10);
    out.push(`- ${m}: ${top.map((r) => `${r.stock} ${Math.round(100 * (r.current_value_eur || 0) / tot)}% (${pct(r.return_pct)})`).join(', ')}${rows.length > 10 ? `, +${rows.length - 10} kleinere` : ''}`);
  }
  out.push('');

  const stocks = [...new Map((q.individual_stocks || []).map((s) => [s.stock, s])).values()]
    .sort((a, b) => b.return_pct - a.return_pct);
  out.push(`Beste aandelen van het kwartaal: ${stocks.slice(0, 6).map((s) => `${s.stock} ${pct(s.return_pct)}`).join(', ')}`);
  out.push(`Slechtste aandelen van het kwartaal: ${stocks.slice(-6).reverse().map((s) => `${s.stock} ${pct(s.return_pct)}`).join(', ')}`);
  const bought = (q.bought_positions || []).map((t) => `${t.member} kocht ${t.stock} (${String(t.date).slice(0, 10)})`);
  const sold = (q.sold_positions || []).map((t) => `${t.member} verkocht ${t.stock} (${String(t.date).slice(0, 10)}, ${pct(t.return_pct)})`);
  if (bought.length) out.push(`Aankopen dit kwartaal: ${bought.slice(0, 25).join('; ')}`);
  if (sold.length) out.push(`Verkopen dit kwartaal: ${sold.slice(0, 25).join('; ')}`);
  out.push('');

  const dv = d.duvel || {};
  if (dv.tally) {
    out.push(`Duvelcounter (wie het laatst zijn transacties doorgeeft, trakteert een rondje Duvel): ${Object.entries(dv.tally).filter(([, n]) => n > 0).map(([m, n]) => `${m} ${n}x`).join(', ') || 'nog niemand'}.`);
    if (dv.current?.losers?.length) out.push(`Laatste Duvelronde (${dv.current.label}): ${dv.current.losers.join(', ')}.`);
  }
  return out.join('\n');
}

export async function fetchClubSummary() {
  const res = await fetch(PUBLIC_URL, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`dashboard HTTP ${res.status}`);
  const data = extractJson(await res.text());
  const meta = data.meta || {};
  const latest = meta.latest_quarter;
  const stocks = new Set();
  const holders = {};
  for (const h of data.quarters?.[latest]?.holdings || []) {
    stocks.add(h.stock);
    if ((h.current_value_eur || 0) > 0) (holders[h.stock] ||= []).push(h.member);
  }
  return { summary: buildSummary(data), stocks: [...stocks], holders };
}

// The whole public dashboard data (what anyone can see on the site). Used for the aap's verdict
// after a meeting: only quarters that are already revealed publicly are in here.
export async function fetchDashboardData() {
  const res = await fetch(`${PUBLIC_URL}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`dashboard HTTP ${res.status}`);
  return extractJson(await res.text());
}
