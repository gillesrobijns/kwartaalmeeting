// Self-update: once an hour the bot compares its files with the "bot" folder on the
// club's GitHub Pages site. Changed files are downloaded, checked against the
// manifest hash, syntax-checked, written, and the bot restarts (systemd brings it back).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.UPDATE_URL || 'https://gillesrobijns.github.io/kwartaalmeeting/bot/';
const ALLOWED = new Set(['bot.mjs', 'clubdata.mjs', 'updater.mjs', 'pricewatch.mjs', 'persona.md', 'package.json', 'claude_strategie.md', 'tickers.json']);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export async function checkForUpdate(dir, log = console.log) {
  const res = await fetch(`${BASE}manifest.json?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const manifest = await res.json();
  const changed = (manifest.files || []).filter((f) => {
    if (!ALLOWED.has(f.name)) return false;
    const p = join(dir, f.name);
    return !existsSync(p) || sha(readFileSync(p)) !== f.sha256;
  });
  if (!changed.length) return false;

  const tmp = mkdtempSync(join(tmpdir(), 'kwartaal-update-'));
  const downloads = [];
  for (const f of changed) {
    const r = await fetch(`${BASE}${f.name}?v=${encodeURIComponent(manifest.version || Date.now())}`, { headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error(`${f.name} HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (sha(buf) !== f.sha256) throw new Error(`${f.name}: hash does not match manifest (CDN still stale?)`);
    if (f.name.endsWith('.mjs')) {                       // never install code that does not parse
      const t = join(tmp, f.name);
      writeFileSync(t, buf);
      execFileSync(process.execPath, ['--check', t]);
    }
    downloads.push([f, buf]);
  }
  for (const [f, buf] of downloads) writeFileSync(join(dir, f.name), buf);
  if (downloads.some(([f]) => f.name === 'package.json')) {
    execFileSync(join(dirname(process.execPath), 'npm'), ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  }
  log(`updated to ${manifest.version}: ${downloads.map(([f]) => f.name).join(', ')}`);
  return true;
}
