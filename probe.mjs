#!/usr/bin/env node
// Rule 20 probe: is a shared product available? It names only what ping-shared owns:
// its own containers, the PingFederate on 4732, and an optional SE PingFederate URL.
//
//   node probe.mjs <product>     exit 0 = reuse ("using shared <product> at ..."), 1 = missing/unhealthy, 2 = unknown product
//   node probe.mjs --all         one line per product; exit 0 always (a status table, not a gate)
//
// A product is healthy when its container is up AND its health endpoint answers an accepted status.
// "Missing" = no container (and nothing else answering where one would be); "unhealthy" = up but not answering.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

export const PRODUCTS = {
  pingfederate: {
    // id-jag-kit-pf is the name scripts/pingfederate-setup.sh and this compose project both use. Any PingFederate
    // that answers on 4732 is reused (one instance per host), whoever started it.
    containers: ['id-jag-kit-pf'],
    adoptIfAnswering: true,
    url: 'https://127.0.0.1:4732/pf/heartbeat.ping',
    ok: [200],
    startHint: 'scripts/ping-shared.sh up pingfederate (needs a licence file; it explains)',
  },
  pinggateway: {
    containers: ['ping-shared-pinggateway'],
    url: 'http://127.0.0.1:7809/health',
    ok: [200],
    startHint: 'scripts/ping-shared.sh up pinggateway (needs GATEWAY_ISSUER and GATEWAY_AUDIENCE in ping-shared/.env)',
    // /health also says whether the token check has its settings.
    note: (body) => {
      try { return JSON.parse(body).tokenCheck === 'configured' ? '' : 'token check NOT configured: /mcp denies everything until GATEWAY_ISSUER and GATEWAY_AUDIENCE are set'; } catch { return ''; }
    },
  },
  'cimd-doc-server': {
    containers: ['ping-shared-cimd-doc-server-1'],
    url: 'http://127.0.0.1:5252/api/health',
    ok: [200],
    startHint: 'docker compose up -d in shared/ping-shared',
  },
  // Optional: a PingFederate on the US SE cluster, for anyone who has no local licence. The URL is YOUR setting
  // (PING_SHARED_SE_PF_URL, a .../pf/heartbeat.ping URL); nothing is built in.
  'pingfederate-se': {
    containers: [],
    urlFromEnv: (env) => env.PING_SHARED_SE_PF_URL || null,
    ok: [200],
    startHint: 'set PING_SHARED_SE_PF_URL to the SE heartbeat URL',
  },
};

export function get(url, { timeout = 3000 } = {}) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, { rejectUnauthorized: false, timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

// Names of the running containers (current Docker context). Docker missing or stopped: nothing is running.
export function runningContainers(exec = execFileSync) {
  try {
    return new Set(exec('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 8000 }).split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}

// -> { state: 'healthy'|'unhealthy'|'missing'|'unconfigured', exit, message }
export async function checkProduct(name, { env = process.env, fetcher = get, running = runningContainers() } = {}) {
  const def = PRODUCTS[name];
  if (!def) return { state: 'unknown', exit: 2, message: `unknown product ${name}` };
  const url = def.urlFromEnv ? def.urlFromEnv(env) : def.url;
  if (!url) return { state: 'unconfigured', exit: 1, message: `${name}: not configured; ${def.startHint}` };
  const up = def.containers.length === 0 || def.containers.some((c) => running.has(c));
  const { status, body } = await fetcher(url);
  const answers = def.ok.includes(status);
  const at = url.replace(/^[a-z]+:\/\/127\.0\.0\.1:/, '127.0.0.1:').replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  if (up && answers) {
    const extra = def.note ? def.note(body) : '';
    return { state: 'healthy', exit: 0, message: `using shared ${name} at ${at}${extra ? ` (${extra})` : ''}` };
  }
  if (!up && answers && def.adoptIfAnswering) {
    return { state: 'healthy', exit: 0, message: `using shared ${name} at ${at} (answering; not started by ping-shared)` };
  }
  if (up) return { state: 'unhealthy', exit: 1, message: `shared ${name} is up but not healthy (${url}, status ${status})` };
  return { state: 'missing', exit: 1, message: `no shared ${name}; offer to start it (never silently): ${def.startHint}` };
}

async function main(argv) {
  const arg = argv[2];
  if (arg === '--all') {
    const running = runningContainers();
    for (const name of Object.keys(PRODUCTS)) {
      const r = await checkProduct(name, { running });
      console.log(`${name.padEnd(16)} ${r.state.padEnd(12)} ${r.message}`);
    }
    return 0;
  }
  const r = await checkProduct(arg);
  (r.exit === 0 ? console.log : console.error)(r.message);
  return r.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv));
}
