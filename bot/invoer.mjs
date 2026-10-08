// Transacties doorgeven via WhatsApp (alleen in een privégesprek met de bot).
//
// Een lid stuurt een screenshot van zijn broker of typt wat hij kocht of verkocht.
// 1. Haiku leest het (goedkoop). Twijfelt Haiku, kent hij het aandeel niet of klopt er iets niet,
//    dan leest Sonnet het opnieuw.
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
const MODELS = { fast: 'claude-haiku-5-5', strong: 'claude-sonnet-5-5' };
// $ per miljoen tokens (platform.claude.com/docs/en/about-claude/pricing, okt 2026)
const PRICE = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.10, cw: 2.5 },
};
const LIMITS = { perPersonDay: 25, totalDay: 120 };              // leesbeurten (Haiku + Sonnet samen)
const PENDING_TTL = 24 * 3600 * 1000;
const IMAGE_TTL = 60 * 60 * 1000;
const TX_WORDS = /\b(ge|aan|bij)?(kocht|koop|aankoop|verkocht|verkoop|bought|sold|buy|sell)\b|\bdividend/i;
const YES = /^\s*(ja+|jaja|jep|yes|ok(e|é|ay)?|klopt|correct|juist|in orde|doe maar|top|perfect|👍|✅)[\s!.👍✅]*$/iu;
const NO = /^\s*(nee+|neen|stop|annuleer|annuleren|laat maar|cancel|❌)[\s!.]*$/iu;

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
          },
          required: ['type', 'aandeel', 'in_lijst', 'aantal', 'totaal_eur', 'munt_gezien', 'datum'],
        },
      },
      onduidelijk: { type: 'array', items: { type: 'string' }, description: 'Wat je niet zeker weet of wat ontbreekt, als korte vragen in het Nederlands aan het lid.' },
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
  `- Buy = aankoop, Sell = verkoop, Dividend = ontvangen dividend.\n` +
  `- totaal_eur is het TOTAAL in euro, niet de koers per aandeel. Bij een aankoop: inclusief makelaarsloon en beurstaks. Bij een verkoop: wat er netto binnenkwam. Bij dividend: het netto bedrag na roerende voorheffing.\n` +
  `- Staat het totaal alleen in een andere munt (bv. dollar), zet totaal_eur op null en munt_gezien op die munt. Reken zelf NIET om.\n` +
  `- Staat er geen totaal maar wel aantal en koers in euro, reken dan aantal x koers uit en meld in "onduidelijk" dat de kosten er niet in zitten.\n` +
  `- Gebruik voor "aandeel" de naam uit de AANDELENLIJST hieronder als het hetzelfde bedrijf of fonds is (bv. "ASML Holding NV" wordt "ASML").\n` +
  `- Verzin niets. Wat je niet ziet, is null, en je zet een vraag in "onduidelijk".\n` +
  `- Een portefeuilleoverzicht (posities en waarde) is GEEN transactie.\n` +
  `- Komt er een vorige versie en een correctie van het lid mee, pas dan de vorige versie aan volgens de correctie. Wat het lid zegt, gaat voor op de afbeelding.\n` +
  `- "onduidelijk" bevat ALLEEN vragen die echt nog open staan, kort en aan het lid gericht ("je"). Is alles duidelijk, laat het leeg. Herhaal niet wat het lid al zei en leg niet uit wat je deed.`;

