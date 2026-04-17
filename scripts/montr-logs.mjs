#!/usr/bin/env node
// Zero-dependency CLI for pulling Montr server and client logs.
// Auth via MONTR_API_KEY (X-API-Key header) plus MONTR_SERVER_URL.
// Values can come from the real env or a .env file in the current directory.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SIZES = {
  '10k': 10240,
  '100k': 102400,
  '1m': 1048576,
  '5m': 5242880,
};

function loadDotenv(cwd) {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function die(msg, code = 1) {
  process.stderr.write(`montr-logs: ${msg}\n`);
  process.exit(code);
}

function ensureEnv() {
  const url = process.env.MONTR_SERVER_URL;
  const key = process.env.MONTR_API_KEY;
  if (!url) die('MONTR_SERVER_URL is not set (e.g. https://montr.example.com)');
  if (!key) die('MONTR_API_KEY is not set');
  return { url: url.replace(/\/+$/, ''), key };
}

async function request(method, pathname, { body, headers = {} } = {}) {
  const { url, key } = ensureEnv();
  const res = await fetch(`${url}${pathname}`, {
    method,
    headers: {
      'X-API-Key': key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function readBodyText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function cmdServer(flags) {
  const params = new URLSearchParams();
  if (flags.lines) params.set('lines', String(flags.lines));
  if (flags.level) params.set('level', String(flags.level));
  if (flags.since) params.set('since', String(flags.since));
  const qs = params.toString();
  const res = await request('GET', `/api/admin/logs/server${qs ? `?${qs}` : ''}`);
  const text = await readBodyText(res);
  if (!res.ok) die(`HTTP ${res.status}: ${text.trim() || res.statusText}`, 2);
  process.stdout.write(text);
}

async function cmdClients() {
  const res = await request('GET', '/api/clients');
  const text = await readBodyText(res);
  if (!res.ok) die(`HTTP ${res.status}: ${text.trim() || res.statusText}`, 2);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    die(`expected JSON from /api/clients, got: ${text.slice(0, 200)}`, 2);
  }
  const rows = Array.isArray(payload?.data) ? payload.data : payload;
  if (!Array.isArray(rows)) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  for (const c of rows) {
    const id = c.id ?? c.client_id ?? '?';
    const name = c.name ?? '(no name)';
    const online = c.online === true || c.status === 'online' ? 'online' : 'offline';
    const last = c.last_seen ?? c.last_heartbeat ?? c.updated_at ?? '';
    process.stdout.write(`${id}\t${online}\t${last}\t${name}\n`);
  }
}

async function cmdClient(positional, flags) {
  const id = positional[0];
  if (!id) die('usage: client <id> [--lines N] [--live [--size 10k|100k|1m|5m]]');

  if (flags.live) {
    const sizeKey = String(flags.size || '10k').toLowerCase();
    const maxBytes = SIZES[sizeKey];
    if (!maxBytes) {
      die(`--size must be one of: ${Object.keys(SIZES).join(', ')}`);
    }
    process.stderr.write(`requesting live log tail (${sizeKey}) from ${id} ...\n`);
    const res = await request('POST', `/api/telemetry/clients/${encodeURIComponent(id)}/logs/fetch`, {
      body: { max_bytes: maxBytes },
    });
    const text = await readBodyText(res);
    if (!res.ok) die(`HTTP ${res.status}: ${text.trim() || res.statusText}`, 2);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      die(`expected JSON response, got: ${text.slice(0, 200)}`, 2);
    }
    const tail = payload?.data?.bytes ?? payload?.bytes ?? '';
    process.stdout.write(tail);
    if (tail && !tail.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  const params = new URLSearchParams();
  if (flags.lines) params.set('limit', String(flags.lines));
  if (flags.level) params.set('level', String(flags.level));
  const qs = params.toString();
  const res = await request(
    'GET',
    `/api/telemetry/clients/${encodeURIComponent(id)}/logs${qs ? `?${qs}` : ''}`
  );
  const text = await readBodyText(res);
  if (!res.ok) die(`HTTP ${res.status}: ${text.trim() || res.statusText}`, 2);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    die(`expected JSON response, got: ${text.slice(0, 200)}`, 2);
  }
  const rows = Array.isArray(payload?.data) ? payload.data : payload;
  if (!Array.isArray(rows)) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  for (const r of rows) {
    const ts = r.ts ?? r.timestamp ?? r.created_at ?? '';
    const level = (r.level ?? '').toString().toUpperCase();
    const msg = r.message ?? r.msg ?? '';
    process.stdout.write(`${ts}\t${level}\t${msg}\n`);
  }
}

function printHelp() {
  process.stdout.write(
    [
      'montr-logs — pull logs from a Montr server for diagnostics.',
      '',
      'env:',
      '  MONTR_SERVER_URL   e.g. https://montr.example.com',
      '  MONTR_API_KEY      must match the server\'s API_KEY',
      '  (a .env file in the current directory is also loaded)',
      '',
      'commands:',
      '  server [--lines N] [--level warn|error|info|debug] [--since ISO]',
      '      tail of the server\'s own log file as plain text.',
      '',
      '  clients',
      '      list registered clients (id / status / last-seen / name).',
      '',
      '  client <id> [--lines N] [--level warn|error]',
      '      recent WARN/ERROR events auto-pushed from a client (from DB).',
      '',
      '  client <id> --live [--size 10k|100k|1m|5m]',
      '      pull the live tail of a connected client\'s log file (default 10k).',
      '',
      'examples:',
      '  node scripts/montr-logs.mjs server --lines 500 --level error',
      '  node scripts/montr-logs.mjs clients',
      '  node scripts/montr-logs.mjs client pi-lobby --live --size 100k',
      '',
    ].join('\n')
  );
}

async function main() {
  loadDotenv(process.cwd());

  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);

  if (flags.help || positional[0] === 'help' || positional.length === 0) {
    printHelp();
    return;
  }

  const cmd = positional[0];
  const rest = positional.slice(1);
  switch (cmd) {
    case 'server':
      await cmdServer(flags);
      return;
    case 'clients':
      await cmdClients();
      return;
    case 'client':
      await cmdClient(rest, flags);
      return;
    default:
      die(`unknown command: ${cmd} (try --help)`);
  }
}

main().catch((err) => {
  die(err?.message || String(err));
});
