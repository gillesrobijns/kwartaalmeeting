// Pipeline runner: lets the laptop run the Kwartaalmeeting pipeline on this server
// without SSH. Every request must be signed with the laptop's private key (CLIENT_PUB
// below is its public half) and is encrypted; the reply is encrypted back. Requests
// older than 5 minutes or seen before are refused. Only the commands in CMDS can run,
// as the bot user, inside <bot folder>/pipeline. The bot's own env (API key) is only
// passed on when a request asks for it explicitly.

import { generateKeyPairSync, createPublicKey, createPrivateKey, diffieHellman, hkdfSync,
  createCipheriv, createDecipheriv, randomBytes, verify, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statfsSync, openSync, closeSync, readSync, fstatSync, chmodSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join, resolve, dirname, sep } from 'node:path';
import { freemem, totalmem, uptime, cpus } from 'node:os';

const CLIENT_PUB = 'MCowBQYDK2VwAyEAkmvCFXqXWFv2Esa9eLNVTPaPLNlg4KfQ991mGtnYwmM=';
const MAX_BODY = 64 * 1024 * 1024;
const MAX_SKEW = 300;                                   // seconds
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64');

export function createPipeline({ hereDir, dataDir, log = console.log }) {
  const PIPE = join(hereDir, 'pipeline');
  const JOBS = join(PIPE, '_jobs');
  mkdirSync(JOBS, { recursive: true });

  const keyFile = join(dataDir, 'pipeline_server_key.json');
  let keys;
  if (existsSync(keyFile)) keys = JSON.parse(readFileSync(keyFile, 'utf8'));
  else {
    const kp = generateKeyPairSync('x25519');
    keys = { pub: b64(kp.publicKey.export({ type: 'spki', format: 'der' })),
             priv: b64(kp.privateKey.export({ type: 'pkcs8', format: 'der' })) };
    writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
    log('pipeline: new server key created');
  }
  const serverPriv = createPrivateKey({ key: unb64(keys.priv), format: 'der', type: 'pkcs8' });
  const clientPub = createPublicKey({ key: unb64(CLIENT_PUB), format: 'der', type: 'spki' });
  const seen = new Map();
  const running = new Map();
  const status = { lastCall: null, lastOp: null, lastError: null };

  const tool = (n) => ['/usr/bin/' + n, '/bin/' + n].find((p) => existsSync(p));
  const CMDS = () => ({
    python3: '/usr/bin/python3', py: join(PIPE, '.venv', 'bin', 'python'), uv: join(PIPE, 'bin', 'uv'),
    ...Object.fromEntries(['ls', 'du', 'df', 'free', 'uname', 'nproc', 'cat', 'tail', 'head', 'sha256sum', 'tar', 'find', 'date'].map((n) => [n, tool(n)])),
  });
  const inPipe = (p) => {
    const full = resolve(PIPE, String(p));
    if (full !== PIPE && !full.startsWith(PIPE + sep)) throw new Error(`path outside pipeline folder: ${p}`);
    return full;
  };
  const childEnv = (extra = {}, withApiKey = false) => ({
    PATH: `${join(PIPE, '.venv', 'bin')}:${join(PIPE, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    HOME: PIPE, LANG: 'C.UTF-8', PYTHONUNBUFFERED: '1', TZ: 'Europe/Brussels',
    ...(withApiKey && process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    ...Object.fromEntries(Object.entries(extra || {}).filter(([k]) => !['PATH', 'HOME'].includes(k)).map(([k, v]) => [k, String(v)])),
  });
  const resolveCmd = (cmd) => {
    if (!Array.isArray(cmd) || !cmd.length) throw new Error('cmd must be a non-empty list');
    const exe = CMDS()[cmd[0]];
    if (!exe) throw new Error(`command not allowed: ${cmd[0]}`);
    return [exe, cmd.slice(1).map(String)];
  };
  const tailOf = (file, n) => {
    if (!existsSync(file)) return '';
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size, len = Math.min(size, n), buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { closeSync(fd); }
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  function startJob(req) {
    const id = String(req.id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!id) throw new Error('start needs an id');
    if (running.has(id)) throw new Error(`job ${id} is still running`);
    const [exe, args] = resolveCmd(req.cmd);
    const out = openSync(join(JOBS, id + '.out'), 'w'), err = openSync(join(JOBS, id + '.err'), 'w');
    const child = spawn(exe, args, { cwd: inPipe(req.cwd || '.'), env: childEnv(req.env, req.withApiKey), stdio: ['ignore', out, err] });
    closeSync(out); closeSync(err);
    const meta = { id, cmd: req.cmd, pid: child.pid, state: 'running', started: new Date().toISOString() };
    const save = () => writeFileSync(join(JOBS, id + '.json'), JSON.stringify(meta, null, 1));
    save();
    running.set(id, child);
    const limit = Math.min(Number(req.timeout || 3600), 4 * 3600) * 1000;
    const timer = setTimeout(() => { meta.state = 'timeout'; child.kill('SIGTERM'); }, limit);
    child.on('error', (e) => { meta.state = 'failed'; meta.error = e.message; save(); log(`pipeline job ${id}: ${e.message}`); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer); running.delete(id);
      if (meta.state === 'running') meta.state = code === 0 ? 'done' : 'failed';
      Object.assign(meta, { code, signal, ended: new Date().toISOString() });
      save();
    });
    return meta;
  }

  // ---------- schedule: pipeline/schedule.json = [{id, days:[1], time:"09:05", cmd, cwd, withApiKey, timeout, lateMinutes}] ----------
  // days use 0=Sunday..6=Saturday, Brussels time. Each entry fires at most once per day; if the bot was down at that
  // time it still fires up to lateMinutes (default 120) later, after that the day is skipped.
  const SCHED = join(PIPE, 'schedule.json'), SSTATE = join(JOBS, 'schedule_state.json');
  const brussels = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
  function tick() {
    let list = [];
    try { list = JSON.parse(readFileSync(SCHED, 'utf8')); } catch { return; }
    let st = {};
    try { st = JSON.parse(readFileSync(SSTATE, 'utf8')); } catch {}
    const now = brussels(), ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const mins = now.getHours() * 60 + now.getMinutes();
    let changed = false;
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || !e.id || !Array.isArray(e.days) || !/^\d\d:\d\d$/.test(e.time || '')) continue;
      if (!e.days.includes(now.getDay()) || st[e.id] === ymd) continue;
      const at = Number(e.time.slice(0, 2)) * 60 + Number(e.time.slice(3));
      if (mins < at) continue;
      st[e.id] = ymd; changed = true;
      if (mins - at > (e.lateMinutes ?? 120)) { log(`pipeline schedule: ${e.id} skipped today (too late)`); continue; }
      try { startJob({ id: `${e.id}-${ymd}`, cmd: e.cmd, cwd: e.cwd, withApiKey: !!e.withApiKey, timeout: e.timeout, env: e.env }); log(`pipeline schedule: started ${e.id}-${ymd}`); }
      catch (err) { log(`pipeline schedule: ${e.id} failed to start: ${err.message}`); }
    }
    if (changed) writeFileSync(SSTATE, JSON.stringify(st, null, 1));
  }
  const timer = setInterval(() => { try { tick(); } catch (e) { log('pipeline schedule:', e.message); } }, 30 * 1000);
  if (timer.unref) timer.unref();

  async function handle(req) {
    switch (req.op) {
      case 'ping': {
        const fs = statfsSync(hereDir);
        return { pipe: PIPE, node: process.version, uptime_s: Math.round(uptime()), cpus: cpus().length,
          mem_free_mb: Math.round(freemem() / 1048576), mem_total_mb: Math.round(totalmem() / 1048576),
          disk_free_mb: Math.round(fs.bavail * fs.bsize / 1048576),
          cmds: Object.fromEntries(Object.entries(CMDS()).map(([k, v]) => [k, !!v && existsSync(v)])) };
      }
      case 'put': {
        const out = [];
        for (const f of req.files || []) {
          const full = inPipe(f.path), data = unb64(f.b64);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full + '.part', data);
          renameSync(full + '.part', full);
          if (f.mode) chmodSync(full, parseInt(f.mode, 8));
          out.push({ path: f.path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
        }
        return out;
      }
      case 'get':
        return (req.paths || []).map((p) => {
          try { const d = readFileSync(inPipe(p)); return { path: p, b64: b64(d), bytes: d.length }; }
          catch (e) { return { path: p, error: e.message }; }
        });
      case 'run': {
        const [exe, args] = resolveCmd(req.cmd);
        const timeout = Math.min(Number(req.timeout || 120), 600) * 1000;
        return await new Promise((ok) => execFile(exe, args,
          { cwd: inPipe(req.cwd || '.'), env: childEnv(req.env, req.withApiKey), timeout, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout, stderr) => ok({ code: err ? (err.code ?? (err.killed ? 'timeout' : 1)) : 0, stdout, stderr })));
      }
      case 'start': return startJob(req);
      case 'poll': {
        const id = String(req.id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
        const f = join(JOBS, id + '.json');
        if (!existsSync(f)) throw new Error(`no job ${id}`);
        const meta = JSON.parse(readFileSync(f, 'utf8'));
        if (meta.state === 'running' && !running.has(id) && !alive(meta.pid)) meta.state = 'lost (bot restarted?)';
        const n = Number(req.tail || 4000);
        return { ...meta, out: tailOf(join(JOBS, id + '.out'), n), err: tailOf(join(JOBS, id + '.err'), n) };
      }
      case 'stop': {
        const child = running.get(String(req.id));
        if (!child) return { stopped: false };
        child.kill('SIGTERM');
        return { stopped: true };
      }
      default: throw new Error(`unknown op: ${req.op}`);
    }
  }

  function readBody(req) {
    return new Promise((ok, fail) => {
      const parts = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { fail(new Error('too large')); req.destroy(); } else parts.push(c); });
      req.on('end', () => ok(Buffer.concat(parts)));
      req.on('error', fail);
    });
  }

  async function http(req, res) {
    if (req.url === '/pipeline/key' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ pub: keys.pub }));
      return true;
    }
    if (req.url !== '/pipeline' || req.method !== 'POST') return false;
    const deny = (why) => { status.lastError = why; res.writeHead(403, { 'content-type': 'text/plain' }); res.end('refused'); return true; };
    let env;
    try { env = JSON.parse((await readBody(req)).toString('utf8')); } catch { return deny('bad body'); }
    const now = Date.now() / 1000;
    if (env.v !== 1 || Math.abs(now - Number(env.ts)) > MAX_SKEW) return deny('stale or bad version');
    if (seen.has(env.nonce)) return deny('replayed');
    const signed = createHash('sha256').update(`${env.ts}.${env.nonce}.${env.epk}.${env.iv}.${env.ct}`).digest();
    let okSig = false;
    try { okSig = verify(null, signed, clientPub, unb64(env.sig)); } catch {}
    if (!okSig) return deny('bad signature');
    seen.set(env.nonce, now);
    for (const [k, t] of seen) if (now - t > 2 * MAX_SKEW) seen.delete(k);

    const epk = createPublicKey({ key: unb64(env.epk), format: 'der', type: 'spki' });
    const shared = diffieHellman({ privateKey: serverPriv, publicKey: epk });
    const km = Buffer.from(hkdfSync('sha256', shared, unb64(env.nonce), 'km-pipeline-v1', 64));
    const reqKey = km.subarray(0, 32), respKey = km.subarray(32);
    let reply;
    try {
      const ct = unb64(env.ct), d = createDecipheriv('aes-256-gcm', reqKey, unb64(env.iv));
      d.setAuthTag(ct.subarray(ct.length - 16));
      const body = JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
      status.lastCall = new Date().toISOString(); status.lastOp = body.op;
      reply = { ok: true, result: await handle(body) };
    } catch (e) {
      reply = { ok: false, error: e.message };
    }
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', respKey, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(reply), 'utf8'), c.final(), c.getAuthTag()]);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ iv: b64(iv), ct: b64(enc) }));
    return true;
  }

  return { http, status, dir: PIPE };
}
