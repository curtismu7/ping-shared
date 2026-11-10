import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PRODUCTS, checkProduct, get, runningContainers } from '../probe.mjs';

const probeSrc = readFileSync(new URL('../probe.mjs', import.meta.url), 'utf8');
const ok = (status = 200, body = '') => async () => ({ status, body });
const up = (...names) => new Set(names);

test('the probe names only what ping-shared owns, the PingFederate on 4732, and the optional SE URL', () => {
  assert.deepEqual(Object.keys(PRODUCTS).sort(), ['cimd-doc-server', 'pingfederate', 'pingfederate-se', 'pinggateway']);
});

test('no ai-demo-* name, AI-DEMO2 mention or retired shared env file anywhere in the probe', () => {
  assert.doesNotMatch(probeSrc, /ai-demo/i);
  assert.doesNotMatch(probeSrc, /Development\/\.env/);
  assert.doesNotMatch(JSON.stringify(PRODUCTS, (k, v) => (typeof v === 'function' ? String(v) : v)), /ai-demo/i);
});

test('every probed endpoint is loopback', () => {
  for (const [name, p] of Object.entries(PRODUCTS)) if (p.url) assert.match(p.url, /^https?:\/\/127\.0\.0\.1:\d+\//, name);
});

for (const [name, container] of [['pingfederate', 'id-jag-kit-pf'], ['pinggateway', 'ping-shared-pinggateway'], ['cimd-doc-server', 'ping-shared-cimd-doc-server-1']]) {
  test(`${name}: healthy when its container is up and the endpoint answers`, async () => {
    const r = await checkProduct(name, { running: up(container), fetcher: ok(200, '{"tokenCheck":"configured"}') });
    assert.equal(r.state, 'healthy'); assert.equal(r.exit, 0); assert.match(r.message, new RegExp(`^using shared ${name} at 127\\.0\\.0\\.1:\\d+`));
  });
  test(`${name}: missing when there is no container and nothing answers`, async () => {
    const r = await checkProduct(name, { running: up(), fetcher: ok(0) });
    assert.equal(r.state, 'missing'); assert.equal(r.exit, 1); assert.match(r.message, /offer to start it \(never silently\)/);
  });
  test(`${name}: unhealthy when the container is up but the endpoint does not answer 200`, async () => {
    for (const status of [0, 503, 401]) {
      const r = await checkProduct(name, { running: up(container), fetcher: ok(status) });
      assert.equal(r.state, 'unhealthy', `status ${status}`); assert.equal(r.exit, 1); assert.match(r.message, /up but not healthy/);
    }
  });
}

test('pingfederate: a PingFederate answering on 4732 is reused even when ping-shared did not start it (one per host)', async () => {
  const r = await checkProduct('pingfederate', { running: up(), fetcher: ok(200) });
  assert.equal(r.state, 'healthy'); assert.match(r.message, /not started by ping-shared/);
});

test('only pingfederate adopts a foreign instance: a gateway answering without our container is not healthy', async () => {
  const r = await checkProduct('pinggateway', { running: up(), fetcher: ok(200) });
  assert.equal(r.state, 'missing');
});

test('pinggateway: healthy but says plainly when the token check is not configured', async () => {
  const r = await checkProduct('pinggateway', { running: up('ping-shared-pinggateway'), fetcher: ok(200, '{"tokenCheck":"not_configured"}') });
  assert.equal(r.state, 'healthy'); assert.match(r.message, /token check NOT configured/);
});

test('pingfederate-se: unconfigured without PING_SHARED_SE_PF_URL, probed with it, no hostname built in', async () => {
  const none = await checkProduct('pingfederate-se', { env: {}, fetcher: ok(200) });
  assert.equal(none.state, 'unconfigured'); assert.equal(none.exit, 1);
  const set = await checkProduct('pingfederate-se', { env: { PING_SHARED_SE_PF_URL: 'https://pf.example/pf/heartbeat.ping' }, fetcher: ok(200) });
  assert.equal(set.state, 'healthy'); assert.match(set.message, /pf\.example/);
  const down = await checkProduct('pingfederate-se', { env: { PING_SHARED_SE_PF_URL: 'https://pf.example/pf/heartbeat.ping' }, fetcher: ok(0) });
  assert.equal(down.state, 'unhealthy');
});

test('unknown product is exit 2', async () => {
  const r = await checkProduct('mcp-server');
  assert.equal(r.exit, 2); assert.equal(r.state, 'unknown');
});

test('CLI: unknown or missing product exits 2', () => {
  for (const args of [['not-a-product'], []]) {
    const r = spawnSync(process.execPath, [new URL('../probe.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
  }
});

test('runningContainers parses docker ps and is empty when docker is missing', () => {
  assert.deepEqual([...runningContainers(() => 'a\n\nb\n')], ['a', 'b']);
  assert.equal(runningContainers(() => { throw new Error('ENOENT'); }).size, 0);
});

test('get() returns status and body, and 0 for a closed port', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('hi'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.deepEqual(await get(`http://127.0.0.1:${port}/`), { status: 200, body: 'hi' });
  await new Promise((r) => srv.close(r));
  assert.equal((await get(`http://127.0.0.1:${port}/`)).status, 0);
});
