import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/ping-shared.sh', import.meta.url).pathname;

// A sandbox: its own HOME (so the licence path is under it), and a `node` shim so the probe answers from the test,
// never from whatever happens to run on this machine's ports. No docker on PATH: nothing here may start a container.
function sandbox({ license = false, probe = 'missing' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-script-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(join(home, '.config/demo-kit'), { recursive: true });
  mkdirSync(bin);
  if (license) writeFileSync(join(home, '.config/demo-kit/pingfederate.lic'), 'LICENSE-BODY-THAT-MUST-NOT-BE-PRINTED\n');
  writeFileSync(join(bin, 'node'), `#!/bin/sh
case "$1" in
  */probe.mjs)
    case "$2" in
      pingfederate) ${probe === 'healthy' ? 'echo "using shared pingfederate at 127.0.0.1:4732"; exit 0' : 'echo "no shared pingfederate; offer to start it (never silently)" >&2; exit 1'} ;;
      *) echo "no shared $2" >&2; exit 1 ;;
    esac ;;
esac
exec ${process.execPath} "$@"
`);
  chmodSync(join(bin, 'node'), 0o755);
  return { dir, home, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: dir } };
}
function run(sb, args, extraEnv = {}) {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...sb.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('bootstrap --dry-run with no licence: clear message naming the file, where to get one, and the alternatives; no crash', () => {
  const sb = sandbox();
  const r = run(sb, ['bootstrap', '--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PingFederate skipped: there is no licence file at/);
  assert.ok(r.out.includes(join(sb.home, '.config/demo-kit/pingfederate.lic')));
  assert.match(r.out, /Free-edition/);
  assert.match(r.out, /Mock mode/);
  assert.match(r.out, /PING_SHARED_SE_PF_URL/);
  assert.match(r.out, /PingGateway not started \(optional\)/);
  assert.doesNotMatch(r.out, /would run/);
});

test('bootstrap with a licence but no YES: not started, says the terms are the user\'s step, never prints the licence', () => {
  const sb = sandbox({ license: true });
  const r = run(sb, ['bootstrap']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /accepting Ping's terms/);
  assert.match(r.out, /your step, never automatic/);
  assert.doesNotMatch(r.out, /LICENSE-BODY/);
  assert.doesNotMatch(r.out, /would run/);
});

test('bootstrap --dry-run with a licence and PF_ACCEPT_EULA=YES plans the compose start (and starts nothing)', () => {
  const sb = sandbox({ license: true });
  const r = run(sb, ['bootstrap', '--dry-run'], { PF_ACCEPT_EULA: 'YES' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /would run: docker compose --profile pingfederate up -d pingfederate/);
  assert.doesNotMatch(r.out, /LICENSE-BODY/);
});

test('bootstrap reuses a healthy PingFederate and never mentions a licence', () => {
  const sb = sandbox({ probe: 'healthy' });
  const r = run(sb, ['bootstrap', '--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /using shared pingfederate at 127\.0\.0\.1:4732/);
  assert.doesNotMatch(r.out, /licence/);
});

test('bootstrap --dry-run plans the gateway only when GATEWAY_ISSUER and GATEWAY_AUDIENCE are set', () => {
  const sb = sandbox();
  const r = run(sb, ['bootstrap', '--dry-run'], { GATEWAY_ISSUER: 'https://issuer.example/as', GATEWAY_AUDIENCE: 'https://mcp.example/' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /would run: docker compose --profile pinggateway up -d pinggateway \(port 127\.0\.0\.1:7809\)/);
});

test('up pingfederate: exit 4 with no licence, exit 5 with a licence but no accepted terms (non-interactive)', () => {
  assert.equal(run(sandbox(), ['up', 'pingfederate']).status, 4);
  assert.equal(run(sandbox({ license: true }), ['up', 'pingfederate']).status, 5);
});

test('up pinggateway: exit 6 when not configured', () => {
  assert.equal(run(sandbox(), ['up', 'pinggateway']).status, 6);
});

test('usage errors exit 2', () => {
  assert.equal(run(sandbox(), []).status, 2);
  assert.equal(run(sandbox(), ['up', 'nothing']).status, 2);
});

test('the script names no AI-DEMO2 container and does not touch the retired shared env file', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(script, 'utf8');
  assert.doesNotMatch(src, /ai-demo/i);
  assert.doesNotMatch(src, /Development\/\.env/);
});
