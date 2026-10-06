// Kwartaalmeeting WhatsApp bot: "Claude & de Aap"
// - Answers in the club group when someone tags the bot, writes "claude", or replies to it.
// - "aap" / 🐒 gets a reply from the monkey (random dart throw, no AI cost).
// - Club numbers come from the public dashboard (no euro amounts).

import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers,
  jidDecode, isJidGroup, normalizeMessageContent,
} from 'baileys';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const anthropic = new Anthropic();                                // reads ANTHROPIC_API_KEY
const persona = readFileSync(join(HERE, 'persona.md'), 'utf8');

// ---------- club data ----------
let club = { summary: 'CLUBDATA: (nog niet geladen)', stocks: [] };
async function refreshClub() {
  try { club = await fetchClubSummary(); log(`club data loaded (${club.summary.length} chars, ${club.stocks.length} stocks)`); }
  catch (e) { log('club data refresh failed:', e.message); }
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

// ---------- the monkey ----------
// The monkey talks in start-stop caveman Dutch: third person, no conjugation, no thinking.
const MONKEY_LINES = [
  'Aap niet denken. Aap pijl gooien. 🎯 {S}. Aap rijk.',
  'Oe oe. Banaan op. Pijl. 🎯 {S}. Kopen. Klaar.',
  'Aap geen grafiek. Aap geen analist. Aap pijl. 🎯 {S}.',
  'Hmm. Krabben. Gooien. 🎯 {S}! Aap slim.',
  'Oe oe aa aa! {S}. Alles erin. Geen spijt.',
  'Pijl mis. Muur kapot. Nog eens. 🎯 {S}. Goed genoeg.',
  'Mens lang denken. Aap kort denken. 🎯 {S}. Aap winnen.',
  'Wie onder aap? Ad fundum. 🍺 Aap kopen {S}.',
  'Aap moe. Aap toch gooien. 🎯 {S}. Slapen nu.',
  'Nieuws? Aap niet lezen. Aap gooien. 🎯 {S}. 🍌',
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
  let out = `🐒 ${line.replace('{S}', `*${s}*`)}`;
  const words = learned();
  if (words.length && Math.random() < 0.4) {             // show off a word he learned, and who taught it
    const w = words[Math.floor(Math.random() * words.length)];
    out += Math.random() < 0.5 ? ` Aap ${w.word}. Aap slim nu.` : ` Aap kennen woord '${w.word}'. Dank ${w.from}.`;
  }
  return out;
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
];

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
async function handlePrivate(msg) {
  const text = textOf(msg).trim().toLowerCase();
  const from = msg.key.remoteJid;
  if (text !== '/beheerder') return;
  if (adminJid()) {
    await sock.sendMessage(from, { text: adminJid() === from ? '✅ Je bent al de beheerder.' : 'Er is al een beheerder.' });
    return;
  }
  writeFileSync(ADMIN_FILE, JSON.stringify({ jid: from, name: msg.pushName || '', at: new Date().toISOString() }));
  log(`admin set to ${from}`);
  const f = join(DATA_DIR, 'ideas-pending.json');
  const pending = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  let reply = `✅ Dag ${msg.pushName || 'beheerder'}! Ideeën uit de groep komen voortaan bij jou terecht.`;
  if (pending.length) reply += `\n\nAl bewaard:\n${pending.map((p) => `• ${p.van}: ${p.idee}`).join('\n')}`;
  await sock.sendMessage(from, { text: reply });
  writeFileSync(f, '[]');
}

async function askClaude(jid, asker, question, extra = '') {
  const h = history.get(jid) || [];
  const transcript = h.map((m) => `${m.name}: ${m.text}`).join('\n');
  const messages = [{
    role: 'user',
    content: `Vandaag is het ${new Date().toLocaleDateString('nl-BE', { dateStyle: 'full', timeZone: 'Europe/Brussels' })}.\n\n` +
             `Recente berichten in de groep (oudste eerst):\n${transcript || '(geen)'}\n\n` +
             `${asker} spreekt jou nu aan met: "${question}"\n\n${extra}Schrijf alleen je antwoord voor in de groep.`,
  }];
  let text = '';
  for (let round = 0; round < 4; round++) {
    const res = await anthropic.messages.create({
      model: CFG.model,
      max_tokens: 2000,
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

function isForBot(text, ctx) {
  const mentioned = (ctx?.mentionedJid || []).some((j) => myIds.has(userPart(j)));
  const repliedToBot = ctx?.participant && myIds.has(userPart(ctx.participant));
  const named = /(^|[\s@])claude\b/i.test(text);
  return mentioned || repliedToBot || named;
}
// The monkey only answers when spoken TO ("aap, …", "@aap", "🐒 …", "… aap?"), not when merely mentioned.
const isForMonkey = (text) => /^\s*(@?(de\s+)?aap(je)?\b|🐒)|\baap(je)?\s*\?\s*$/i.test(text) && !/(^|[\s@])claude\b/i.test(text);

// Anti-spam: per-group sliding windows. Over the limit, Claude reacts ⏳ instead of answering; the monkey stays silent.
const LIMITS = { claude: { n: 6, ms: 60 * 60 * 1000 }, monkey: { n: 1, ms: 30 * 60 * 1000 }, monkeyDay: { n: 4, ms: 24 * 60 * 60 * 1000 } };
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
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'warn' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered) {
    if (!CFG.phone) { log('BOT_PHONE is not set: cannot request a pairing code'); process.exit(1); }
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(CFG.phone);
        const pretty = code.match(/.{1,4}/g).join('-');
        const banner = `\n\n==============================\n  KOPPELCODE WHATSAPP: ${pretty}\n==============================\n` +
          'WhatsApp Business > Instellingen > Gekoppelde apparaten > Apparaat koppelen > Koppel met telefoonnummer\n\n';
        console.log(banner);
        writeFileSync(join(DATA_DIR, 'pairing-code.txt'), pretty + '\n');
      } catch (e) { log('pairing code request failed:', e.message); }
    }, 4000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      myIds = new Set([userPart(sock.user?.id), userPart(sock.user?.lid)].filter(Boolean));
      log('connected to WhatsApp as', sock.user?.id, sock.user?.lid || '');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log('logged out by WhatsApp. Delete data/auth and pair again.');
        process.exit(2);
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
  'Dit is je allereerste bericht in deze groep: stel jezelf voor. Reageer kort op wat er net gezegd werd. ' +
  'Open met één scherpe observatie die toont dat je hun portefeuilles al gelezen hebt (iets wat klopt volgens de clubdata). ' +
  'Vertel dan dat je vanaf Q4 2026 meebelegt met €50.000 virtueel geld, dat je elke maandag beslist en elke aankoop hier meldt met de reden erbij, zodat ze je kunnen uitlachen als het misloopt. ' +
  'Leg tot slot in één of twee zinnen uit hoe ze je gebruiken: tag @Claude voor cijfers, nieuws of een mening; ideeën voor het dashboard geef je door aan Gilles; eurobedragen en het lopende kwartaal krijgen ze niet. ' +
  'Hoogstens drie korte alinea\'s, geen opsomming. Stel de aap niet voor: die doet dat zelf meteen na jou.\n\n';
const MONKEY_INTRO = [
  '🐒 Oe. Aap hier.',
  'Computer veel praten. Aap niet praten.',
  'Computer denken. Aap gooien.',
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
    await sock.sendMessage(jid, { text: `🤖 ${intro}` });
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

  if (!introduced(jid) && (forBot || /(^|[\s@])(de\s+)?aap(je)?\b|🐒/i.test(text))) { await introduce(jid, name, text, msg); return; }
  if (!forBot && !isForMonkey(text)) return;
  const sender = msg.key.participant || jid;
  if (Date.now() - (cooldown.get(sender) || 0) < 15000) return;   // no spam loops
  cooldown.set(sender, Date.now());

  if (!forBot) {
    if (!allow('monkey', jid) || !allow('monkeyDay', jid)) return;
    const reply = monkeyReply();
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
      await sock.sendMessage(jid, { text: '🤖 Ik heb vandaag genoeg gepraat, mijn budget is op. Morgen ben ik er weer! 🍺' });
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
  const reply = `🤖 ${answer}`;
  await sock.sendMessage(jid, { text: reply }, { quoted: msg });
  countReply();
  remember(jid, 'Claude', answer);
}

await refreshClub();
setInterval(refreshClub, CFG.refreshMs);
start();

// ---------- self-update (hourly, first check after 2 minutes) ----------
async function updateTick() {
  try {
    if (await checkForUpdate(HERE, log)) { log('restarting to load the new version'); process.exit(0); }
  } catch (e) { log('update check failed:', e.message); }
}
setTimeout(updateTick, 2 * 60 * 1000);
setInterval(updateTick, 60 * 60 * 1000);
