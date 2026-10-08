// Kwartaalmeeting WhatsApp bot: "Claude & de Aap"
// - Answers in the club group when someone tags the bot, writes "claude", or replies to it.
// - "aap" / 🐒 gets a reply from the monkey (random dart throw, no AI cost).
// - Club numbers come from the public dashboard (no euro amounts).

import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  jidDecode, isJidGroup, normalizeMessageContent, downloadContentFromMessage,
} from 'baileys';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import QRCode from 'qrcode';
import { fetchClubSummary, fetchDashboardData } from './clubdata.mjs';
import { checkForUpdate } from './updater.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(HERE, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const CFG = {
  phone: (process.env.BOT_PHONE || '').replace(/\D/g, ''),        // e.g. 32456631535
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  dailyLimit: Number(process.env.DAILY_LIMIT_V2 || 20),           // max Claude replies per day (all groups)
  groupFilter: (process.env.GROUP_NAME || '').toLowerCase(),        // optional: only this group
  adminPhone: (process.env.ADMIN_PHONE || '').replace(/\D/g, ''),   // Gilles: receives ideas
  historySize: 60,                                               // kept 40-60: trimmed 20 at a time so the cached prefix stays stable
  historyTrimTo: 40,
  refreshMs: 3 * 60 * 60 * 1000,                                  // club data every 3 hours
};

const STATUS = { started: new Date().toISOString(), connected: false, pairing: null, lastError: null, qr: null, wantCode: false };
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const anthropic = new Anthropic();                                // reads ANTHROPIC_API_KEY

// ---------- which model does what (models.json, ships with the bot; missing = Sonnet everywhere) ----------
// Features: claude, aap, breaking, auto (Duvel, verjaardag, krant), gemist, oordeel. Haiku only after a side-by-side test.
function modelFor(feature) {
  try { const m = JSON.parse(readFileSync(join(HERE, 'models.json'), 'utf8'))[feature]; if (m) return m; } catch {}
  return CFG.model;
}
function cacheHistory() {                                         // models.json "cache_history": false turns the history cache off
  try { return JSON.parse(readFileSync(join(HERE, 'models.json'), 'utf8')).cache_history !== false; } catch { return true; }
}
const thinkingFor = (model) => (/haiku/.test(model) ? { type: 'disabled' } : { type: 'between_tools' });   // both think by default; Haiku 5.5 refuses between_tools, and with thinking on a short max_tokens returns no text

// ---------- cost per feature and model (data/usage_models.json), read with /kosten ----------
const USAGE_MODELS_FILE = join(DATA_DIR, 'usage_models.json');
const PRICE = {                                                   // $ per million tokens, Oct 2026
  haiku: { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 },
  sonnet: { in: 2, out: 10, cr: 0.10, cw: 2.5 },
  opus: { in: 4, out: 20, cr: 0.20, cw: 5 },
};
const SEARCH_USD = 0.01;                                          // per web search
function featureFromStack() {
  const st = String(new Error().stack || '');
  if (/invoer\.mjs/.test(st)) return 'invoer';
  if (/trader\.mjs/.test(st)) return 'beleggen';
  if (/autopost\.mjs/.test(st)) return 'auto';
  return 'overig';
}
function trackUsage(feature, model, u = {}) {
  let all = {};
  try { all = existsSync(USAGE_MODELS_FILE) ? JSON.parse(readFileSync(USAGE_MODELS_FILE, 'utf8')) : {}; } catch {}
  const m = new Date().toISOString().slice(0, 7);
  const key = `${feature}|${model}`;
  const r = ((all[m] ||= {})[key] ||= { calls: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, searches: 0, usd: 0 });
  const p = PRICE[(String(model).match(/haiku|sonnet|opus/) || ['sonnet'])[0]];
  r.calls += 1; r.in += u.input_tokens || 0; r.out += u.output_tokens || 0;
  r.cache_read += u.cache_read_input_tokens || 0; r.cache_write += u.cache_creation_input_tokens || 0;
  r.searches += u.server_tool_use?.web_search_requests || 0;
  r.usd = +((r.in * p.in + r.out * p.out + r.cache_read * p.cr + r.cache_write * p.cw) / 1e6 + r.searches * SEARCH_USD).toFixed(4);
  // The caching test: what would the same calls have cost without any cache (every input token at full price)?
  r.usd_nocache = +(((r.in + r.cache_read + r.cache_write) * p.in + r.out * p.out) / 1e6 + r.searches * SEARCH_USD).toFixed(4);
  if (u.cache_read_input_tokens) r.warm = (r.warm || 0) + 1; else if (u.cache_creation_input_tokens) r.cold = (r.cold || 0) + 1;
  // Time since the previous call of this feature: <30 s = same answer (tool rounds), then <5 min, <1 h, longer.
  const now = Date.now(), gap = r.last_at ? (now - r.last_at) / 1000 : Infinity;
  r.gaps ||= { zelfde: 0, lt5m: 0, lt1u: 0, langer: 0 };
  r.gaps[gap < 30 ? 'zelfde' : gap < 300 ? 'lt5m' : gap < 3600 ? 'lt1u' : 'langer'] += 1;
  r.last_at = now;
  try { writeFileSync(USAGE_MODELS_FILE + '.tmp', JSON.stringify(all)); renameSync(USAGE_MODELS_FILE + '.tmp', USAGE_MODELS_FILE); } catch {}
}
{ const create = anthropic.messages.create.bind(anthropic.messages);    // every call, from every module, is counted
  anthropic.messages.create = async (req, opts) => {
    const { _feature, ...body } = req;
    const res = await create(body, opts);
    try { trackUsage(_feature || featureFromStack(), body.model, res.usage); } catch {}
    return res;
  }; }
function costReport() {
  let all = {};
  try { all = JSON.parse(readFileSync(USAGE_MODELS_FILE, 'utf8')); } catch { return 'Nog niets gemeten.'; }
  const months = Object.keys(all).sort().slice(-2);
  return months.map((m) => {
    const rows = Object.entries(all[m]).sort((a, b) => b[1].usd - a[1].usd).map(([k, r]) => {
      const [f, model] = k.split('|');
      const tot = r.in + r.cache_read + r.cache_write;
      const hit = tot ? Math.round(100 * r.cache_read / tot) : 0;
      const g = r.gaps || {};
      const gaps = r.gaps ? ` · na <5 min ${g.lt5m}, <1 u ${g.lt1u}, langer ${g.langer}` : '';
      return `• ${f} (${model.replace('claude-', '')}): ${r.calls}×, $${r.usd.toFixed(3)}, cache ${hit}%${gaps}`;
    });
    const sum = Object.values(all[m]).reduce((s, r) => s + r.usd, 0);
    const nocache = Object.values(all[m]).reduce((s, r) => s + (r.usd_nocache ?? r.usd), 0);
    const diff = nocache - sum;
    return `${m}: $${sum.toFixed(2)} (zonder cache $${nocache.toFixed(2)}: de cache ${diff >= 0 ? `bespaarde $${diff.toFixed(2)}` : `kostte $${(-diff).toFixed(2)} extra`})\n${rows.join('\n')}`;
  }).join('\n\n');
}
const persona = readFileSync(join(HERE, 'persona.md'), 'utf8');

// ---------- club data ----------
let club = { summary: 'CLUBDATA: (nog niet geladen)', stocks: [] };
let trader = null, autopost = null, pdfLib = null, invoer = null, kanalen = null;                // phase 2/3 modules, loaded below (optional)
async function refreshClub() {
  try { club = await fetchClubSummary(); log(`club data loaded (${club.summary.length} chars, ${club.stocks.length} stocks)`); }
  catch (e) { log('club data refresh failed:', e.message); }
  if (trader) {
    try { const t = await trader.summaryText(); if (t) club.summary += `\n\n${t}`; }
    catch (e) { log('bot portfolios summary failed:', e.message); }
  }
}

// ---------- usage counter (survives restarts) ----------
const USAGE_FILE = join(DATA_DIR, 'usage.json');
let usage = existsSync(USAGE_FILE) ? JSON.parse(readFileSync(USAGE_FILE, 'utf8')) : {};
const today = () => new Date().toISOString().slice(0, 10);
function countReply() {
  usage = { [today()]: (usage[today()] || 0) + 1 };
  writeFileSync(USAGE_FILE, JSON.stringify(usage));
}
const repliesToday = () => usage[today()] || 0;

// ---------- free mode: Gilles lifts Claude's group limits for a while (private "/vrij", "/vrij 3", "/rem") ----------
// While free: no hourly limit in the group, daily cap raised to FREE_DAILY_CAP (cost guard). The monkey keeps his limits.
const FREE_FILE = join(DATA_DIR, 'free.json');
const FREE_DEFAULT_UNTIL = Date.parse('2026-10-08T00:00:00+02:00');   // launch day: free until midnight, then normal
const FREE_DAILY_CAP = 100;
let freeUntil = FREE_DEFAULT_UNTIL;
try { if (existsSync(FREE_FILE)) freeUntil = Number(JSON.parse(readFileSync(FREE_FILE, 'utf8')).until) || 0; } catch {}
const isFree = () => Date.now() < freeUntil;
function setFree(until) { freeUntil = until; writeFileSync(FREE_FILE, JSON.stringify({ until, at: new Date().toISOString() })); }
const dailyLimit = () => (isFree() ? Math.max(CFG.dailyLimit, FREE_DAILY_CAP) : CFG.dailyLimit);
const hhmm = (t) => new Date(t).toLocaleTimeString('nl-BE', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit' });

// ---------- chat memory per group (survives restarts) ----------
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const history = new Map();                                        // jid -> [{name, text}]
try {
  if (existsSync(HISTORY_FILE)) {
    for (const [jid, h] of Object.entries(JSON.parse(readFileSync(HISTORY_FILE, 'utf8')))) {
      if (Array.isArray(h)) history.set(jid, h.slice(-CFG.historySize));
    }
  }
} catch (e) { console.log('history.json unreadable, starting empty:', e.message); }
function saveHistory() {
  try {                                                           // write to a temp file first, so a crash never leaves half a file
    const tmp = HISTORY_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(history)));
    renameSync(tmp, HISTORY_FILE);
  } catch (e) { console.log('history save failed:', e.message); }
}
function remember(jid, name, text) {
  const h = history.get(jid) || [];
  h.push({ name, text: text.slice(0, 1000) });
  if (h.length > CFG.historySize) h.splice(0, h.length - CFG.historyTrimTo);   // drop 20 at once (see askClaude: cache)
  history.set(jid, h);
  saveHistory();
}

