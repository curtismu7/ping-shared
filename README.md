# ping-shared: shared Ping infrastructure for standalone labs (rule 20)

One instance per host of the Ping products the standalone labs need. Labs never ship their own;
they probe for a healthy one, reuse it, or offer to start it (never silently).

**ping-shared owns everything it runs.** Nothing here depends on AI-DEMO2 or on any container another
project started (owner rule 2026-11-10: standalone demos never rely on AI-DEMO2; a colleague has only
AI-DEMO-Standalone).

## What runs from here

| Service | Image | Host ports (loopback only) | Started by |
|---|---|---|---|
| `cimd-doc-server` | built from `../cimd-doc-server` | 5252 | always (`docker compose up -d`) |
| `pingfederate` (container `id-jag-kit-pf`) | `pingidentity/pingfederate:13.1.3-latest` | admin 4731, engine 4732 | `scripts/ping-shared.sh up pingfederate` (profile `pingfederate`; needs a licence file) |
| `pinggateway` (container `ping-shared-pinggateway`) | Ping IG `ig@sha256:5deece14...` (public image, pinned by digest) | 7809 | `scripts/ping-shared.sh up pinggateway` (profile `pinggateway`; needs `GATEWAY_ISSUER`, `GATEWAY_AUDIENCE`) |

All services join the `ping-shared` Docker network. Labs that need them declare `pingProducts: []` in
`docs/shelf-entry.json` and join the network:

```yaml
networks:
  ping-shared:
    external: true
```

## Getting a local PingFederate on a clean machine

PingFederate needs a licence from Ping, and Ping's terms must be accepted by you. Neither is ever done for you.