export function createInvoer({ anthropic, getSock, log, dataDir, hereDir, adminJid, claudeTag = '🤖 Claude: ' }) {
  const STATE_FILE = join(dataDir, 'invoer.json');
  const USAGE_FILE = join(dataDir, 'invoer_usage.json');
  const QUEUE_FILE = join(dataDir, 'invoer_queue.json');
  const load = (f, d) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d; } catch { return d; } };
  const save = (f, obj) => { writeFileSync(`${f}.tmp`, JSON.stringify(obj, null, 1)); renameSync(`${f}.tmp`, f); };
  let state = load(STATE_FILE, {});
  state.members ||= {}; state.pending ||= {}; state.day ||= {};
  const saveState = () => save(STATE_FILE, state);
  const images = new Map();                                       // jid -> { images, at } (alleen in het geheugen)

  const config = () => load(join(hereDir, 'invoer_config.json'), {});
  const token = () => createHash('sha256').update(`kwartaal-invoer|${process.env.ANTHROPIC_API_KEY || ''}`).digest('hex').slice(0, 32);
  const send = (jid, text) => getSock().sendMessage(jid, { text: claudeTag + text });

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
  async function read({ model, member, text, imgs, previous, correction }) {
    const parts = [];
    for (const i of imgs || []) parts.push({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } });
    let prompt = `Vandaag is het ${today()}.\n`;
    if (previous) prompt += `\nVORIGE VERSIE (die jij eerder las):\n${JSON.stringify(previous)}\n\nCORRECTIE VAN HET LID: "${correction}"\n`;
    else prompt += `\nBericht van het lid: "${text || '(alleen een afbeelding)'}"\n`;
    parts.push({ type: 'text', text: prompt });
    const req = {
      model,
      max_tokens: 2000,
      system: [
        { type: 'text', text: RULES },
        { type: 'text', text: `AANDELENLIJST (namen zoals in de sheets van de club):\n${stockList().join('\n')}`, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL],
      messages: [{ role: 'user', content: parts }],
    };
    if (model === MODELS.strong) req.thinking = { type: 'between_tools' };   // Sonnet 5.5: geen gedwongen tool_choice
    else req.tool_choice = { type: 'any' };
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

  async function readSmart(args, jid, forceStrong = false) {
    let r = null;
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
      return `${r.rijen.length > 1 ? `${i + 1}. ` : ''}${what}${x.in_lijst ? '' : ' (nieuw aandeel voor de club)'}`;
    });
    const pr = problems(r);
    const ask = pr.length ? pr : (r.onduidelijk || []).slice(0, 3);
    let t = `Dit zet ik in de sheet van ${member}:\n${lines.join('\n')}`;
    if (pr.length) t += `\n\nNog even checken:\n${ask.map((q) => `• ${q}`).join('\n')}\n\nAntwoord gewoon met wat ontbreekt.`;
    else if (ask.length) t += `\n\nNog even checken:\n${ask.map((q) => `• ${q}`).join('\n')}\n\nKlopt alles? Antwoord *ja*, of zeg wat er anders moet.`;
    else t += `\n\nKlopt dit? Antwoord *ja*, of zeg wat er anders moet. *stop* om te annuleren.`;
    return t;
  }

  // ---------- schrijven ----------
  async function write(jid, member, rows) {
    const url = config().webapp_url;
    if (!url) {
      const q = load(QUEUE_FILE, []);
      q.push({ member, rows, at: new Date().toISOString() });
      save(QUEUE_FILE, q);
      const a = adminJid();
      if (a) await getSock().sendMessage(a, { text: claudeTag + `📥 ${member} gaf via WhatsApp door (nog niet automatisch in de sheet, zet het er zelf in):\n` +
        rows.map((x) => `• ${TYPE_NL[x.type]} ${x.type === 'Dividend' ? '' : `${num(x.shares)} × `}${x.stock} · ${eur(x.total_eur)} · ${dmy(x.date)}`).join('\n') }).catch(() => {});
      return { queued: true };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },                // Apps Script: geen CORS-preflight nodig
      body: JSON.stringify({ token: token(), action: 'append', member, source: 'WhatsApp', rows }),
      redirect: 'follow',
    });
    const txt = await res.text();
    let out; try { out = JSON.parse(txt); } catch { throw new Error(`webapp gaf geen JSON (HTTP ${res.status})`); }
    if (!out.ok) throw new Error(out.error || 'webapp weigerde');
    return out;
  }

  // ---------- gesprek ----------
  async function handle({ jid, name, text, imgs = [] }) {
    const raw = (text || '').trim();
    const isAdmin = jid === adminJid();
    if (isAdmin && /^\/invoer\b/i.test(raw)) { await send(jid, report()); return true; }

    const p = state.pending[jid];
    if (p && Date.now() - p.at > PENDING_TTL) { delete state.pending[jid]; saveState(); }
    const pending = state.pending[jid];
    const member = state.members[jid] || (isAdmin ? 'Gilles' : null);

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
        state.pending[jid] = { stage: 'voorstel', member: pick, r: saved.r, at: Date.now(), tries: 0 };
        saveState();
        await send(jid, `Dag ${pick}, genoteerd.\n\n${proposal(pick, saved.r)}`);
      } else { saveState(); await send(jid, `Dag ${pick}, genoteerd.`); }
      return true;
    }

    // Een voorstel staat open: ja / stop / correctie
    if (pending?.stage === 'voorstel') {
      if (NO.test(raw)) { delete state.pending[jid]; saveState(); await send(jid, 'Oké, niets ingegeven.'); return true; }
      if (YES.test(raw)) {
        if (problems(pending.r).length) { await send(jid, `Er ontbreekt nog iets:\n${problems(pending.r).map((q) => `• ${q}`).join('\n')}`); return true; }
        const rows = pending.r.rijen.map((x) => ({ type: x.type, stock: x.aandeel, shares: x.type === 'Dividend' ? null : x.aantal, total_eur: x.totaal_eur, date: x.datum }));
        delete state.pending[jid]; saveState();
        try {
          const out = await write(jid, pending.member, rows);
          if (out.queued) await send(jid, '✅ Goedgekeurd. Gilles zet het in je sheet; de maandagscan neemt het daarna mee.');
          else {
            const done = (out.results || []).filter((x) => x.status === 'written').length;
            const dup = (out.results || []).filter((x) => x.status === 'duplicate').length;
            let t = done ? `✅ Staat in je sheet${done > 1 ? ` (${done} rijen)` : ''}. De maandagscan neemt het mee.` : '';
            if (dup) t += `${t ? '\n' : ''}${dup > 1 ? `${dup} rijen stonden` : 'Die rij stond'} al in je sheet, dus niets dubbel ingegeven.`;
            await send(jid, t || 'Niets ingegeven.');
            const a = adminJid();
            if (a && a !== jid && done) getSock().sendMessage(a, { text: claudeTag + `📥 ${pending.member} gaf ${done} transactie${done > 1 ? 's' : ''} door via WhatsApp: ${[...new Set(rows.map((x) => x.stock))].join(', ')}` }).catch(() => {});
          }
        } catch (e) {
          log('invoer write:', e.message);
          await send(jid, 'Het lukte niet om het in je sheet te zetten. Ik heb Gilles verwittigd; probeer het later nog eens of zet het er zelf in.');
          const a = adminJid();
          if (a) getSock().sendMessage(a, { text: claudeTag + `⚠️ Invoer voor ${pending.member} mislukt: ${e.message}` }).catch(() => {});
        }
        return true;
      }
      // Correctie of aanvulling
      if (!budgetOk(jid)) { await send(jid, 'Genoeg gelezen voor vandaag. Morgen weer, of zet het zelf in je sheet.'); return true; }
      await getSock().sendPresenceUpdate('composing', jid).catch(() => {});
      const r = await readSmart({ member: pending.member, imgs: images.get(jid)?.images || [], previous: pending.r, correction: raw }, jid, (pending.tries || 0) >= 1);
      saveState();
      if (!r || !r.rijen?.length) { await send(jid, 'Dat begrijp ik niet goed. Zeg wat er anders moet, of *stop*.'); return true; }
      state.pending[jid] = { ...pending, r, at: Date.now(), tries: (pending.tries || 0) + 1 };
      saveState();
      await send(jid, proposal(pending.member, r));
      return true;
    }

    // Nieuw bericht: is het een transactie?
    if (!imgs.length && !(TX_WORDS.test(raw) && /\d/.test(raw))) return false;
    if (imgs.length) images.set(jid, { images: imgs, at: Date.now() }); else images.delete(jid);   // een nieuwe transactie: oude screenshot vergeten
    for (const [j, v] of images) if (Date.now() - v.at > IMAGE_TTL) images.delete(j);
    if (!budgetOk(jid)) return false;

    await getSock().sendPresenceUpdate('composing', jid).catch(() => {});
    const r = await readSmart({ member, text: raw, imgs }, jid);
    saveState();
    if (!r || !r.is_transactie || !r.rijen?.length) return false;   // gewoon gesprek: Claude antwoordt zoals altijd

    if (!member) {
      state.pending[jid] = { stage: 'wie', at: Date.now(), saved: { r } };
      saveState();
      await send(jid, `Ik zie een transactie, maar ik ken je nummer nog niet. Wie ben je? Antwoord met je voornaam: ${MEMBERS.join(', ')}.`);
      return true;
    }
    state.pending[jid] = { stage: 'voorstel', member, r, at: Date.now(), tries: 0 };
    saveState();
    await send(jid, proposal(member, r));
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

  return { handle, report, _internals: { read, problems, proposal, readSmart, needsStrong } };
}