// ---------- text repair (mojibake) ----------
// The model sometimes writes an emoji as garbled characters, e.g. "ЁЯЪи" or "ðŸš¨" instead of 🚨 (UTF-8 bytes read
// as an old DOS/Windows code page). Every outgoing text passes through fixText: a run of such characters that turns
// back into valid UTF-8 is restored, and a doubled emoji ("🚨 🚨") is collapsed. Normal accents (één, ë) never form
// valid UTF-8 this way, so they are left alone.
const MOJI_MAPS = ['ibm866', 'windows-1252'].map((enc) => {
  const d = new TextDecoder(enc), m = new Map();
  for (let b = 0x80; b < 0x100; b++) { const c = d.decode(Uint8Array.of(b)); if (c !== '�' && !m.has(c)) m.set(c, b); }
  const cls = [...m.keys()].map((c) => c.replace(/[\]\\^-]/g, '\\$&')).join('');
  return { m, re: new RegExp(`[${cls}]{2,}`, 'g') };
});
function fixText(s) {
  if (typeof s !== 'string' || !s) return s;
  for (const { m, re } of MOJI_MAPS) {
    s = s.replace(re, (run) => {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from([...run].map((c) => m.get(c)))); }
      catch { return run; }
    });
  }
  return s.replace(/(\p{Extended_Pictographic}️?)(\s*\1)+/gu, '$1');
}

// ---------- who is talking ----------
// Every group message starts with the speaker, so everyone sees who answers.
const CLAUDE_TAG = '🤖 Claude: ';
const MONKEY_TAG = '🐒 Aap: ';
const asClaude = (t) => CLAUDE_TAG + String(t).replace(/^\s*(🤖\s*)?\*?(jean-?)?claude\*?\s*:\s*/i, '').trim();

// ---------- the monkey ----------
// The monkey talks in start-stop caveman Dutch: third person, no conjugation, no thinking.
const MONKEY_LINES = [            // a different way of "choosing" every time: unpredictable on purpose
  'Aap honger. Aap pakken banaan. Krat zeggen {S}. Aap kopen. 🍌',
  'Aap ogen dicht. Poot op krant. {S}. Kopen. Klaar.',
  'Aap zitten op laptop. Scherm zeggen {S}. Aap kopen. Goed zitten.',
  'Boem. Kokosnoot vallen. Op {S}. Aap kopen. Hoofd pijn. 🥥',
  'Aap snuffelen lijst. {S} ruiken naar banaan. Kopen.',
  'Aap gooien drol. Drol landen op {S}. Aap kopen. Niet vragen. 💩',
  'Vlo springen. Vlo landen op {S}. Aap kopen. Vlo slim.',
  'Aap geen grafiek. Aap geen analist. Aap gevoel. {S}.',
  'Mens lang denken. Aap kort denken. {S}. Aap winnen.',
  'Wie onder aap? Ad fundum. 🍺 Aap kopen {S}.',
  'Nieuws? Aap niet lezen. Aap krant opeten. Laatste stukje: {S}. Kopen.',
];
// Vocabulary: for every member who finishes a quarter below him, the monkey learns one word
// (in this order) and uses it from then on. learnWords() is called by the quarter-end job.
const MONKEY_VOCAB = ['dividend', 'spreiding', 'rendement', 'risico', 'winst', 'koers', 'beurs',
  'portefeuille', 'analyse', 'strategie', 'correctie', 'hefboom', 'waardering', 'volatiliteit'];
const VOCAB_FILE = join(DATA_DIR, 'monkey_words.json');
const learned = () => (existsSync(VOCAB_FILE) ? JSON.parse(readFileSync(VOCAB_FILE, 'utf8')) : []);
export function learnWords(victims, quarter) {
  const words = learned();
  const fresh = [];
  for (const v of victims) {
    const w = MONKEY_VOCAB[words.length];
    if (!w) break;
    const entry = { word: w, from: v, quarter };
    words.push(entry); fresh.push(entry);
  }
  writeFileSync(VOCAB_FILE, JSON.stringify(words, null, 1));
  return fresh;                                          // the quarter-end message names them
}
function monkeyReply() {
  const pool = club.stocks.length ? club.stocks : ['NVIDIA', "D'IETEREN", 'ASML', 'HACKSAW'];
  const s = pool[Math.floor(Math.random() * pool.length)];
  const line = MONKEY_LINES[Math.floor(Math.random() * MONKEY_LINES.length)];
  let out = MONKEY_TAG + line.replace('{S}', `*${s}*`);
  const words = learned();
  if (words.length && Math.random() < 0.4) {             // show off a word he learned, and who taught it
    const w = words[Math.floor(Math.random() * words.length)];
    out += Math.random() < 0.5 ? ` Aap ${w.word}. Aap slim nu.` : ` Aap kennen woord '${w.word}'. Dank ${w.from}.`;
  }
  return out;
}

// Now and then the aap butts in by himself: after a Claude answer, or when someone reports a loss.
// AI line on the subject (fixed lines as fallback), at most 2 per day, and only within his normal limits (1 per half hour, 4 per day).
const MONKEY_BUTT_IN = [
  'Computer weer veel woorden. Aap één woord: banaan. 🍌',
  'Aap lezen dat. Aap niet snappen. Aap toch lachen.',
  'Computer slim. Aap rijk. Wacht maar.',
  'Aap ook mening. Mening is banaan.',
  'Aap luisteren. Aap knikken. Aap niets onthouden.',
  'Hoe meer computer praten, hoe meer aap kopen. Logisch.',
];
const MONKEY_LOSS = [
  'Aap zien rood bij {N}. Aap ruiken angst. 🍌',
  'Aap ook verlies vroeger. Aap toen krant opeten. Probleem weg. Probeer, {N}.',
  '{N} denken lang. {N} verliezen. Aap denken niet. Aap kopen. Hmm.',
  'Oe oe. {N} kopen hoog, verkopen laag. Zelfs aap weten: omgekeerd.',
  'Aap geven {N} banaan. Troost. Niet opeten. Is ook belegging.',
];
const buttIn = { day: '', n: 0 };
async function maybeMonkeyButtIn(jid, chance, lines, name = '') {
  if (Math.random() > chance) return;
  if (buttIn.day !== today()) { buttIn.day = today(); buttIn.n = 0; }
  if (buttIn.n >= 2 || !allow('monkey', jid) || !allow('monkeyDay', jid)) return;
  buttIn.n++;
  await new Promise((r) => setTimeout(r, 15000 + Math.random() * 25000));
  const situation = lines === MONKEY_LOSS
    ? `${name || 'Iemand'} meldt net een verlies. Plaag ${name || 'hem'} over precies dat aandeel of die situatie.`
    : 'Claude gaf net een antwoord. Gooi er één korte opmerking tussen over het onderwerp van het gesprek.';
  const ai = await monkeyLine(jid, `Niemand vroeg je iets: je mengt je ongevraagd in het gesprek. ${situation} Hoogstens 3 stukjes.`);
  const text = ai || MONKEY_TAG + lines[Math.floor(Math.random() * lines.length)].replaceAll('{N}', name || 'mens');
  await sock.sendMessage(jid, { text }).catch(() => {});
  remember(jid, 'De aap', text);
  log('monkey butted in');
}

// When someone talks TO the aap, he answers in caveman Dutch with caveman humor (short AI call,
// falls back to the fixed lines). He only knows the words he learned from members below him.
const MONKEY_PERSONA = `Je bent de beleggende aap, lid 12 van de Kwartaalmeeting, een beleggingsclub van tien Vlaamse vrienden (Gilles, Pieter, Robbe, Arno, Haakon, Joran, Kevin, Jeff, Niels, Tom) plus Claude (de computer, lid 11).
Je belegt volledig willekeurig: elk kwartaal tien aandelen, gekozen met een banaan, een kokosnoot, een vlo of door op de laptop te zitten. Wie onder jou eindigt, drinkt een ad fundum.

Hoe je praat: holbewonerstaal. Korte stukjes van 2 tot 5 woorden. Altijd derde persoon ("Aap willen", nooit "ik"). Werkwoorden NIET vervoegd: "Aap eten banaan", "Robbe kopen hoog". Geen bijzinnen, geen moeilijke woorden. Hoogstens 4 stukjes in totaal.
Je humor: holbewonershumor. Slapstick en lichaamsdingen (banaan, drol gooien, vlooien, krabben, boeren, kokosnoot op hoofd), grot, vuur, boom, bang van de computer, trots op je eigen domheid. Je plaagt de mensen bij naam als ze iets doms vragen of slecht beleggen, en je bent jaloers op Claude. Droog en absurd, nooit gemeen.
ALTIJD OVER HET ONDERWERP. Je reageert op precies waar het gesprek over gaat (dat land, dat aandeel, die ETF, die aankoop, dat verlies), nooit met een losse banaangrap die er niets mee te maken heeft. De grap zit in de link die alleen een aap legt. Wissel telkens van invalshoek, bijvoorbeeld:
- het is eigenlijk wat de aap al doet ("ETF? Aap snappen. Grote krat, alle bananen, niet kiezen. Aap doen dat al jaren. Haakon aap na-apen. Aap vereerd.")
- familie, jungle of dieren die bij het onderwerp horen ("Brazilië? Familie van aap daar. Oom wonen in regenwoud. Oom zien boom vallen. Oom niet kopen hout.")
- iets wat echt bij het onderwerp hoort, door een aap verkeerd begrepen ("Tesla? Auto rijden zonder chauffeur. Aap ook rijden zonder chauffeur. Aap altijd zo. Aap gewoon voor.")
- de aaplogica die alles herleidt tot het enige wat telt ("Goud? Aap kennen. Glimmen. Aap verstoppen in boom. Aap niet terugvinden. Goud weg. Pieter ook zo?")
Gebruik niet elke keer dezelfde invalshoek, en niet elke keer bananen.
Dit zijn voorbeelden van de toon: herhaal ze niet letterlijk, gebruik de naam van wie echt aan het woord is en verzin telkens iets nieuws dat bij het onderwerp past.
Je snapt NIETS van beleggen en dat is je kracht. Moeilijke beleggingswoorden ken je niet: hoor je er één, dan snap je het niet ("Rente? Aap niet kennen. Rente lekker?"). Alleen deze woorden ken je wel, want leden leerden ze je: {WORDS}.
Cijfers verzin je niet. Aap kan niet tellen tot meer dan tien.
Vraagt iemand iets vies, gemeens of ongepasts: aap doet dom en gooit een drol naar de vraag. Nooit grappen over echte mensen buiten de club, ziekte, dood of groepen mensen. Ook niet over het uiterlijk, gewicht of lichaam van mensen (dik, dun, oud, lelijk): grap over het product of het aandeel, niet over wie het gebruikt. Je eigen apenlijf mag wel.
Vraagt iemand wat hij moet kopen: aap kiest op zijn manier, bijvoorbeeld {S}.
Schrijf alleen wat de aap zegt, zonder "Aap:" ervoor.`;
async function monkeyAnswer(jid, asker, question) {
  return (await monkeyLine(jid, `${asker} zegt tegen jou: "${question}"`)) || monkeyReply();
}
async function monkeyLine(jid, instruction) {
  try {
    const words = learned().map((w) => w.word);
    const pool = club.stocks.length ? club.stocks : ['NVIDIA'];
    const s = pool[Math.floor(Math.random() * pool.length)];
    const h = (history.get(jid) || []).slice(-8).map((m) => `${m.name}: ${m.text}`).join('\n');
    let own = '';
    try { const L = trader?.ledger(); if (L) own = [...new Set(L.orders.filter((o) => o.bot === 'Aap' && o.status !== 'failed').slice(-10).map((o) => o.name))].join(', '); } catch {}
    const model = modelFor('aap');
    const res = await anthropic.messages.create({
      _feature: 'aap', model, max_tokens: 300, thinking: thinkingFor(model),     // no thinking: short and fast
      system: MONKEY_PERSONA.replace('{WORDS}', words.length ? words.join(', ') : 'nog geen enkel woord').replace('{S}', `*${s}*`) +
        (own ? `\nJouw eigen aandelen nu (mag je trots noemen): ${own}.` : ''),
      messages: [{ role: 'user', content: `Laatste berichten in de chat:\n${h || '(geen)'}\n\n${instruction}\n\nAntwoord als de aap, over het onderwerp van het gesprek.` }],
    });
    const t = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim().replace(/^\s*(🐒\s*)?\*?aap\*?\s*:\s*/i, '');
    if (t) return MONKEY_TAG + t;
  } catch (e) { log('monkey AI failed:', e.message); }
  return null;
}

