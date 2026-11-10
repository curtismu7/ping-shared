import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const text = readFileSync(`${root}docker-compose.yml`, 'utf8');
const lines = text.split('\n');

// docker compose renders the real model; the text checks below do not need Docker.
function rendered() {
  const r = spawnSync('docker', ['compose', '--profile', '*', 'config', '--format', 'json'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: process.env.HOME || '/root' } });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

test('no ai-demo container, network, volume or image name in the compose file, and no AI-DEMO2 dependency', () => {
  assert.doesNotMatch(text, /ai-demo-/i);
  assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /ai-demo/i);
  assert.doesNotMatch(text, /Adopted|adopt/i);
});

test('the licence is bind-mounted read-only from the config dir, with no host path invented when it is missing', () => {
  assert.match(text, /source: \$\{PF_LICENSE_FILE:-\$\{HOME\}\/\.config\/demo-kit\/pingfederate\.lic\}/);
  assert.match(text, /target: \/opt\/out\/instance\/server\/default\/conf\/pingfederate\.lic/);
  const i = lines.findIndex((l) => l.includes('target: /opt/out/instance/server/default/conf/pingfederate.lic'));
  const block = lines.slice(i - 2, i + 5).join('\n');
  assert.match(block, /read_only: true/);
  assert.match(block, /create_host_path: false/);
});

test('the licence is never committed', () => {
  const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return; // not a git checkout
  assert.deepEqual(r.stdout.split('\n').filter((f) => /\.(lic|pem|p12|key)$/.test(f) || f === '.env'), []);
  assert.match(readFileSync(`${root}.gitignore`, 'utf8'), /^\*\.lic$/m);
});

test('the image terms are accepted only by the user: the default is NO and no literal YES is set', () => {
  assert.match(text, /PING_IDENTITY_ACCEPT_EULA: \$\{PF_ACCEPT_EULA:-NO\}/);
  assert.doesNotMatch(text, /ACCEPT_EULA:\s*["']?YES/);
});

test('every published port is loopback only', () => {
  const ports = lines.filter((l) => /^\s+- "[^"]*:\d+"\s*$/.test(l) && !l.includes('host-gateway'));
  assert.ok(ports.length >= 4, 'expected the 4 published ports');
  for (const l of ports) assert.match(l, /"127\.0\.0\.1:/, l);
});

test('fixed ports: PingFederate 4731/4732, gateway 7809, CIMD 5252', () => {
  assert.match(text, /127\.0\.0\.1:4731:9999/);
  assert.match(text, /127\.0\.0\.1:4732:9031/);
  assert.match(text, /\$\{PINGGATEWAY_HOST_PORT:-7809\}:8080/);
  assert.match(text, /127\.0\.0\.1:5252:5252/);
});

test('PingFederate and PingGateway are profile-gated (a plain `up -d` starts only the CIMD server) and keep the single-instance name', () => {
  assert.match(text, /container_name: id-jag-kit-pf\n\s+profiles: \["pingfederate"\]/);
  assert.match(text, /container_name: ping-shared-pinggateway\n\s+profiles: \["pinggateway"\]/);
  assert.doesNotMatch(text, /mock-mcp-server|busybox/);
});

test('the gateway image is pinned by digest', () => {
  assert.match(text, /image: us-docker\.pkg\.dev\/forgeops-public\/images-base\/ig@sha256:[0-9a-f]{64}/);
});

const model = rendered();
test('docker compose renders it: only ping-shared names, one network, no named volumes', { skip: model ? false : 'docker compose not available' }, () => {
  assert.equal(model.name, 'ping-shared');
  assert.deepEqual(Object.keys(model.networks), ['ping-shared']);
  assert.equal(model.networks['ping-shared'].name, 'ping-shared');
  assert.equal(Object.keys(model.volumes || {}).length, 0);
  assert.deepEqual(Object.keys(model.services).sort(), ['cimd-doc-server', 'pingfederate', 'pinggateway']);
  assert.doesNotMatch(JSON.stringify(model), /ai-demo/i);
  for (const [name, s] of Object.entries(model.services)) {
    for (const p of s.ports || []) assert.equal(p.host_ip, '127.0.0.1', `${name} publishes on loopback`);
    assert.deepEqual(Object.keys(s.networks), ['ping-shared'], name);
  }
  const lic = model.services.pingfederate.volumes.find((v) => v.target.endsWith('/pingfederate.lic'));
  assert.equal(lic.read_only, true);
  assert.equal(lic.bind.create_host_path, false);
  assert.match(lic.source, /\/\.config\/demo-kit\/pingfederate\.lic$|\/pingfederate\.lic$/);
  assert.equal(model.services.pingfederate.environment.PING_IDENTITY_ACCEPT_EULA, 'NO');
});
