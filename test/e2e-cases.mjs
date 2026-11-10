// Runs INSIDE the test network (see e2e-gateway.sh): drives the real PingGateway container through the token cases.
// Env: GW (gateway base URL), GW_OPEN (a second, unconfigured gateway), ISSUER_BASE (fake issuer base URL).
import assert from 'node:assert/strict';

const GW = process.env.GW;
const GW_OPEN = process.env.GW_OPEN;
const ISSUER_BASE = process.env.ISSUER_BASE;
const AUD = 'https://mcp.example/';
// Tokens are minted by the fake issuer (it owns the keys): mint({aud, iss, scope, expIn, nbfIn, alg, key, kid}).
async function mint(opts = {}) {
  const q = new URLSearchParams(Object.entries(opts).map(([k, v]) => [k, String(v)]));
  return (await fetch(`${ISSUER_BASE}/mint?${q}`)).text();
}
let n = 0;
async function call(base, path, { token, method = 'POST' } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, www: res.headers.get('www-authenticate') };
}
async function check(name, fn) { await fn(); n += 1; console.log(`ok ${n} ${name}`); }
async function hits() { return (await (await fetch(`${ISSUER_BASE}/hits`)).json()).hits; }

await check('/health is 200, demo-health/1, tokenCheck configured', async () => {
  const r = await call(GW, '/health', { method: 'GET' });
  assert.equal(r.status, 200); assert.equal(r.json.schema, 'demo-health/1'); assert.equal(r.json.tokenCheck, 'configured');
});
await check('a valid token reaches the backend', async () => {
  const before = await hits();
  const r = await call(GW, '/mcp', { token: await mint({ aud: AUD }) });
  assert.equal(r.status, 200); assert.equal(r.json.backend, 'reached'); assert.equal(r.json.hasAuthorization, true);
  assert.equal(await hits(), before + 1);
});
const denied = {
  'no token': [undefined, 'missing_bearer'],
  'garbage token': ['abc.def', 'malformed_jwt'],
  'wrong audience': [await mint({ aud: 'https://other.example/' }), 'audience_mismatch'],
  'wrong issuer': [await mint({ iss: 'http://elsewhere.invalid' }), 'issuer_mismatch'],
  'expired': [await mint({ expIn: -600 }), 'token_expired'],
  'not yet valid': [await mint({ nbfIn: 600 }), 'token_not_yet_valid'],
  'signed by another key (same kid)': [await mint({ key: 'other' }), 'bad_signature'],
  'unknown kid': [await mint({ kid: 'nope' }), 'no_matching_key'],
  'alg none': [await mint({ alg: 'none' }), 'unsupported_alg'],
  'alg HS256': [await mint({ alg: 'HS256' }), 'unsupported_alg'],
  'missing required scope': [await mint({ scope: 'something:else' }), 'insufficient_scope'],
};
for (const [name, [token, reason]] of Object.entries(denied)) {
  await check(`401 ${reason}: ${name}`, async () => {
    const before = await hits();
    const r = await call(GW, '/mcp', { token });
    assert.equal(r.status, 401); assert.equal(r.json.reason, reason); assert.match(r.www || '', /^Bearer /);
    assert.equal(await hits(), before, 'a denied request must not reach the backend');
  });
}
await check('/mcp/sub/path is also checked', async () => {
  assert.equal((await call(GW, '/mcp/x')).status, 401);
});
await check('any other path is 404, not proxied', async () => {
  const before = await hits();
  const r = await call(GW, '/admin', { token: await mint({ aud: AUD }), method: 'GET' });
  assert.equal(r.status, 404);
  assert.equal(await hits(), before);
});
await check('the unconfigured gateway says so and denies everything', async () => {
  const h = await call(GW_OPEN, '/health', { method: 'GET' });
  assert.equal(h.status, 200); assert.equal(h.json.tokenCheck, 'not_configured');
  const before = await hits();
  const r = await call(GW_OPEN, '/mcp', { token: await mint({ aud: AUD }) });
  assert.equal(r.status, 401); assert.equal(r.json.reason, 'gateway_not_configured');
  assert.equal(await hits(), before);
});
console.log(`e2e: ${n} checks passed`);