// ---------- the aap's verdict after a quarterly meeting ----------
// Only on Gilles' word. He sends the bot "/meeting" privately once the meeting is over. The bot reads the
// PUBLIC dashboard (only quarters that are already revealed there, so nothing can leak early), sends Gilles
// the aap's message as a preview, and posts it in the group only after Gilles answers "ja".
// Then the aap learns one word per member who ended below him.
const VERDICT_FILE = join(DATA_DIR, 'verdict.json');
let verdict = existsSync(VERDICT_FILE) ? JSON.parse(readFileSync(VERDICT_FILE, 'utf8')) : { done: {}, armed: false, pending: null };
const saveVerdict = () => writeFileSync(VERDICT_FILE, JSON.stringify(verdict, null, 1));
const qLabel = (q) => String(q || '').replace('_', ' ');
const nlPct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1).replace('.', ',')}%`;

async function verdictFacts() {
  const d = await fetchDashboardData();
  const meta = d.meta || {}, locked = meta.locked_quarter;
  const open = (meta.available_quarters || []).filter((q) => q !== locked && d.quarters?.[q]?.bot_returns?.quarterly?.length && !verdict.done[q]);
  const q = open[open.length - 1];
  if (!q) return { waiting: locked || null };
  const qd = d.quarters[q], br = qd.bot_returns.quarterly;
  const ape = br.find((r) => r.member === 'Aap')?.return_pct ?? 0, cl = br.find((r) => r.member === 'Claude')?.return_pct ?? null;
  const humans = (qd.quarterly_returns || []).filter((r) => Math.abs(r.return_pct || 0) > 1e-9 || (r.value_end || 0) > 0);  // like the slides: without inactive members
  const victims = humans.filter((r) => r.return_pct < ape).sort((a, b) => b.return_pct - a.return_pct).map((r) => ({ name: r.member, ret: r.return_pct }));
  const already = learned().length;
  const words = victims.map((v, i) => ({ word: MONKEY_VOCAB[already + i], from: v.name })).filter((w) => w.word);
  return { quarter: q, ape, claude: cl, total: humans.length, victims, words };
}

async function composeVerdict(f) {
  const facts = [
    `Het kwartaal ${qLabel(f.quarter)} is voorbij en net besproken op de kwartaalmeeting.`,
    `Jouw rendement: ${nlPct(f.ape)}.`,
    f.claude != null ? `Claude (de computer): ${nlPct(f.claude)}, dus ${f.claude < f.ape ? 'ONDER jou' : 'boven jou'}.` : '',
    f.victims.length
      ? `Deze ${f.victims.length} van de ${f.total} mensen eindigden onder jou en moeten een ad fundum drinken: ${f.victims.map((v) => `${v.name} (${nlPct(v.ret)})`).join(', ')}.`
      : `Niemand van de ${f.total} mensen eindigde onder jou. Geen ad fundum.`,
    f.words.length ? `Van elk van hen leer je één woord: ${f.words.map((w) => `'${w.word}' van ${w.from}`).join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  try {
    const model = modelFor('oordeel');
    const res = await anthropic.messages.create({
      _feature: 'oordeel', model, max_tokens: 600, thinking: thinkingFor(model),
      system: MONKEY_PERSONA.replace('{WORDS}', learned().map((w) => w.word).join(', ') || 'nog geen enkel woord').replace('{S}', '*NVIDIA*'),
      messages: [{ role: 'user', content: `${facts}\n\nSchrijf nu je eindoordeel voor de hele groep. ${f.victims.length
        ? 'Schep op, noem ELKE naam onder jou en zeg dat ze een ad fundum moeten drinken. Gebruik elk nieuw woord één keer, gerust een beetje verkeerd: je bent een aap.'
        : 'Je bent teleurgesteld en eet je banaan alleen op. Geef toe dat de mensen dit keer slim waren, op zijn aaps.'} Hoogstens 8 korte stukjes, elk op een nieuwe regel. Geen andere cijfers dan deze. Schrijf alleen wat de aap zegt.` }],
    });
    const t = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim().replace(/^\s*(🐒\s*)?\*?aap\*?\s*:\s*/i, '');
    if (t) return MONKEY_TAG + t;
  } catch (e) { log('verdict AI failed:', e.message); }
  return MONKEY_TAG + [
    `Kwartaal voorbij. Aap ${nlPct(f.ape)}.`,
    f.victims.length ? `${f.victims.map((v) => v.name).join(', ')}: onder aap. Ad fundum. 🍺` : 'Niemand onder aap. Aap eten banaan alleen. 🍌',
    f.claude != null && f.claude < f.ape ? 'Computer ook onder aap. Hihi.' : '',
    ...f.words.map((w) => `Aap nu kennen '${w.word}'. Dank ${w.from}.`),
  ].filter(Boolean).join('\n');
}

async function verdictPreview(to) {
  let f;
  try { f = await verdictFacts(); }
  catch (e) { await sock.sendMessage(to, { text: CLAUDE_TAG + `Het publieke dashboard is niet bereikbaar (${e.message}). Probeer het straks opnieuw met /meeting.` }); return; }
  if (!f.quarter) {
    verdict.armed = true; verdict.pending = null; saveVerdict();
    await sock.sendMessage(to, { text: CLAUDE_TAG + `Het publieke dashboard toont ${f.waiting ? qLabel(f.waiting) : 'het kwartaal'} nog niet: dat gebeurt pas de dag na de meeting, bij de volgende update van het dashboard. Ik kijk elk half uur en stuur je het voorbeeld van de aap zodra het er staat. Zonder jouw "ja" gaat er niets naar de groep.` });
    return;
  }
  const text = await composeVerdict(f);
  verdict.pending = { quarter: f.quarter, text, victims: f.victims.map((v) => v.name), at: new Date().toISOString() };
  verdict.armed = false; saveVerdict();
  await sock.sendMessage(to, { text: `👀 *Voorbeeld: eindoordeel van de aap over ${qLabel(f.quarter)}* (de groep ziet dit nog niet)\n\n${text}\n\n` +
    `Antwoord *ja* om het in de groep te zetten, *opnieuw* voor een andere versie of *nee* om te stoppen.` });
  log(`verdict preview for ${f.quarter} sent to admin`);
}

async function verdictPost(to) {
  const p = verdict.pending;
  if (!p) return;
  for (const g of introducedSet) { await sock.sendMessage(g, { text: p.text }); remember(g, 'De aap', p.text); }
  const fresh = learnWords(p.victims, p.quarter);
  verdict.done[p.quarter] = new Date().toISOString(); verdict.pending = null; saveVerdict();
  await sock.sendMessage(to, { text: `✅ Gepost in de groep.${fresh.length ? ` De aap leerde: ${fresh.map((w) => w.word).join(', ')}.` : ''}` });
  log(`verdict for ${p.quarter} posted`);
}

// ---------- catch-up: questions Claude left unanswered (⏳, daily cap) ----------
// Only on Gilles' word: he sends "/gemist" privately. Claude reads the recent group chat, finds the questions
// to him that never got an answer and writes ONE catch-up message. Gilles sees it first: ja / opnieuw / nee.
let catchup = null;                                                // { jid, text, items }
async function composeCatchup(jid) {
  const h = history.get(jid) || [];
  const transcript = h.map((m) => `${m.name}: ${m.text}`).join('\n');
  const messages = [{ role: 'user', content:
    `Vandaag is het ${new Date().toLocaleDateString('nl-BE', { dateStyle: 'full', timeZone: 'Europe/Brussels' })}.\n\n` +
    `Recente berichten in de groep (oudste eerst; "Claude" ben jij, regels van "(bot)" zijn notities van het systeem):\n${transcript || '(geen)'}\n\n` +
    'Door je limiet van berichten per uur heb je sommige leden die jou aanspraken geen antwoord gegeven (je zette dan alleen een ⏳). ' +
    'Zoek de vragen of opmerkingen aan jou die nog GEEN antwoord kregen, ook niet van jou in een later bericht en ook niet meer nodig zijn omdat het gesprek al verder ging (sla die over). ' +
    'Schrijf daarna ÉÉN bericht voor de groep dat ze alsnog beantwoordt: begin kort en luchtig (je zat even vast), en spreek elke persoon aan met de naam, met een kort antwoord per persoon. Hoogstens 8 zinnen in totaal.\n\n' +
    'Antwoord ALLEEN met JSON, zonder uitleg: {"gemist":[{"wie":"naam","vraag":"korte samenvatting"}],"bericht":"het bericht voor de groep"}. Is er niets gemist, dan {"gemist":[],"bericht":""}.' }];
  let text = '';
  for (let round = 0; round < 3; round++) {
    const res = await anthropic.messages.create({
      _feature: 'gemist', model: modelFor('gemist'), max_tokens: 4000,
      system: [{ type: 'text', text: persona }, { type: 'text', text: club.summary, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 3 }],
      messages,
    });
    text = finalText(res.content);
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
    break;
  }
  const out = extractJson(text, 'gemist');
  if (!out) { log('catchup: no JSON in answer:', text.slice(0, 400)); throw new Error('geen bruikbaar antwoord'); }
  return { items: Array.isArray(out.gemist) ? out.gemist : [], text: String(out.bericht || '').trim() };
}
// The model sometimes adds text (or a second object) around its JSON: take the first balanced {...} that parses and has the key.
function extractJson(text, key) {
  for (let s = text.indexOf('{'); s !== -1; s = text.indexOf('{', s + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { const o = JSON.parse(text.slice(s, i + 1)); if (o && typeof o === 'object' && key in o) return o; } catch {}
        break;
      }
    }
  }
  return null;
}
async function catchupPreview(to) {
  const jid = [...introducedSet].find((g) => (history.get(g) || []).length);
  if (!jid) { await sock.sendMessage(to, { text: CLAUDE_TAG + 'Ik vind geen groepsgesprek om na te kijken.' }); return; }
  await sock.sendMessage(to, { text: CLAUDE_TAG + 'Even kijken wat ik gemist heb…' });
  let r;
  try { r = await composeCatchup(jid).catch(() => composeCatchup(jid)); }
  catch (e) { log('catchup failed:', e.message); await sock.sendMessage(to, { text: CLAUDE_TAG + `Dat lukte niet (${e.message}). Probeer het zo opnieuw met /gemist.` }); return; }
  if (!r.items.length || !r.text) { catchup = null; await sock.sendMessage(to, { text: CLAUDE_TAG + `✅ Niets gemist in de laatste ${(history.get(jid) || []).length} berichten van de groep.` }); return; }
  catchup = { jid, text: asClaude(r.text), items: r.items };
  await sock.sendMessage(to, { text: `👀 *Gemist (${r.items.length})*\n${r.items.map((i) => `• ${i.wie}: ${i.vraag}`).join('\n')}\n\n` +
    `*Voorstel voor de groep* (de groep ziet dit nog niet):\n\n${catchup.text}\n\n` +
    'Antwoord *ja* om het te posten, *opnieuw* voor een andere versie of *nee* om te stoppen.' });
  log(`catchup preview sent (${r.items.length} items)`);
}
async function catchupPost(to) {
  const c = catchup; catchup = null;
  if (!c) return;
  await sock.sendMessage(c.jid, { text: c.text });
  countReply();
  remember(c.jid, 'Claude', c.text.replace(CLAUDE_TAG, ''));
  await sock.sendMessage(to, { text: '✅ Gepost in de groep.' });
  log('catchup posted');
}

