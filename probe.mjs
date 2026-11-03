#!/usr/bin/env node
// Rule 20 probe: is a shared product available? Exit 0 = reuse, 1 = missing/unhealthy, 2 = unknown product.
// Usage: node probe.mjs <product>
// Products are "shared and healthy" when the container is up AND its health endpoint answers.
// Accepted statuses per product: some endpoints answer 200, others 401 (auth required = up).
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';

const HEALTH = {
  pingfederate: {
    container: 'ai-demo-pingfederate',
    url: 'https://127.0.0.1:9031/pf/heartbeat.ping',
    port: 9031,
    ok: [200],
  },
  pinggateway: {
    container: 'ai-demo-ping-gateway',
    url: 'https://127.0.0.1:3036/mcp',
    port: 3036,
    // 401 = the enforcement point is up and asking for auth; that is healthy.
    ok: [200, 401, 405],
  },
  'privilege-gateway': {
    // The Privilege Agent Gateway (ping-mcpgw / procyon). Its MCP listener on
    // 8623 answers 200 with the MCP server page; 8620/8690 need auth or nothing.
    container: 'ai-demo-ping-mcpgw',
    url: 'http://127.0.0.1:8623/',
    port: 8623,
    ok: [200],
  },
  // pingone is SaaS: no container. Health = the environment answers a discovery
  // request; the environment id comes from the shared env file (rule 94).
  pingone: {
    container: null,
    env: ['PINGONE_ENVIRONMENT_ID', 'PINGONE_REGION'],
    urlFromEnv: (env) => {
      const id = env.PINGONE_ENVIRONMENT_ID;
      if (!id) return null;
      // Region aliases per the family convention: na/us map to com (pingone-lab settings.js).
      const ALIAS = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' };
      const region = ALIAS[String(env.PINGONE_REGION || 'com').toLowerCase()] || 'com';
      return `https://auth.pingone.${region}/${id}/as/.well-known/openid-configuration`;
    },
    ok: [200],
  },
  // PingOne Privilege (SaaS console). The URL comes from the shared env file:
  // PRIVILEGE_CONSOLE_URL (default: the public console host). Users point at
  // their own tenant; ping-shared never ships the console.
  'pingone-privilege': {
    container: null,
    env: ['PRIVILEGE_CONSOLE_URL'],
    urlFromEnv: (env) => env.PRIVILEGE_CONSOLE_URL || 'https://console.privilege.pingone.com/',
    ok: [200, 302, 401, 403],
  },
};

function get(url) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, { rejectUnauthorized: false, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

function loadSharedEnv() {
  // Rule 94: the family's one shared settings file, ~/Development/.env.
  const path = `${process.env.HOME}/Development/.env`;
  const env = { ...process.env };
  try {
    const text = fs.readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no shared env file: pingone probe reports not configured */ }
  return env;
}

const name = process.argv[2];
const def = HEALTH[name];
if (!def) { console.error(`unknown product ${name}`); process.exit(2); }

const env = loadSharedEnv();
const url = def.urlFromEnv ? def.urlFromEnv(env) : def.url;
if (!url) { console.error(`${name}: not configured in the shared env file (~/Development/.env)`); process.exit(1); }

function containerUp() {
  if (!def.container) return true;
  try {
    const st = execFileSync('docker', ['--context', 'orbstack', 'ps', '-a', '--filter', `name=^${def.container}$`, '--format', '{{.Status}}'], { encoding: 'utf8' }).trim();
    return st.startsWith('Up');
  } catch { return false; }
}

const up = containerUp();
const code = await get(url);
const ok = def.ok.includes(code);
if (up && ok) { console.log(`using shared ${name} at ${url.replace(/^[a-z]+:\/\/127\.0\.0\.1:/, '127.0.0.1:')}`); process.exit(0); }
if (up) { console.error(`shared ${name} container is up but not healthy (${url}, status ${code})`); process.exit(1); }
console.error(`no shared ${name}; offer to start it (never silently)`);
process.exit(1);