1. **Licence.** Get a PingFederate licence from Ping Identity (a Free-edition or evaluation licence;
   see https://devops.pingidentity.com/ or ask your Ping contact). Save it as
   `~/.config/demo-kit/pingfederate.lic` (`chmod 600`). It is mounted read-only into the container and is
   never copied into a repo. **One licence serves ONE PingFederate instance.**
   Without the file the service does not start and the setup says so, naming the path.
2. **Terms.** Run `shared/ping-shared/scripts/ping-shared.sh up pingfederate` (from the AI-DEMO-Standalone
   checkout). It asks you to type `YES` to accept Ping's terms for the image and PingFederate's in-product
   licence agreement. For a non-interactive run set `PF_ACCEPT_EULA=YES` yourself.
3. **Wait.** First start pulls the image and imports Ping's public `getting-started/pingfederate` server
   profile; the admin API answers after a few minutes. When the parent repo's `scripts/pingfederate-setup.sh`
   is present the script then finishes the first-run steps: it accepts the in-product agreement (only because
   you said YES) and saves the administrator login to `~/.config/demo-kit/provisioning.json` (mode 600).
4. **Use.** Admin console and API https://127.0.0.1:4731, runtime https://127.0.0.1:4732 (self-signed certificate).
   The administrator login is the image's documented default; change it for anything beyond local use.

Rules it follows:

- **One instance per host.** The script probes first: a PingFederate already answering on 4732 (including the
  `id-jag-kit-pf` that `scripts/pingfederate-setup.sh` makes and `id-jag-standalone-LAB` uses) is reused
  as is. It never starts a second one, and it never touches a stopped container named `id-jag-kit-pf` (it
  tells you to `docker start` it).
- Never loop on a 401: repeated failed admin logins lock the account.
- No licence and no SE PingFederate? The labs' Mock mode needs neither. To use the PingFederate on the US SE
  cluster, set `PING_SHARED_SE_PF_URL` (a `/pf/heartbeat.ping` URL) and `node probe.mjs pingfederate-se` checks it.

## PingGateway: what it does and does not do

A **minimal** gateway. It exists so a lab's Real mode can put a real PingGateway in front of an MCP server
without AI-DEMO2. Config is in `pinggateway/` (2 routes, 2 small Groovy scripts).

What it does:

- `GET /health`: 200 `demo-health/1`, and says whether the token check has its settings (`tokenCheck`).
- `/mcp` (and `/mcp/...`): checks the bearer token, then reverse-proxies to `GATEWAY_BACKEND_URL`
  (default `http://host.docker.internal:8081`, which is mcp-resource-server-LAB on this machine).
  The check: RS256 JWT, signature verified against the issuer's JWKS, `iss` equal to `GATEWAY_ISSUER`,
  `aud` containing `GATEWAY_AUDIENCE`, `exp`/`nbf` valid (30 s skew), and, if `GATEWAY_REQUIRED_SCOPE` is set,
  that scope present. Anything else is `401` with a `WWW-Authenticate: Bearer` challenge and a reason.
- Fails closed: with no issuer or audience set it answers 401 to everything on `/mcp`.
- Any other path is a 404. Nothing else is exposed.

What it does NOT do (AI-DEMO2's PingGateway does; do not expect it here):

- **PingOne Authorize decisions**: no policy decision point, no permit/deny per tool call.
- **Token exchange** (RFC 8693): the inbound token is forwarded unchanged to the backend.
- **Introspection / revocation**: JWKS-only, so a revoked token is accepted until it expires.
- **Trusted-caller / side-band features**, per-tool scope mapping, argument validation, rate limiting, audit
  or tracing, MCP protocol validation, RFC 9728 protected-resource metadata, TLS termination.
- Algorithms other than RS256 (no ES256, no HS256, no `none`).
- A local PingFederate as issuer: PingFederate's engine uses a self-signed certificate and the gateway's
  Java does not trust it. An issuer with a public certificate (PingOne) or plain `http` works.

Settings go in `ping-shared/.env` beside the compose file (copy `.env.example`; mode 600, gitignored):
`GATEWAY_ISSUER`, `GATEWAY_AUDIENCE`, optional `GATEWAY_JWKS_URI` (default: the `jwks_uri` in the issuer's
`/.well-known/openid-configuration`), `GATEWAY_REQUIRED_SCOPE`, `GATEWAY_BACKEND_URL`, `PINGGATEWAY_HOST_PORT`.
The gateway runs in a container: an issuer on your host is `host.docker.internal`, not `localhost`.

The MCP server behind it is **mcp-resource-server-LAB** (https://github.com/curtismu7/mcp-resource-server-LAB),
a standalone lab with its own `docker compose up`. ping-shared no longer ships a stand-in MCP server.

Verified: the real container, run from this compose service with a fake JWKS issuer and backend, on a
second machine (`test/e2e-gateway.sh`, 16 checks: valid token proxied; no token, malformed, wrong audience,
wrong issuer, expired, not-yet-valid, wrong key, unknown kid, `alg: none`, HS256 and missing scope all 401 and
never reach the backend; other paths 404; the unconfigured gateway denies everything). Not verified: a real
PingOne or PingFederate token end to end.

## Probes (`node probe.mjs <product>`, `node probe.mjs --all`)

Only ping-shared's own containers, the PingFederate on 4732, and an optional SE PingFederate URL.

| Product | Probed at | Container | Ok |
|---|---|---|---|
| `pingfederate` | `https://127.0.0.1:4732/pf/heartbeat.ping` | `id-jag-kit-pf` (any PingFederate answering there is reused) | 200 |
| `pinggateway` | `http://127.0.0.1:7809/health` | `ping-shared-pinggateway` | 200 |
| `cimd-doc-server` | `http://127.0.0.1:5252/api/health` | `ping-shared-cimd-doc-server-1` | 200 |
| `pingfederate-se` | `PING_SHARED_SE_PF_URL` (optional, no built-in host) | none | 200 |

Exit codes: 0 = shared and healthy ("using shared <product> at ..."), 1 = missing or unhealthy (offer to
start, never silently), 2 = unknown product. PingOne is SaaS and per-lab: each lab probes its own tenant
from its own settings.

## Settings

There is no shared settings file. Each lab reads its own `.env` beside its compose file; ping-shared's own
settings are in `ping-shared/.env` (see `.env.example`). Admin credentials (the PingFederate administrator
login, PingOne admin clients) live only in `~/.config/demo-kit/provisioning.json` (mode 600), written and read
by the owner-run provisioning scripts. The licence stays at `~/.config/demo-kit/pingfederate.lic`.
Secrets never go into a repo, a README or a ZIP.

## Ports

Fixed infrastructure ports (rule 20, not renumbered): PingFederate 4731/4732, CIMD 5252, PingGateway 7809
(allocated from the 7800-7999 range with `npm run ports -- --next`). Override the gateway's host port with
`PINGGATEWAY_HOST_PORT`; PingFederate's are fixed.

## cimd-doc-server (port 5252)

Shared CIMD Client ID Metadata Document publisher standing in for the public
`https://client.dev/oauth/metadata.json`. Source: `../cimd-doc-server`. Labs point PingFederate CIMD
policies at `http://cimd-doc-server:5252/...` (from the shared Docker network) or
`https://local.ping-devops.com:8443` (via lab-proxy). Health: `GET /api/health` returns `demo-health/1`.

## Adding a product

Same shape every time: loopback-only port publish, joined to the `ping-shared` network, labels
`io.ping-shared.product=<name>` and `io.ping-shared.health=<path>`, a profile if it needs a licence or
settings. Add a row to the tables above, an entry in `probe.mjs` and its tests. Never an `ai-demo-*` name.

## Tests

`npm test` (Node 26, 45 tests, no Docker needed except the optional `docker compose config` render):
probe states per service, the compose file (no `ai-demo` names, licence read-only from the config dir, loopback
ports, EULA default NO), the gateway config (no AI-DEMO2 identifiers, no secrets, fail-closed check), and the
`scripts/ping-shared.sh` bootstrap behaviour (no licence, licence without terms, reuse, dry-run).
`npm run e2e:gateway` runs the real PingGateway container against a fake issuer (needs Docker; on the
owner's Mac run it on the Air: `air-test . -- 'bash test/e2e-gateway.sh'`).