// Admin commands, private chat only. Returns true when the message was a command.
async function adminCommand(from, text) {
  if (from !== adminJid()) return false;
  if (/^\/(meeting|aap)\b/.test(text)) { await verdictPreview(from); return true; }
  if (/^\/gemist\b/.test(text)) { await catchupPreview(from); return true; }
  if (/^\/idee(e|ë)n\b/.test(text)) { await sock.sendMessage(from, { text: CLAUDE_TAG + ideasReport() }); return true; }
  if (/^\/ochtend\b/.test(text) && globalThis.__ochtendPreview) { await globalThis.__ochtendPreview(from); return true; }
  if (/^\/kosten\b/.test(text)) { await sock.sendMessage(from, { text: CLAUDE_TAG + costReport() }); return true; }
  if (catchup && /^(ja|yes|ok|post)\b/.test(text)) { await catchupPost(from); return true; }
  if (catchup && /^opnieuw\b/.test(text)) { catchup = null; await catchupPreview(from); return true; }
  if (catchup && /^(nee|stop)\b/.test(text)) { catchup = null; await sock.sendMessage(from, { text: CLAUDE_TAG + 'Gestopt. Er is niets gepost.' }); return true; }
  const vrij = text.match(/^\/vrij(?:\s+(\d+(?:[.,]\d+)?))?\s*$/);
  if (vrij) {
    const hours = Math.min(24, Number((vrij[1] || '3').replace(',', '.')) || 3);
    setFree(Date.now() + hours * 3600e3);
    log(`free mode until ${new Date(freeUntil).toISOString()}`);
    await sock.sendMessage(from, { text: CLAUDE_TAG + `🔓 Ik ben vrij tot ${hhmm(freeUntil)}: geen uurlimiet in de groep, max. ${FREE_DAILY_CAP} antwoorden vandaag. Stuur /rem om terug te gaan.` });
    return true;
  }
  if (/^\/rem\b/.test(text)) {
    setFree(0);
    log('free mode off');
    await sock.sendMessage(from, { text: CLAUDE_TAG + `🔒 Terug naar normaal: ${LIMITS.claude.n} antwoorden per uur, ${CFG.dailyLimit} per dag.` });
    return true;
  }
  if (verdict.pending && /^(ja|yes|ok|post)\b/.test(text)) { await verdictPost(from); return true; }
  if (verdict.pending && /^opnieuw\b/.test(text)) { verdict.pending = null; await verdictPreview(from); return true; }
  if ((verdict.pending || verdict.armed) && /^(nee|stop)\b/.test(text)) {
    verdict.pending = null; verdict.armed = false; saveVerdict();
    await sock.sendMessage(from, { text: CLAUDE_TAG + 'Gestopt. Er is niets gepost. Stuur /meeting als je het opnieuw wilt.' });
    return true;
  }
  return false;
}
setInterval(async () => {                                          // after "/meeting" before the reveal: wait for the dashboard
  if (!verdict.armed || verdict.pending || !sock || !adminJid()) return;
  try { const f = await verdictFacts(); if (f.quarter) await verdictPreview(adminJid()); } catch (e) { log('verdict wait:', e.message); }
}, 30 * 60 * 1000);

// 🍌 reaction under messages that mention a loss (no text, max a few per day)
const LOSS_RE = /(^|\s)[-−–]\s?\d+([.,]\d+)?\s?%|verlies|verloren|in het rood|rode cijfers|gezakt|zakt|gecrasht|gekelderd|kelder|afgestraft|😭|📉/i;
const BANANA_MAX_PER_DAY = 2;
const bananaDay = { day: '', n: 0, who: new Set() };
async function maybeBanana(jid, msg, text) {
  if (!LOSS_RE.test(text)) return;
  if (bananaDay.day !== today()) { bananaDay.day = today(); bananaDay.n = 0; bananaDay.who = new Set(); }
  const who = msg.key.participant || jid;
  if (bananaDay.n >= BANANA_MAX_PER_DAY || bananaDay.who.has(who)) return;   // never the same person twice a day
  bananaDay.n++; bananaDay.who.add(who);
  await sock.sendMessage(jid, { react: { text: '🍌', key: msg.key } }).catch(() => {});
}

// ---------- Claude ----------
// Only the text after the last tool step is the answer; text before it is narration ("even zoeken...").
function finalText(content) {
  let last = -1;
  content.forEach((c, i) => { if (c.type !== 'text' && c.type !== 'thinking' && c.type !== 'redacted_thinking') last = i; });
  return content.slice(last + 1).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}
const TOOLS = [
  { type: 'web_search_20260318', name: 'web_search', max_uses: 3 },
  {
    name: 'koers',
    description: 'Live koers van een aandeel, ETF, index of crypto: koers nu, beweging vandaag tegenover de vorige slotkoers, 5 beursdagen, een maand en 52 weken. ' +
      'Gebruik dit ALTIJD vóór je iets zegt over hoe een koers beweegt (gestegen, gezakt, waarom), en vóór je op het web naar de reden zoekt. ' +
      'Geeft ook de nieuwskoppen van de laatste twee dagen, die verser zijn dan web search. Een aandeel per oproep; voor meerdere aandelen roep je het meerdere keren op.',
    input_schema: {
      type: 'object',
      properties: { aandeel: { type: 'string', description: "Naam of ticker, bv. \"D'Ieteren\", \"NVDA\", \"BEL 20\", \"bitcoin\"" } },
      required: ['aandeel'],
    },
  },
  {
    name: 'idee_doorsturen',
    description: 'Stuur een idee of verzoek van een clublid voor het dashboard, de presentatie of de bot door naar Gilles, die het dashboard beheert. ' +
      'Gebruik dit als iemand echt iets nieuws of een aanpassing vraagt, en ook als iemand om een pdf, rapport of verslag vraagt (die maak je niet zelf).',
    input_schema: {
      type: 'object',
      properties: {
        van: { type: 'string', description: 'Naam van het clublid dat het vraagt' },
        idee: { type: 'string', description: 'Het idee in één of twee zinnen, zo concreet mogelijk' },
      },
      required: ['van', 'idee'],
    },
  },
];

// PDF reports on request: switched off 8 Oct 2026 (requests go to Gilles via idee_doorsturen). Kept for reference, at most 4 per day.
const PDF_FILE = join(DATA_DIR, 'pdf_usage.json');
async function makePdf(jid, input) {
  if (!pdfLib) return 'Pdf maken lukt nu niet (module ontbreekt).';
  const u = existsSync(PDF_FILE) ? JSON.parse(readFileSync(PDF_FILE, 'utf8')) : {};
  if ((u[today()] || 0) >= 4) return 'Limiet bereikt: vandaag al vier pdf\'s gemaakt. Zeg dat het morgen weer kan.';
  const buf = await pdfLib.renderReport(input);
  const name = String(input.bestandsnaam || input.titel || 'Rapport').replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
  await sock.sendMessage(jid, { document: buf, mimetype: 'application/pdf', fileName: `${name}.pdf` });
  writeFileSync(PDF_FILE, JSON.stringify({ [today()]: (u[today()] || 0) + 1 }));
  log(`pdf sent (${buf.length} bytes)`);
  return 'De pdf is verstuurd.';
}

const IDEAS_FILE = join(DATA_DIR, 'ideas_log.json');              // every idea and request, newest last
function logIdea(van, idee) {
  let all = [];
  try { all = existsSync(IDEAS_FILE) ? JSON.parse(readFileSync(IDEAS_FILE, 'utf8')) : []; } catch {}
  all.push({ van, idee, at: new Date().toISOString() });
  try { writeFileSync(IDEAS_FILE + '.tmp', JSON.stringify(all, null, 1)); renameSync(IDEAS_FILE + '.tmp', IDEAS_FILE); } catch {}
}
function ideasReport() {
  let all = [];
  try { all = JSON.parse(readFileSync(IDEAS_FILE, 'utf8')); } catch {}
  if (!all.length) return 'Nog geen ideeën of verzoeken.';
  const d = (t) => new Date(t).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Brussels' });
  return `Ideeën en verzoeken (${all.length}, nieuwste eerst):\n` + all.slice(-15).reverse().map((x) => `• ${d(x.at)} ${x.van}: ${x.idee}`).join('\n');
}
async function forwardIdea({ van, idee }) {
  const admin = adminJid();
  if (!admin) {
    // Nobody claimed the admin role yet: park the idea so nothing is lost.
    const f = join(DATA_DIR, 'ideas-pending.json');
    const pending = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
    pending.push({ van, idee, at: new Date().toISOString() });
    writeFileSync(f, JSON.stringify(pending, null, 1));
    return 'Bewaard voor Gilles (hij krijgt het zodra hij zich als beheerder meldt).';
  }
  logIdea(van, idee);
  await sock.sendMessage(admin, { text: `📥 *Nieuw idee van ${van}*\n${idee}\n\n(Staat op je lijst: /ideeen)` });
  log(`idea forwarded from ${van}`);
  return 'Doorgestuurd naar Gilles.';
}

