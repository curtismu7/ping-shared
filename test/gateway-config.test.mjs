import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const gw = new URL('../pinggateway/', import.meta.url).pathname;
function walk(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}
const files = walk(gw);
const read = (f) => readFileSync(f, 'utf8');
const all = files.map((f) => [relative(gw, f), read(f)]);

test('the gateway folder is the small set we expect', () => {
  assert.deepEqual(files.map((f) => relative(gw, f)).sort(), [
    'config/admin.json', 'config/config.json', 'config/routes/00-health.json', 'config/routes/01-mcp.json',
    'scripts/groovy/health.groovy', 'scripts/groovy/jwks-token-check.groovy',
  ]);
});

test('no AI-DEMO2 identifier, host, product or service name anywhere in the gateway config', () => {
  const banned = [/ai-demo/i, /api\.ping\.demo/i, /\.ping\.demo\b/i, /ping-devops\.com/i, /demo_api_server|demo_authz|demo_mcp/i,
    /\bauthz-server\b/i, /\bmcp-gateway\b/, /\bmcp-server\b/, /\bBFF\b/, /\bbff\b/, /p1az|PingOne Authorize|governance\/pap/i,
    /token-exchange|TokenExchange|introspect/i, /privilege|mcpgw/i, /pg\.tls|certs\/pg-tls/i, /\bjaeger\b|openTelemetry/i];
  for (const [f, body] of all) for (const re of banned) assert.doesNotMatch(body, re, `${f} matches ${re}`);
});

test('no secret, key, credential or tenant id in the gateway config', () => {
  const secrets = [/-----BEGIN/, /\bpassword\b/i, /client_secret|clientSecret|api[_-]?key|private[_-]?key/i, /\beyJ[A-Za-z0-9_-]{15,}/,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, /\.pingone\.(com|eu|ca|asia)/i, /AKIA[0-9A-Z]{16}/];
  for (const [f, body] of all) for (const re of secrets) assert.doesNotMatch(body, re, `${f} matches ${re}`);
});

test('the groovy reads only GATEWAY_* settings', () => {
  for (const [f, body] of all.filter(([f]) => f.endsWith('.groovy'))) {
    const names = [...body.matchAll(/System\.getenv\('([^']+)'\)/g)].map((m) => m[1]);
    for (const n of names) assert.match(n, /^GATEWAY_[A-Z_]+$/, `${f} reads ${n}`);
  }
  const routeEnv = all.filter(([f]) => f.endsWith('.json')).flatMap(([, b]) => [...b.matchAll(/env\['([^']+)'\]/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(routeEnv)], ['GATEWAY_BACKEND_URL']);
});

test('exactly two routes: /health and /mcp, and /mcp runs the JWKS check before it proxies', () => {
  const health = JSON.parse(read(`${gw}config/routes/00-health.json`));
  const mcp = JSON.parse(read(`${gw}config/routes/01-mcp.json`));
  assert.equal(health.condition, "${find(request.uri.path, '^/health$')}");
  assert.equal(mcp.condition, "${find(request.uri.path, '^/mcp(/|$)')}");
  assert.equal(mcp.baseURI, "${env['GATEWAY_BACKEND_URL']}");
  assert.equal(mcp.handler.type, 'Chain');
  assert.equal(mcp.handler.config.filters.length, 1);
  assert.equal(mcp.handler.config.filters[0].config.file, 'jwks-token-check.groovy');
  assert.equal(mcp.handler.config.handler, 'ReverseProxyHandler');
});

test('the token check is fail-closed and checks signature, issuer, audience and expiry', () => {
  const g = read(`${gw}scripts/groovy/jwks-token-check.groovy`);
  assert.match(g, /if \(!issuer \|\| !audience\) return deny\('gateway_not_configured'\)/);
  for (const reason of ['bad_signature', 'issuer_mismatch', 'audience_mismatch', 'token_expired', 'unsupported_alg', 'missing_bearer']) assert.match(g, new RegExp(reason));
  assert.match(g, /SHA256withRSA/);
});

test('admin.json listens on 8080 only, no TLS keystore, no tracing exporter', () => {
  const admin = JSON.parse(read(`${gw}config/admin.json`));
  assert.deepEqual(admin.connectors, [{ port: 8080, host: '0.0.0.0' }]);
  assert.equal(admin.heap, undefined);
});
