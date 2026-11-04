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
  'cimd-doc-server': {
    container: 'ping-shared-cimd-doc-server-1',
    url: 'http://127.0.0.1:5252/api/health',
    port: 5252,
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
  // ── AI-DEMO2 MCP / resource-server stack (rule 20: adopted, never re-spawned) ──
  // These are enforcement/data-plane services another demo may already run. Any HTTP answer
  // (200/401/404/405) proves the endpoint is up; auth challenges are healthy by definition.
  'mcp-server': {
    container: 'ai-demo-mcp-server',
    url: 'http://127.0.0.1:8080/',
    port: 8080,
    ok: [200, 401, 404, 405],
  },
  'mcp-gateway': {
    container: 'ai-demo-mcp-gateway',
    url: 'http://127.0.0.1:3005/health',
    port: 3005,
    ok: [200, 401, 404, 405],
  },
  'mcp-resource-server': {
    // Loopback-only publish; the token-protected API for the MCP tool calls.
    container: 'ai-demo-mcp-resource-server',
    url: 'http://127.0.0.1:8081/',
    port: 8081,
    ok: [200, 401, 404, 405],
  },
  'mcp-jwt-verifier': {
    container: 'ai-demo-mcp-jwt-verifier',
    url: 'http://127.0.0.1:8083/health',
    port: 8083,
    ok: [200, 401, 404, 405],
  },
  'api-resource-server': {
    // The banking API the demos call (loopback 8082).
    container: 'ai-demo-api-resource-server',
    url: 'http://127.0.0.1:8082/health',
    port: 8082,
    ok: [200, 401, 404, 405],
  },
  'authz-server': {
    container: 'ai-demo-authz-server',
    url: 'http://127.0.0.1:9001/health',
    port: 9001,
    ok: [200, 401, 404, 405],
  },
  'mcp-proxy': {
    container: 'ai-demo-mcp-proxy',
    url: 'http://127.0.0.1:8895/',
    port: 8895,
    ok: [200, 401, 404, 405],
  },
  'mcp-audit': {
    container: 'ai-demo-mcp-audit',
    url: 'http://127.0.0.1:8898/',
    port: 8898,
    ok: [200, 401, 404, 405],
  },
  'llm-proxy': {
    // The local LLM proxy: a shared model endpoint for any lab's Real mode.
    container: 'ai-demo-llm-proxy',
    url: 'http://127.0.0.1:8090/health',
    port: 8090,
    ok: [200, 401, 404, 405],
  },
  'mcp-code-search': {
    container: 'ai-demo-mcp-code-search',
    url: 'http://127.0.0.1:8095/',
    port: 8095,
    ok: [200, 401, 404, 405],
  },
  'opensearch-mcp-server': {
    container: 'ai-demo-opensearch-mcp-server',
    url: 'http://127.0.0.1:9900/',
    port: 9900,
    ok: [200, 401, 404, 405],
  },
  'mcp-weather': {
    container: 'ai-demo-mcp-weather',
    url: 'http://127.0.0.1:8896/',
    port: 8896,
    ok: [200, 401, 404, 405],
  },
  'mcp-brave': {
    container: 'ai-demo-mcp-brave',
    url: 'http://127.0.0.1:8897/',
    port: 8897,
    ok: [200, 401, 404, 405],
  },
  'bff': {
    // The BFF (demo_api_server): session custodian and OAuth client for the demo UI.
    // TLS-terminated at the container (https on 3001; plain http answers nothing).
    container: 'ai-demo-api-server',
    url: 'https://local.ping-devops.com:3001/api/health',
    port: 3001,
    ok: [200],
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