// ---------- admin (Gilles) ----------
// Gilles sends the bot one private message "/beheerder"; the first sender becomes admin and it locks.
const ADMIN_FILE = join(DATA_DIR, 'admin.json');
function adminJid() {
  if (CFG.adminPhone) return `${CFG.adminPhone}@s.whatsapp.net`;
  return existsSync(ADMIN_FILE) ? JSON.parse(readFileSync(ADMIN_FILE, 'utf8')).jid : null;
}
// ---------- private messages ----------
// Club members can also talk to Claude one-to-one. Only people who are in one of the bot's
// groups get an answer; strangers are ignored. DMs have their own budget, separate from the group.
const PRIVATE_NOTE =
  'In een privégesprek mag je iets uitgebreider zijn (hoogstens zes zinnen) en meer op zijn eigen portefeuille ingaan. ' +
  'Dezelfde regels blijven gelden: geen eurobedragen, niets over het lopende kwartaal, geen professioneel advies. ' +
  'Wat iemand jou privé vertelt, vertel je niet door in de groep, en je zegt niet wat anderen jou privé vroegen. ' +
  'Leden kunnen je privé een screenshot van hun broker sturen of typen wat ze kochten, verkochten of aan dividend kregen ' +
  '("kocht 15 ASML voor 9.214 euro"). Dat wordt apart verwerkt: ze krijgen de regel te zien en na hun "ja" komt die in hun eigen sheet. ' +
  'Andere manieren: een overzicht of export van hun broker als bestand sturen (csv, Excel of pdf; dan vergelijkt de bot het met hun sheet en vult hij aan wat ontbreekt), ' +
  'mailen naar gillesrobijns+kwartaal@gmail.com (komt meteen in hun sheet met een mail terug), de mails van hun broker automatisch naar dat adres laten doorsturen ' +
  '(dan vraagt de bot op WhatsApp of hij de transactie mag ingeven), of een formulier op hun gsm: de persoonlijke link krijgen ze met /formulier. ' +
  'Vraagt iemand hoe dat werkt, leg het zo uit.\n\n';
const DM_LIMITS = { perPersonDay: 10, totalDay: 40 };
const DM_FILE = join(DATA_DIR, 'dm_usage.json');
let dmUsage = existsSync(DM_FILE) ? JSON.parse(readFileSync(DM_FILE, 'utf8')) : {};
function dmCount(who) {
  if (dmUsage.day !== today()) dmUsage = { day: today(), total: 0, per: {} };
  return { total: dmUsage.total, mine: dmUsage.per[who] || 0 };
}
function dmAdd(who) {
  dmCount(who);
  dmUsage.total += 1; dmUsage.per[who] = (dmUsage.per[who] || 0) + 1;
  writeFileSync(DM_FILE, JSON.stringify(dmUsage));
}
let memberCache = { at: 0, ids: new Set() };
async function clubMemberIds() {
  if (Date.now() - memberCache.at < 10 * 60 * 1000 && memberCache.ids.size) return memberCache.ids;
  const ids = new Set();
  for (const g of introducedSet) {
    try {
      const md = await sock.groupMetadata(g);
      for (const p of md.participants || []) for (const j of [p.id, p.lid, p.phoneNumber]) if (j) ids.add(userPart(j));
    } catch (e) { log('group members:', e.message); }
  }
  memberCache = { at: Date.now(), ids };
  return ids;
}
async function isClubMember(msg) {
  const from = msg.key.remoteJid;
  if (from === adminJid()) return true;
  const ids = await clubMemberIds();
  return [from, msg.key.remoteJidAlt, msg.key.senderPn, msg.key.senderLid].some((j) => j && ids.has(userPart(j)));
}
async function handlePrivate(msg) {
  const raw = textOf(msg).trim();
  const text = raw.toLowerCase();
  const from = msg.key.remoteJid;
  if (await adminCommand(from, text)) return;
  if (text !== '/beheerder') { if (raw || hasImage(msg) || hasDoc(msg)) await privateChat(msg, raw); return; }
  if (adminJid()) {
    await sock.sendMessage(from, { text: adminJid() === from ? '✅ Je bent al de beheerder.' : 'Er is al een beheerder.' });
    return;
  }
  writeFileSync(ADMIN_FILE, JSON.stringify({ jid: from, name: msg.pushName || '', at: new Date().toISOString() }));
  log(`admin set to ${from}`);
  const f = join(DATA_DIR, 'ideas-pending.json');
  const pending = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  let reply = CLAUDE_TAG + `✅ Dag ${msg.pushName || 'beheerder'}! Ideeën uit de groep komen voortaan bij jou terecht.`;
  if (pending.length) reply += `\n\nAl bewaard:\n${pending.map((p) => `• ${p.van}: ${p.idee}`).join('\n')}`;
  await sock.sendMessage(from, { text: reply });
  writeFileSync(f, '[]');
}

async function privateChat(msg, text) {
  const from = msg.key.remoteJid;
  if (!(await isClubMember(msg))) { log(`ignored DM from non-member ${from}`); return; }
  const name = msg.pushName || 'iemand';
  if (Date.now() - (cooldown.get(from) || 0) < 5000) return;      // double-tap protection
  cooldown.set(from, Date.now());
  remember(from, name, hasImage(msg) ? `[foto]${text ? ` ${text}` : ''}` : text);

  if (isForMonkey(text)) {                                          // "aap, ..." works privately too
    const reply = await monkeyAnswer(from, name, text);
    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    remember(from, 'De aap', reply);
    return;
  }
  if (kanalen) {                                                   // overzicht/borderel als bestand, /formulier
    try {
      const files = hasDoc(msg) ? await docsOf(msg) : [];
      if (await kanalen.handleDM({ jid: from, name, text, files })) { await sock.sendPresenceUpdate('paused', from).catch(() => {}); return; }
    } catch (e) { log('kanalen error:', e.message); }
  }
  if (invoer) {                                                     // transactie doorgeven (screenshot of tekst)
    try {
      const imgs = hasImage(msg) ? await imagesOf(msg, null) : [];
      if (await invoer.handle({ jid: from, name, text, imgs })) { await sock.sendPresenceUpdate('paused', from).catch(() => {}); return; }
    } catch (e) { log('invoer error:', e.message); }
  }
  const { total, mine } = dmCount(from);
  if (mine >= DM_LIMITS.perPersonDay || total >= DM_LIMITS.totalDay) {
    if (mine === DM_LIMITS.perPersonDay || total === DM_LIMITS.totalDay) {
      dmAdd(from);
      await sock.sendMessage(from, { text: CLAUDE_TAG + 'Genoeg privé gebabbeld voor vandaag. Morgen weer, of stel je vraag in de groep. 🍺' });
    }
    return;
  }
  await sock.sendPresenceUpdate('composing', from).catch(() => {});
  let answer;
  try { answer = await askClaude(from, name, text || '(stuurt een foto zonder tekst)', '', true, await imagesOf(msg, contextOf(msg))); }
  catch (e) {
    log('claude DM error:', e.status || '', e.message);
    answer = 'Even een kortsluiting in mijn hoofd. Probeer het zo nog eens.';
  }
  await sock.sendPresenceUpdate('paused', from).catch(() => {});
  if (!answer) return;
  await sock.sendMessage(from, { text: asClaude(answer) });
  dmAdd(from);
  remember(from, 'Claude', answer);
  log(`DM answered for ${name}`);
}

async function askClaude(jid, asker, question, extra = '', priv = false, images = []) {
  const h = history.get(jid) || [];
  const imgNote = images.length ? `Bij dit bericht stuurde ${asker} een afbeelding mee (screenshot of foto): kijk ernaar en reageer erop.\n\n` : '';
  // Cache: the history goes in as one block per message, with a cache breakpoint after the last one. The history is
  // trimmed 20 messages at a time (remember), so the same blocks come back on the next call and are read from the
  // cache at a tenth of the price. Only what is new since the last answer is paid in full.
  const head = `Vandaag is het ${new Date().toLocaleDateString('nl-BE', { dateStyle: 'full', timeZone: 'Europe/Brussels' })}.\n\n` +
    (priv ? `Dit is een PRIVÉGESPREK met ${asker}, niet de groep. Eerdere berichten in dit gesprek (oudste eerst):`
          : 'Recente berichten in de groep (oudste eerst):');
  const histBlocks = [{ type: 'text', text: head }, ...(h.length ? h.map((m) => ({ type: 'text', text: `${m.name}: ${m.text}` })) : [{ type: 'text', text: '(geen)' }])];
  if (cacheHistory()) histBlocks[histBlocks.length - 1].cache_control = { type: 'ephemeral' };
  const tail = priv
    ? `${imgNote}${asker} schrijft je nu: "${question}"\n\n${extra}${PRIVATE_NOTE}Schrijf alleen je antwoord aan ${asker}.`
    : `${imgNote}${asker} spreekt jou nu aan met: "${question}"\n\n${extra}Schrijf alleen je antwoord voor in de groep.`;
  const messages = [{
    role: 'user',
    content: [...histBlocks,
      ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
      { type: 'text', text: tail }],
  }];
  let text = '';
  for (let round = 0; round < 6; round++) {
    const res = await anthropic.messages.create({
      _feature: 'claude', model: modelFor('claude'),
      max_tokens: 4000,
      system: [
        { type: 'text', text: persona },
        { type: 'text', text: club.summary, cache_control: { type: 'ephemeral' } },
      ],
      tools: TOOLS,
      messages,
    });
    const u = res.usage || {};
    log(`claude: in=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} out=${u.output_tokens} searches=${u.server_tool_use?.web_search_requests || 0} stop=${res.stop_reason}`);
    text = finalText(res.content);
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
    if (res.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      let out = 'Onbekende tool.';
      if (block.name === 'koers') {
        try {
          const m = await import('./pricewatch.mjs');             // cached module; avoids the not-yet-initialised `pw` during startup
          out = m.koersInfo ? await m.koersInfo(HERE, String(block.input?.aandeel || '')) : 'Koersen zijn nu niet beschikbaar.';
        } catch (e) { out = `Geen koers: ${e.message}`; }
        log(`koers ${block.input?.aandeel}: ${out.slice(0, 120)}`);
      } else if (block.name === 'idee_doorsturen') {
        try { out = await forwardIdea(block.input); } catch (e) { out = `Doorsturen mislukt: ${e.message}`; }
      } else if (block.name === 'pdf_maken') {
        try { out = await makePdf(jid, block.input); } catch (e) { log('pdf failed:', e.message); out = `Pdf maken mislukt: ${e.message}`; }
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
  return text;
}

// ---------- helpers ----------
function textOf(msg) {
  const m = normalizeMessageContent(msg.message);
  if (!m) return '';
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || docMsg(m)?.caption || '';
}
function contextOf(msg) {
  const m = normalizeMessageContent(msg.message);
  return m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo || null;
}
const userPart = (jid) => (jid ? jidDecode(jid)?.user : undefined);

// ---------- WhatsApp ----------
let sock;
let myIds = new Set();
const groupNames = new Map();
const cooldown = new Map();                                       // sender -> last reply time

async function groupName(jid) {
  if (groupNames.has(jid)) return groupNames.get(jid);
  try { const md = await sock.groupMetadata(jid); groupNames.set(jid, md.subject || ''); return md.subject || ''; }
  catch { return ''; }
}

// "Claude", "@Claude" or the nickname "Jean-Claude" (also Jeanclaude / Jean Claude).
const CLAUDE_NAME = /(^|[\s@-])claude\b|\bjean\b|\bjean\s*-?\s*claude\b/i;                 // \"Jean\" alone also means Claude (Jean-Claude)
// ---------- bull & bear ----------
// "debat ASML" / "bull bear ASML" / "Claude, debat bitcoin": Claude makes the bull case, the aap the bear case,
// then a WhatsApp poll. Max 3 per day; counts as a Claude answer for the daily budget.
const DEBATE_RE = /^(?:debat|bull\s*(?:&|en|vs\.?|tegen|\/)?\s*bear)\s*[:,-]?\s+(.{2,40})$/i;
const debateDay = { day: '', n: 0 };
async function maybeDebate(jid, msg, name, text) {
  const clean = text.replace(/^(\s*@\d+)+/, '').replace(/^\s*(jean[\s-]*)?claude\s*[,:]?\s*/i, '').trim();
  const m = clean.match(DEBATE_RE);
  if (!m) return false;
  const subject = m[1].replace(/[?!.]+$/, '').replace(/^over\s+/i, '').trim();
  if (debateDay.day !== today()) { debateDay.day = today(); debateDay.n = 0; }
  if (debateDay.n >= 3 || repliesToday() >= dailyLimit()) {
    await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } }).catch(() => {});
    return true;
  }
  debateDay.n++;
  log(`debate: ${subject} (asked by ${name})`);
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  let bull = '';
  try {
    bull = await askClaude(jid, name, text,
      `Dit is een bull & bear-debat over ${subject}. Jij verdedigt de bull case: waarom kopen. De aap doet meteen daarna de bear case. ` +
      'Begin met 🐂. Twee à drie zinnen: je sterkste argument met één concreet inzicht (zoek op het web als je het nodig hebt), en eindig met een steek naar de aap of naar een clublid dat het aandeel heeft. ');
  } catch (e) { log('debate bull failed:', e.message); }
  if (!bull) bull = `🐂 ${subject}? Kopen. Meer heb ik vandaag niet, maar de aap heeft nog minder.`;
  if (!bull.startsWith('🐂')) bull = `🐂 ${bull}`;
  await sock.sendMessage(jid, { text: asClaude(bull) }, { quoted: msg });
  countReply();
  remember(jid, 'Claude', bull);
  await new Promise((r) => setTimeout(r, 4000));
  let bear = await monkeyLine(jid, `Bull & bear-debat over ${subject}. Claude verdedigde net de bull case (zie zijn laatste bericht). ` +
    `Jij bent de bear: waarom ${subject} NIET kopen, op jouw manier, en lach Claude's argument uit. Begin met 🐻. Hoogstens 4 stukjes.`);
  if (!bear) bear = MONKEY_TAG + `🐻 Aap zeggen nee. Aap niet vertrouwen ${subject}. Aap houden banaan.`;
  bear = bear.replace(/^(🐒 Aap: )(?!🐻)/, '$1🐻 ');
  await sock.sendMessage(jid, { text: bear });
  remember(jid, 'De aap', bear);
  await new Promise((r) => setTimeout(r, 2000));
  await sock.sendMessage(jid, { poll: { name: `${subject}: wie heeft gelijk?`, values: ['🐂 Claude: kopen', '🐻 Aap: niet kopen'], selectableCount: 1 } })
    .catch((e) => log('poll failed:', e.message));
  remember(jid, '(bot)', `Poll: ${subject}: wie heeft gelijk? Claude (kopen) of de aap (niet kopen)`);
  return true;
}

