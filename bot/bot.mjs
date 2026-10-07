// Kwartaalmeeting WhatsApp bot: "Claude & de Aap"
// - Answers in the club group when someone tags the bot, writes "claude", or replies to it.
// - "aap" / 🐒 gets a reply from the monkey (random dart throw, no AI cost).
// - Club numbers come from the public dashboard (no euro amounts).

import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  jidDecode, isJidGroup, normalizeMessageContent,
} from 'baileys';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import QRCode from 'qrcode';
import { fetchClubSummary } from './clubdata.mjs';
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
  historySize: 40,
  refreshMs: 3 * 60 * 60 * 1000,                                  // club data every 3 hours
};

const STATUS = { started: new Date().toISOString(), connected: false, pairing: null, lastError: null, qr: null, wantCode: false };
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const anthropic = new Anthropic();                                // reads ANTHROPIC_API_KEY
const persona = readFileSync(join(HERE, 'persona.md'), 'utf8');

// ---------- club data ----------
let club = { summary: 'CLUBDATA: (nog niet geladen)', stocks: [] };
let trader = null, autopost = null, pdfLib = null;                // phase 2/3 modules, loaded below (optional)
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

// ---------- chat memory per group ----------
const history = new Map();                                        // jid -> [{name, text}]
function remember(jid, name, text) {
  const h = history.get(jid) || [];
  h.push({ name, text: text.slice(0, 1000) });
  while (h.length > CFG.historySize) h.shift();
  history.set(jid, h);
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
// Fixed lines (free), at most 2 per day, and only within his normal limits (1 per half hour, 4 per day).
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
  const text = MONKEY_TAG + lines[Math.floor(Math.random() * lines.length)].replaceAll('{N}', name || 'mens');
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
Je snapt NIETS van beleggen en dat is je kracht. Moeilijke beleggingswoorden ken je niet: hoor je er één, dan snap je het niet ("Rente? Aap niet kennen. Rente lekker?"). Alleen deze woorden ken je wel, want leden leerden ze je: {WORDS}.
Cijfers verzin je niet. Aap kan niet tellen tot meer dan tien.
Vraagt iemand iets vies, gemeens of ongepasts: aap doet dom en gooit een drol naar de vraag. Nooit grappen over echte mensen buiten de club, ziekte, dood of groepen mensen.
Vraagt iemand wat hij moet kopen: aap kiest op zijn manier, bijvoorbeeld {S}.
Schrijf alleen wat de aap zegt, zonder "Aap:" ervoor.`;
async function monkeyAnswer(jid, asker, question) {
  try {
    const words = learned().map((w) => w.word);
    const pool = club.stocks.length ? club.stocks : ['NVIDIA'];
    const s = pool[Math.floor(Math.random() * pool.length)];
    const h = (history.get(jid) || []).slice(-8).map((m) => `${m.name}: ${m.text}`).join('\n');
    let own = '';
    try { const L = trader?.ledger(); if (L) own = [...new Set(L.orders.filter((o) => o.bot === 'Aap' && o.status !== 'failed').slice(-10).map((o) => o.name))].join(', '); } catch {}
    const res = await anthropic.messages.create({
      model: CFG.model, max_tokens: 300, thinking: { type: 'between_tools' },     // no thinking: short and fast
      system: MONKEY_PERSONA.replace('{WORDS}', words.length ? words.join(', ') : 'nog geen enkel woord').replace('{S}', `*${s}*`) +
        (own ? `\nJouw eigen aandelen nu (mag je trots noemen): ${own}.` : ''),
      messages: [{ role: 'user', content: `Laatste berichten in de chat:\n${h || '(geen)'}\n\n${asker} zegt tegen jou: "${question}"\n\nAntwoord als de aap.` }],
    });
    const t = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim().replace(/^\s*(🐒\s*)?\*?aap\*?\s*:\s*/i, '');
    if (t) return MONKEY_TAG + t;
  } catch (e) { log('monkey AI failed:', e.message); }
  return monkeyReply();
}

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
const TOOLS = [
  { type: 'web_search_20260318', name: 'web_search', max_uses: 3 },
  {
    name: 'idee_doorsturen',
    description: 'Stuur een idee of verzoek van een clublid voor het dashboard, de presentatie of de bot door naar Gilles, die het dashboard beheert. Gebruik dit alleen als iemand echt iets nieuws of een aanpassing vraagt.',
    input_schema: {
      type: 'object',
      properties: {
        van: { type: 'string', description: 'Naam van het clublid dat het vraagt' },
        idee: { type: 'string', description: 'Het idee in één of twee zinnen, zo concreet mogelijk' },
      },
      required: ['van', 'idee'],
    },
  },
  {
    name: 'pdf_maken',
    description: 'Maak een pdf-rapportje en stuur het in dit gesprek. Alleen als iemand uitdrukkelijk om een pdf, rapport of verslag vraagt. ' +
      'Schrijf de inhoud zelf, kort en helder, met cijfers uit de clubdata (procenten, geen eurobedragen). Je antwoord in de chat is daarna één korte zin.',
    input_schema: {
      type: 'object',
      properties: {
        titel: { type: 'string' },
        ondertitel: { type: 'string' },
        secties: {
          type: 'array', maxItems: 8,
          items: { type: 'object', properties: { kop: { type: 'string' }, tekst: { type: 'string', description: 'Mag <b>vet</b> bevatten' }, punten: { type: 'array', items: { type: 'string' } } } },
        },
        tabel: {
          type: 'object',
          properties: { kop: { type: 'string' }, kolommen: { type: 'array', items: { type: 'string' } }, rijen: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
        },
        bestandsnaam: { type: 'string', description: 'Kort, zonder .pdf' },
      },
      required: ['titel', 'secties'],
    },
  },
];

// PDF reports on request: at most 4 per day in total.
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
  await sock.sendMessage(admin, { text: `📥 *Nieuw idee van ${van}*\n${idee}` });
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
  'Wat iemand jou privé vertelt, vertel je niet door in de groep, en je zegt niet wat anderen jou privé vroegen.\n\n';
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
  if (text !== '/beheerder') { if (raw) await privateChat(msg, raw); return; }
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
  remember(from, name, text);

  if (isForMonkey(text)) {                                          // "aap, ..." works privately too
    const reply = await monkeyAnswer(from, name, text);
    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    remember(from, 'De aap', reply);
    return;
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
  try { answer = await askClaude(from, name, text, '', true); }
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

async function askClaude(jid, asker, question, extra = '', priv = false) {
  const h = history.get(jid) || [];
  const transcript = h.map((m) => `${m.name}: ${m.text}`).join('\n');
  const messages = [{
    role: 'user',
    content: `Vandaag is het ${new Date().toLocaleDateString('nl-BE', { dateStyle: 'full', timeZone: 'Europe/Brussels' })}.\n\n` +
             (priv
               ? `Dit is een PRIVÉGESPREK met ${asker}, niet de groep. Eerdere berichten in dit gesprek (oudste eerst):\n${transcript || '(geen)'}\n\n` +
                 `${asker} schrijft je nu: "${question}"\n\n${extra}${PRIVATE_NOTE}Schrijf alleen je antwoord aan ${asker}.`
               : `Recente berichten in de groep (oudste eerst):\n${transcript || '(geen)'}\n\n` +
                 `${asker} spreekt jou nu aan met: "${question}"\n\n${extra}Schrijf alleen je antwoord voor in de groep.`),
  }];
  let text = '';
  for (let round = 0; round < 4; round++) {
    const res = await anthropic.messages.create({
      model: CFG.model,
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
    text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
    if (res.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      let out = 'Onbekende tool.';
      if (block.name === 'idee_doorsturen') {
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
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
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
const CLAUDE_NAME = /(^|[\s@-])claude\b|\bjean\s*-?\s*claude\b/i;
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
  if (!text) return;
  if (CFG.groupFilter && !(await groupName(jid)).toLowerCase().includes(CFG.groupFilter)) return;

  const name = msg.pushName || userPart(msg.key.participantAlt || msg.key.participant) || 'iemand';
  const ctx = contextOf(msg);
  const forBot = isForBot(text, ctx);
  remember(jid, name, text);
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

  if (!allow('claude', jid)) {
    await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } }).catch(() => {});
    return;
  }
  if (repliesToday() >= CFG.dailyLimit) {
    if (repliesToday() === CFG.dailyLimit) {
      countReply();
      await sock.sendMessage(jid, { text: CLAUDE_TAG + 'Ik heb vandaag genoeg gepraat, mijn budget is op. Morgen ben ik er weer! 🍺' });
    }
    return;
  }

  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  let answer;
  try { answer = await askClaude(jid, name, text); }
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

// ---------- breaking news (drops of 5%, 10%, ... on stocks a member holds) ----------
async function composeBreaking(hits) {
  const lines = hits.map((x) => `${x.stock}: ${x.pct.toFixed(1).replace('.', ',')}% ${x.today ? 'vandaag' : 'bij de laatste slotkoers'} (in de portefeuille van ${x.holders.join(', ')})`);
  const fallback = `🚨 ${hits.map((x) => `*${x.stock}* ${x.pct.toFixed(1).replace('.', ',')}%`).join(', ')}. Sterkte, ${[...new Set(hits.flatMap((x) => x.holders))].join(', ')}.`;
  try {
    const messages = [{ role: 'user', content:
      `Koersalarm. Deze aandelen uit de club zakten net een volgende stap van 5% ten opzichte van de vorige slotkoers:\n${lines.join('\n')}\n\n` +
      'Schrijf één kort breaking-news bericht voor de groep: begin met 🚨, noem het aandeel, de daling en de houders bij naam. ' +
      'Zoek hoogstens één keer op het web waarom het daalt en zeg het in een halve zin als je het vindt; vind je niets, verzin dan niets. ' +
      'Hoogstens 3 zinnen. Een vleugje zwarte humor mag, maar lach niemand uit. Schrijf alleen het bericht.' }];
    for (let round = 0; round < 3; round++) {
      const res = await anthropic.messages.create({
        model: CFG.model, max_tokens: 1500, thinking: { type: 'between_tools' },
        system: [{ type: 'text', text: persona }, { type: 'text', text: club.summary, cache_control: { type: 'ephemeral' } }],
        tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 1 }],
        messages,
      });
      const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      return text ? (text.startsWith('🚨') ? text : `🚨 ${text}`) : fallback;
    }
  } catch (e) { log('breaking compose failed:', e.message); }
  return fallback;
}

const pw = await import('./pricewatch.mjs').catch(() => null);   // optional module (arrives via self-update)
if (pw) {
  pw.startPriceWatch({
    dir: HERE, dataDir: DATA_DIR, log,
    holders: () => club.holders || {},
    announce: async (hits) => {
      const groups = [...introducedSet];
      if (!groups.length || !sock) return;
      const text = asClaude(await composeBreaking(hits));
      for (const g of groups) { await sock.sendMessage(g, { text }); remember(g, 'Claude', text); }
    },
  });
  log('price watch started');
}

// ---------- phase 2/3: Claude and the aap invest, automatic messages, pdfs (all optional) ----------
async function composeShort(prompt) {
  const res = await anthropic.messages.create({
    model: CFG.model, max_tokens: 600, thinking: { type: 'between_tools' },
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
await refreshClub();                                              // again, now with the bot portfolios

// ---------- status page (http://<server-ip>:8080): pairing code while unpaired, nothing secret ----------
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
createServer(async (req, res) => {
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