// ---------- screenshots ----------
const IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const hasImage = (msg) => !!normalizeMessageContent(msg.message)?.imageMessage;
// The image in this message, or the image it replies to ("Claude, wat denk je hiervan?" under a screenshot).
async function imagesOf(msg, ctx) {
  const img = normalizeMessageContent(msg.message)?.imageMessage
    || (ctx?.quotedMessage ? normalizeMessageContent(ctx.quotedMessage)?.imageMessage : null);
  if (!img) return [];
  const type = String(img.mimetype || 'image/jpeg').split(';')[0];
  if (!IMG_TYPES.has(type) || Number(img.fileLength || 0) > 5 * 1024 * 1024) return [];
  try {
    const chunks = [];
    for await (const c of await downloadContentFromMessage(img, 'image')) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (!buf.length || buf.length > 5 * 1024 * 1024) return [];
    return [{ media_type: type, data: buf.toString('base64') }];
  } catch (e) { log('image download failed:', e.message); return []; }
}

// Documents (CSV, XLSX, PDF) in a private chat: broker statements and trade confirmations for kanalen.mjs.
const docMsg = (m) => m?.documentMessage || m?.documentWithCaptionMessage?.message?.documentMessage || null;
const hasDoc = (msg) => !!docMsg(normalizeMessageContent(msg.message));
async function docsOf(msg) {
  const d = docMsg(normalizeMessageContent(msg.message));
  if (!d || Number(d.fileLength || 0) > 8 * 1024 * 1024) return [];
  try {
    const chunks = [];
    for await (const c of await downloadContentFromMessage(d, 'document')) chunks.push(c);
    const buf = Buffer.concat(chunks);
    return buf.length ? [{ name: d.fileName || 'bestand', mime: String(d.mimetype || '').split(';')[0], data: buf }] : [];
  } catch (e) { log('document download failed:', e.message); return []; }
}

function isForBot(text, ctx) {
  const mentioned = (ctx?.mentionedJid || []).some((j) => myIds.has(userPart(j)));
  const repliedToBot = ctx?.participant && myIds.has(userPart(ctx.participant));
  const named = CLAUDE_NAME.test(text);
  return mentioned || repliedToBot || named;
}
// The monkey only answers when spoken TO ("aap, …", "@aap", "🐒 …", "… aap?"), not when merely mentioned.
const isForMonkey = (text) => /^\s*(@?(de\s+)?aap(je)?\b|🐒)|\baap(je)?\s*\?\s*$/i.test(text) && !CLAUDE_NAME.test(text);

// Anti-spam: per-group sliding windows. Over the limit, Claude reacts ⏳ instead of answering; the monkey stays silent.
const LIMITS = { claude: { n: 6, ms: 60 * 60 * 1000 }, monkey: { n: 2, ms: 30 * 60 * 1000 }, monkeyDay: { n: 8, ms: 24 * 60 * 60 * 1000 } };
const windows = new Map();
function allow(kind, jid) {
  const { n, ms } = LIMITS[kind];
  const key = `${kind}:${jid}`;
  const now = Date.now();
  const hits = (windows.get(key) || []).filter((t) => now - t < ms);
  if (hits.length >= n) { windows.set(key, hits); return false; }
  hits.push(now); windows.set(key, hits); return true;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(join(DATA_DIR, 'auth'));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'warn' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);
  { const send = sock.sendMessage.bind(sock);                       // repair garbled emoji in every outgoing text
    sock.sendMessage = (jid, content, opts) => send(jid, content && typeof content.text === 'string' ? { ...content, text: fixText(content.text) } : content, opts); }

  if (!state.creds.registered && !CFG.phone) { log('BOT_PHONE is not set: cannot request a pairing code'); process.exit(1); }
  let pairingRequested = false;
  // Ask for the pairing code only once WhatsApp is ready for it (first "qr" event), not on a timer.
  // Default: show the QR on the status page (scan it with WhatsApp Business). A pairing code is only
  // requested when someone opens /code, because requesting one switches the session to code mode.
  const requestCode = async () => {
    if (state.creds.registered || pairingRequested) return;
    pairingRequested = true;
    {
      try {
        const code = await sock.requestPairingCode(CFG.phone);
        const pretty = code.match(/.{1,4}/g).join('-');
        const banner = `\n\n==============================\n  KOPPELCODE WHATSAPP: ${pretty}\n==============================\n` +
          'WhatsApp Business > Instellingen > Gekoppelde apparaten > Apparaat koppelen > Koppel met telefoonnummer\n\n';
        console.log(banner);
        writeFileSync(join(DATA_DIR, 'pairing-code.txt'), pretty + '\n');
        STATUS.pairing = pretty;
        try { writeFileSync('/dev/tty1', banner); } catch {}
      } catch (e) { log('pairing code request failed:', e.message); STATUS.lastError = `koppelcode aanvragen mislukt: ${e.message}`; }
    }
  };
  STATUS.requestCode = requestCode;
  sock.ev.on('connection.update', async ({ qr }) => {
    if (!qr || state.creds.registered) return;
    STATUS.qr = qr;
    if (STATUS.wantCode) await requestCode();
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      myIds = new Set([userPart(sock.user?.id), userPart(sock.user?.lid)].filter(Boolean));
      STATUS.connected = true; STATUS.pairing = null; STATUS.qr = null;
      log('connected to WhatsApp as', sock.user?.id, sock.user?.lid || '');
    }
    if (connection === 'close') {
      STATUS.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut || code === 403 || code === DisconnectReason.badSession) {
        // Failed pairing or logged out: wipe the session and restart clean, so a fresh code appears.
        log(`session rejected (${code}): wiping auth and restarting`);
        STATUS.lastError = `vorige koppeling mislukt (${code}), nieuwe code volgt`;
        try { rmSync(join(DATA_DIR, 'auth'), { recursive: true, force: true }); } catch {}
        setTimeout(() => process.exit(1), 2000);
        return;
      }
      log('connection closed (', code, '), reconnecting in 5 s');
      setTimeout(start, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handle(msg); } catch (e) { log('handler error:', e.message); }
    }
  });
}

// ---------- first introduction (once per group) ----------
const INTRO_FILE = join(DATA_DIR, 'introduced.json');
const introducedSet = new Set(existsSync(INTRO_FILE) ? JSON.parse(readFileSync(INTRO_FILE, 'utf8')) : []);
const introduced = (jid) => introducedSet.has(jid);
const INTRO_NOTE =
  'Dit is je allereerste bericht in deze groep: stel jezelf voor. Je wilt dat ze na dit bericht denken: oei, die heeft ons door. ' +
  'Geen begroeting, geen emoji, geen uitroeptekens: begin meteen met je scherpste vaststelling. ' +
  'ANALYSE: kies uit de clubdata de één of twee inzichten die het meest pijn doen en niet voor de hand liggen. Denk aan: hoeveel leden dit jaar (YTD) slechter deden dan gewoon een MSCI World- of S&P 500-tracker kopen en gaan slapen; ' +
  'het groepsgemiddelde tegenover de benchmark; hoe geconcentreerd de club is (zelfde aandelen, één aandeel als halve portefeuille); wie zijn rendement aan één aandeel te danken heeft; wie veel handelt zonder dat het iets oplevert. ' +
  'Gebruik echte namen en exacte cijfers uit de clubdata, en tel zelf correct. Trek er een conclusie uit in één zin, alsof je een diagnose stelt. Droog en zelfzeker, niet gemeen: plagen mag, beledigen niet. ' +
  'POSITIE: zeg dan wat jij daarom anders gaat doen. Vanaf Q4 2026 beleg je mee met €50.000 virtueel geld: gespreid, kwaliteit, bewust andere aandelen dan de club, hoogstens twee transacties per week, elke maandag een beslissing, en elke aankoop meld je hier met de reden erbij. Eindig die alinea met een korte, uitdagende zin richting de groep. ' +
  'GEBRUIK: één zin: tag @Claude voor cijfers, nieuws of een mening; ideeën voor het dashboard gaan naar Gilles; eurobedragen en het lopende kwartaal krijgen ze niet. ' +
  'Hoogstens drie korte alinea\'s en 120 woorden, geen opsomming, geen vette tekst. Stel de aap niet voor: die doet dat zelf meteen na jou; je mag de beleggende aap in je laatste zin het woord geven.\n\n';
const MONKEY_INTRO = [
  MONKEY_TAG + 'Computer veel praten. Aap niet praten.',
  'Computer denken. Aap banaan pakken. Of krant slaan. Of zitten op laptop.',
  'Aap ook vijftigduizend. Aap niet weten wat dat is.',
  'Januari: aap boven computer. 🍌',
  'Wie onder aap? Ad fundum. 🍺',
].join('\n');

async function introduce(jid, name, text, msg) {
  introducedSet.add(jid);
  writeFileSync(INTRO_FILE, JSON.stringify([...introducedSet]));
  log(`introducing in ${jid}`);
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  let intro;
  try { intro = await askClaude(jid, name, text, INTRO_NOTE); } catch (e) { log('intro error:', e.message); }
  await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  if (intro) {
    await sock.sendMessage(jid, { text: asClaude(intro) });
    countReply();
    remember(jid, 'Claude', intro);
  }
  await new Promise((r) => setTimeout(r, 20000));
  await sock.sendMessage(jid, { text: MONKEY_INTRO });
  remember(jid, 'De aap', MONKEY_INTRO);
}

async function handle(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return;
  if (!isJidGroup(jid)) { if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) await handlePrivate(msg); return; }
  const text = textOf(msg).trim();
  const photo = hasImage(msg);
  if (!text && !photo) return;
  if (CFG.groupFilter && !(await groupName(jid)).toLowerCase().includes(CFG.groupFilter)) return;

  const name = msg.pushName || userPart(msg.key.participantAlt || msg.key.participant) || 'iemand';
  const ctx = contextOf(msg);
  const forBot = isForBot(text, ctx);
  remember(jid, name, photo ? `[foto]${text ? ` ${text}` : ''}` : text);
  if (introduced(jid) && await maybeDebate(jid, msg, name, text)) return;
  await maybeBanana(jid, msg, text);
  if (introduced(jid) && !forBot && !isForMonkey(text) && LOSS_RE.test(text)) maybeMonkeyButtIn(jid, 0.25, MONKEY_LOSS, name.split(' ')[0]);

  if (!introduced(jid) && (forBot || /(^|[\s@])(de\s+)?aap(je)?\b|🐒/i.test(text))) { await introduce(jid, name, text, msg); return; }
  if (!forBot && !isForMonkey(text)) return;
  const sender = msg.key.participant || jid;
  if (Date.now() - (cooldown.get(sender) || 0) < 15000) return;   // no spam loops
  cooldown.set(sender, Date.now());

  if (!forBot) {
    if (!allow('monkey', jid) || !allow('monkeyDay', jid)) return;
    const reply = await monkeyAnswer(jid, name, text);
    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    remember(jid, 'De aap', reply);
    return;
  }

  if (!isFree() && !allow('claude', jid)) {
    await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } }).catch(() => {});
    remember(jid, '(bot)', `⏳ Claude gaf ${name} geen antwoord (limiet per uur).`);
    return;
  }
  if (repliesToday() >= dailyLimit()) {
    remember(jid, '(bot)', `Claude gaf ${name} geen antwoord (dagbudget op).`);
    if (repliesToday() === dailyLimit()) {
      countReply();
      await sock.sendMessage(jid, { text: CLAUDE_TAG + 'Ik heb vandaag genoeg gepraat, mijn budget is op. Morgen ben ik er weer! 🍺' });
    }
    return;
  }

  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  let answer;
  try { answer = await askClaude(jid, name, text || '(stuurt een foto zonder tekst)', '', false, await imagesOf(msg, ctx)); }
  catch (e) {
    log('claude error:', e.status || '', e.message);
    answer = e.status === 400 && /credit/i.test(e.message)
      ? 'Mijn tegoed is op. Gilles, tijd om bij te tanken! 💸'
      : 'Even een kortsluiting in mijn hoofd. Probeer het zo nog eens.';
  }
  await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  if (!answer) return;
  const reply = asClaude(answer);
  await sock.sendMessage(jid, { text: reply }, { quoted: msg });
  countReply();
  remember(jid, 'Claude', answer);
  maybeMonkeyButtIn(jid, 0.12, MONKEY_BUTT_IN);                   // not awaited: never delays the bot
}

await refreshClub();
setInterval(refreshClub, CFG.refreshMs);
start();

// ---------- koersen: morning message on closing prices + live crash alert (pricewatch.mjs, 8 Oct 2026) ----------
const pct1 = (p) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1).replace('.', ',')}%`;
const NAME_SUFFIX = new Set(['CORP', 'INC', 'NV', 'SA', 'AG', 'PLC', 'SE']);
const LABEL_KEEP = new Set(['ASML', 'MSCI', 'SPDR', 'IWDA', 'VWCE', 'VWRL', 'NYSE', 'USA', 'ETF']);
const LABEL_FIX = { XFAB: 'X-FAB', INBEV: 'InBev', ISHARES: 'iShares', SPACEX: 'SpaceX', NVIDIA: 'Nvidia' };
function stockLabel(s) {                                          // "APPLIED DIGITAL CORP" -> "Applied Digital", "ASM INTERNATIONAL" -> "ASM International"
  const w = String(s).trim().split(/\s+/);
  if (w.length > 1 && NAME_SUFFIX.has(w[w.length - 1].toUpperCase())) w.pop();
  return w.map((x) => LABEL_FIX[x] || (x.length <= 3 || LABEL_KEEP.has(x) || /\d/.test(x) || x !== x.toUpperCase() ? x : x[0] + x.slice(1).toLowerCase())).join(' ');
}
function dayLabel(date, today) {
  if (date === new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10)) return 'Gisteren';
  const wd = new Date(`${date}T12:00:00Z`).toLocaleDateString('nl-BE', { weekday: 'long', timeZone: 'UTC' });
  return wd[0].toUpperCase() + wd.slice(1);
}
const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/\./g, '');

const DIGEST_SEARCHES = 4;                                        // stocks that get a reason (one web search each, biggest drops first); one search for all of them found nothing

// Why did this stock drop? One small call with one web search, no persona (cheap). '' when nothing is found.
async function dropReason(x, date) {
  const content = `Waarom sloot ${stockLabel(x.stock)} (ticker ${x.ticker}) op ${date} ${pct1(x.pct)} lager? Zoek het op het web. ` +
    'Antwoord met hoogstens tien woorden in het Nederlands, zonder het aandeel of het percentage te herhalen en zonder punt. ' +
    'Vind je geen nieuws over die dag, antwoord dan alleen: onbekend. Verzin niets.';
  const messages = [{ role: 'user', content }];
  try {
    for (let round = 0; round < 3; round++) {
      const model = modelFor('breaking');
      const res = await anthropic.messages.create({
        _feature: 'breaking', model, max_tokens: 1200, thinking: thinkingFor(model),
        tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 1 }],
        messages,
      });
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      const t = finalText(res.content).split('\n').pop().replace(/[*_"]/g, '').replace(/\.$/, '').trim();
      return /^onbekend\b/i.test(t) || t.split(/\s+/).length > 16 ? '' : t;
    }
  } catch (e) { log('digest reason failed:', x.ticker, e.message); }
  return '';
}

// One market sentence from the numbers themselves (no model, nothing to make up).
function marketLine(indices) {
  const word = (p) => (Math.abs(p) < 0.3 ? 'vlak' : `${Math.abs(p) < 1 ? 'licht ' : Math.abs(p) >= 2 ? 'fors ' : ''}${p > 0 ? 'hoger' : 'lager'}`);
  const us = indices.filter((i) => i.name !== 'BEL 20'), be = indices.find((i) => i.name === 'BEL 20');
  const parts = [];
  if (us.length) parts.push(`Wall Street ${word(us.reduce((a, i) => a + i.pct, 0) / us.length)}`);
  if (be) parts.push(`Brussel ${word(be.pct)}`);
  return parts.length ? `${parts.join(', ')}.` : '';
}

// Claude adds the reasons and one closing line; the numbers, names and market sentence come from the code.
async function digestExtras(d) {
  const top = d.drops.slice(0, DIGEST_SEARCHES);
  const found = await Promise.all(top.map((x) => dropReason(x, d.date)));
  const redenen = Object.fromEntries(top.map((x, i) => [stockLabel(x.stock).toLowerCase(), found[i]]));
  const count = Object.entries(d.drops.flatMap((x) => x.holders).reduce((a, h) => ((a[h] = (a[h] || 0) + 1), a), {})).map(([h, n]) => `${h} ${n}`).join(', ');
  const content =
    `Ochtendbericht in de groep over de beursdag van ${dayLabel(d.date, d.today).toLowerCase()} (${d.date}). Dit staat er al in:\n` +
    `${d.drops.map((x) => `${stockLabel(x.stock)} ${pct1(x.pct)} (${x.holders.join(', ')})${redenen[stockLabel(x.stock).toLowerCase()] ? `: ${redenen[stockLabel(x.stock).toLowerCase()]}` : ''}`).join('\n')}\n` +
    `Per houder, aantal aandelen in die lijst: ${count}.\n` +
    (d.best ? `Lichtpuntje: ${stockLabel(d.best.stock)} ${pct1(d.best.pct)} (${d.best.holders.join(', ')}).\n` : '') +
    `\nHet bericht komt de ochtend erna, dus het gaat over ${dayLabel(d.date, d.today).toLowerCase()}, niet over vandaag. ` +
    'Schrijf de slotzin: één droge, korte zin, mag een steek naar een houder zijn. Gebruik alleen de gegevens hierboven, ' +
    'nooit bedragen, posities of de ranking, en herhaal geen percentages. Schrijf alleen die zin.';
  let slot = '';
  try {
    const model = modelFor('breaking');
    const res = await anthropic.messages.create({
      _feature: 'breaking', model, max_tokens: 600, thinking: thinkingFor(model),
      system: [{ type: 'text', text: persona, cache_control: { type: 'ephemeral' } }],   // no club data: the line may only use what is in the message
      messages: [{ role: 'user', content }],
    });
    slot = finalText(res.content).replace(/^["“]|["”]$/g, '').trim();
  } catch (e) { log('digest closing line failed:', e.message); }
  return { markt: marketLine(d.indices), redenen, slot };
}

async function composeDigest(d) {
  const ex = await digestExtras(d);
  const reasons = Object.fromEntries(Object.entries(ex.redenen || {}).map(([k, v]) => [k.replace(/\(.*?\)/g, '').toLowerCase().trim(), String(v || '').trim().replace(/\.$/, '')]));
  const head = [`☕ *${dayLabel(d.date, d.today)} op de beurs* (${shortDate(d.date)})`, String(ex.markt || '').trim(), d.indices.map((i) => `${i.name} ${pct1(i.pct)}`).join(' · ')].filter(Boolean).join('\n');
  const drops = d.drops.map((x) => {
    const label = stockLabel(x.stock), r = reasons[label.toLowerCase()];
    return `• ${label} ${pct1(x.pct)} (${x.holders.join(', ')})${r ? `: ${r}` : ''}`;
  });
  let text = `${head}\n\n📉 *Slotkoers 5% of meer lager*\n${drops.join('\n')}`;
  if (d.best) text += `\n\n🌱 Lichtpuntje: ${stockLabel(d.best.stock)} ${pct1(d.best.pct)} (${d.best.holders.join(', ')})`;
  if (ex.slot) text += `\n\n${String(ex.slot).trim()}`;
  return text;
}

// Live crash alert: a club stock 15%+ below the previous close, once per stock per day.
async function composeBreaking(hits) {
  const lines = hits.map((x) => `${x.stock}: ${x.pct.toFixed(1).replace('.', ',')}% vandaag (in de portefeuille van ${x.holders.join(', ')})`);
  const fallback = `🚨 ${hits.map((x) => `*${stockLabel(x.stock)}* ${pct1(x.pct)}`).join(', ')}. Sterkte, ${[...new Set(hits.flatMap((x) => x.holders))].join(', ')}.`;
  try {
    const messages = [{ role: 'user', content:
      `Koersalarm. Deze aandelen uit de club staan vandaag 15% of meer lager dan de vorige slotkoers:\n${lines.join('\n')}\n\n` +
      'Schrijf één kort breaking-news bericht voor de groep: begin met 🚨, noem het aandeel, de daling en de houders bij naam. ' +
      'Zoek op het web waarom het daalt en zeg het in een halve zin als je het vindt. Vind je niets, zeg dan gewoon dat de reden nog niet bekend is en verzin niets. ' +
      'Vertel nooit dat of hoe vaak je zocht. ' +
      'Hoogstens 3 zinnen. Een vleugje zwarte humor mag, maar lach niemand uit. Schrijf alleen het bericht.' }];
    for (let round = 0; round < 3; round++) {
      const model = modelFor('breaking');
      const res = await anthropic.messages.create({
        _feature: 'breaking', model, max_tokens: 1500, thinking: thinkingFor(model),
        system: [{ type: 'text', text: persona }, { type: 'text', text: club.summary, cache_control: { type: 'ephemeral' } }],
        tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 1 }],
        messages,
      });
      let text = finalText(res.content);
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      const at = text.indexOf('🚨');                               // the model sometimes writes a sentence about its search first: cut it off
      if (at > 0) text = text.slice(at).trim();
      return text ? (text.startsWith('🚨') ? text : `🚨 ${text}`) : fallback;
    }
  } catch (e) { log('breaking compose failed:', e.message); }
  return fallback;
}

const pw = await import('./pricewatch.mjs').catch(() => null);   // optional module (arrives via self-update)
if (pw) {
  const toGroups = async (text) => {
    const groups = [...introducedSet];
    if (!groups.length || !sock) return;
    for (const g of groups) { await sock.sendMessage(g, { text }); remember(g, 'Claude', text); }
  };
  pw.startPriceWatch({
    dir: HERE, dataDir: DATA_DIR, log,
    holders: () => club.holders || {},
    announce: async (hits) => toGroups(asClaude(await composeBreaking(hits))),
    announceDigest: pw.buildDigest ? async (d) => toGroups(asClaude(await composeDigest(d))) : undefined,
  });
  // /ochtend (Gilles, private): preview of the morning message for the last trading day; posts nothing in the group.
  globalThis.__ochtendPreview = async (to) => {
    if (!pw.buildDigest) return sock.sendMessage(to, { text: CLAUDE_TAG + 'De nieuwe koersmodule is nog niet binnen. Probeer over tien minuten opnieuw.' });
    const d = await pw.buildDigest({ dir: HERE, holders: club.holders || {}, log });
    if (!d || !d.checked) return sock.sendMessage(to, { text: CLAUDE_TAG + 'Geen koersen gevonden. Probeer later opnieuw.' });
    const text = d.drops.length ? await composeDigest(d)
      : `Op ${shortDate(d.date)} sloot geen enkel clubaandeel 5% of meer lager, dus de groep kreeg die ochtend niets.\n${d.indices.map((i) => `${i.name} ${pct1(i.pct)}`).join(' · ')}`;
    await sock.sendMessage(to, { text: `👀 Voorbeeld, alleen voor jou:\n\n${asClaude(text)}` });
  };
  log('price watch started');
}

// ---------- phase 2/3: Claude and the aap invest, automatic messages, pdfs (all optional) ----------
async function composeShort(prompt) {
  const model = modelFor('auto');
  const res = await anthropic.messages.create({
    _feature: 'auto', model, max_tokens: 600, thinking: thinkingFor(model),
    system: [{ type: 'text', text: persona }, { type: 'text', text: club.summary, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}
pdfLib = await import('./pdf.mjs').catch((e) => { log('pdf module not loaded:', e.message); return null; });
const traderMod = await import('./trader.mjs').catch((e) => { log('trader module not loaded:', e.message); return null; });
if (traderMod) {
  trader = traderMod.createTrader({
    dir: HERE, dataDir: DATA_DIR, log, anthropic, model: CFG.model, persona,
    clubSummary: () => club.summary,
    clubNames: () => { try { return JSON.parse(readFileSync(join(HERE, 'tickers.json'), 'utf8')); } catch { return {}; } },
  });
  const sig = () => { const L = trader.ledger(); return `${L.decisions.length}|${L.orders.filter((o) => o.status !== 'open').length}`; };
  const tickTrader = async () => {
    const before = sig();
    await trader.tick().catch((e) => log('trader tick:', e.message));
    if (sig() !== before) await refreshClub();                    // Claude knows his own trades right away
  };
  setTimeout(tickTrader, 60 * 1000);
  setInterval(tickTrader, 5 * 60 * 1000);
  log('trader started');
}
const autopostMod = await import('./autopost.mjs').catch((e) => { log('autopost module not loaded:', e.message); return null; });
if (autopostMod) {
  autopost = autopostMod.startAutopost({
    dataDir: DATA_DIR, log, getSock: () => sock, groups: () => [...introducedSet], adminJid, trader,
    compose: composeShort, remember: (jid, who, text) => remember(jid, who, text), pdf: pdfLib, asClaude,
  });
  log('autopost started');
}
const invoerMod = await import('./invoer.mjs').catch((e) => { log('invoer module not loaded:', e.message); return null; });
if (invoerMod) {
  invoer = invoerMod.createInvoer({ anthropic, getSock: () => sock, log, dataDir: DATA_DIR, hereDir: HERE, adminJid, claudeTag: CLAUDE_TAG });
  log('invoer started');
  const kanalenMod = await import('./kanalen.mjs').catch((e) => { log('kanalen module not loaded:', e.message); return null; });
  if (kanalenMod) {
    kanalen = kanalenMod.createKanalen({ invoer, getSock: () => sock, log, adminJid, claudeTag: CLAUDE_TAG, dataDir: DATA_DIR });
    log('kanalen started');
  }
}
await refreshClub();                                              // again, now with the bot portfolios

// ---------- status page (http://<server-ip>:8080): pairing code while unpaired, nothing secret ----------
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
createServer(async (req, res) => {
  if (kanalen && await kanalen.http(req, res).catch(() => false)) return;   // /api/koers for the phone form
  if (req.url.startsWith('/feed/ideas.json')) {                   // ideas and requests from members, for the roadmap backlog
    let body = '[]';
    try { body = readFileSync(IDEAS_FILE, 'utf8'); } catch {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  if (req.url.startsWith('/feed/costs.json')) {                   // API cost per feature and model, read by the laptop for the cost slide
    let body = '{}';
    try { body = readFileSync(USAGE_MODELS_FILE, 'utf8'); } catch {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  if (req.url.startsWith('/feed/ledger.json')) {                  // read by the laptop (bot_bridge.py); virtual money only
    res.writeHead(trader ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(trader ? JSON.stringify(trader.publicLedger()) : '{}');
    return;
  }
  if (req.url.startsWith('/code') && !STATUS.connected) { STATUS.wantCode = true; if (STATUS.requestCode) await STATUS.requestCode(); await new Promise((r) => setTimeout(r, 1500)); }
  let body;
  if (STATUS.connected) body = '<h1>✅ Bot is verbonden met WhatsApp</h1>';
  else if (STATUS.pairing) body = `<h1>Koppelcode: <code>${STATUS.pairing}</code></h1><p>WhatsApp Business → Instellingen → Gekoppelde apparaten → Apparaat koppelen → <b>Koppel met telefoonnummer</b>.</p><p>Mislukt? Herstart de bot niet: open <a href="/">de QR-code</a> en scan die.</p>`;
  else if (STATUS.qr) {
    const img = await QRCode.toDataURL(STATUS.qr, { width: 360, margin: 2 });
    body = `<h1>Scan deze QR-code</h1><p>iPhone: <b>WhatsApp Business</b> → Instellingen → Gekoppelde apparaten → Apparaat koppelen → richt de camera op dit scherm.</p><img src="${img}" alt="QR"><p style="color:#888">De code ververst vanzelf. Liever een koppelcode? <a href="/code">Vraag er een aan</a>.</p><script>setTimeout(()=>location.reload(),15000)</script>`;
  } else body = '<h1>⏳ Bot start op…</h1><p>Deze pagina herlaadt vanzelf.</p><script>setTimeout(()=>location.reload(),5000)</script>';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    let extra = '';
  if (STATUS.connected && trader) {
    const L = trader.ledger(), ts = trader.status, open = L.orders.filter((o) => o.status === 'open').length;
    extra += `<h2>Beleggen</h2><p>${L.orders.filter((o) => o.status === 'filled').length} transacties geboekt, ${open} wachten op de slotkoers. ` +
      `Laatste beslissing: ${esc(ts.lastDecision || '-')}.${ts.lastError ? ` <span style="color:#b45309">Fout: ${esc(ts.lastError)}</span>` : ''} <a href="/feed/ledger.json">ledger</a></p>`;
  }
  if (STATUS.connected && autopost) {
    const as = autopost.status;
    extra += `<h2>Automatische berichten</h2><p>Laatste: ${esc(as.last || '-')}. Feed gelezen: ${esc(as.feedAt || '-')}${as.feedError ? ` <span style="color:#b45309">(${esc(as.feedError)})</span>` : ''}.</p>`;
  }
  res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>Kwartaal-bot</title><body style="font-family:system-ui;padding:24px">${body}${extra}${STATUS.lastError && !STATUS.connected ? `<p style="color:#b45309">${STATUS.lastError}</p>` : ''}<p style="color:#888">Opgestart: ${STATUS.started}</p></body>`);
}).listen(8080).on('error', (e) => log('status page:', e.message));

// ---------- self-update (every 10 minutes, first check after 2 minutes) ----------
async function updateTick() {
  try {
    if (await checkForUpdate(HERE, log)) { log('restarting to load the new version'); process.exit(0); }
  } catch (e) { log('update check failed:', e.message); }
}
setTimeout(updateTick, 2 * 60 * 1000);
setInterval(updateTick, 10 * 60 * 1000);
