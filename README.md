# ping-shared — shared Ping infrastructure for standalone labs (rule 20)

One instance per host of the Ping products that standalone labs need. Standalone
labs never ship their own; they probe and reuse these.

## Products and probes (`node probe.mjs <product>`)

| Product | Probed at | Ok statuses | Source |
|---|---|---|---|
| `pingfederate` | `https://127.0.0.1:9031/pf/heartbeat.ping` | 200 | adopted: AI-DEMO2 `ai-demo-pingfederate` (admin 9999, runtime 9031 via shim) |
| `pinggateway` | `https://127.0.0.1:3036/mcp` | 200/401/405 | adopted: AI-DEMO2 `ai-demo-ping-gateway` (401 = enforcement point up) |
| `privilege-gateway` | `http://127.0.0.1:8623/` | 200 | adopted: AI-DEMO2 `ai-demo-ping-mcpgw` (procyon MCP listener) |
| `pingone` | `https://auth.pingone.<region>/<env>/as/.well-known/openid-configuration` | 200 | SaaS; env id + region from the shared env file |
| `pingone-privilege` | `PRIVILEGE_CONSOLE_URL` (default `https://console.privilege.pingone.com/`) | 200/302/401/403 | SaaS console; users point at their own tenant — ping-shared never ships it |

Probe exit codes: 0 = shared and healthy ("using shared <product> at …"),
1 = missing or unhealthy (offer to start, never silently), 2 = unknown product.

## Shared settings file (rule 94)

`~/Development/.env` (mode 600) is the family's one settings file; every standalone
app reads it, `STANDALONE_ENV` overrides the path. Keys:

| Key | Used by |
|---|---|
| `PINGONE_ENVIRONMENT_ID`, `PINGONE_REGION` (`na`/`us` alias to `com`), `PINGONE_CLIENT_ID`, `PINGONE_CLIENT_SECRET` | PingOne (SaaS) labs |
| `PF_URL`, `PF_AUDIENCE`, `PF_CA_FILE` | PingFederate live modes |
| `PRIVILEGE_CONSOLE_URL` | Privilege SaaS console (probe + labs) |
| `PRIVILEGE_GATEWAY_URL` | Privilege Agent Gateway if not the shared local one |
| `PRIVILEGE_SSO_CLIENT_ID`, `PRIVILEGE_SSO_CLIENT_SECRET`, `PRIVILEGE_SSO_ENV_ID` | Privilege SSO sign-in |

Secrets never go into a repo, a README or a ZIP; the file is git-ignored everywhere.

## Adopted instances (running, owned elsewhere — do not recreate)

| Product | Container | Ports (loopback) | Owner |
|---|---|---|---|
| PingFederate 13.1 | `ai-demo-pingfederate` | admin 9999, runtime 9031→9032 | AI-DEMO2 `scripts/pingfederate/docker-compose.local.yml`, profile `~/pingfederate-profile` |
| PingGateway | `ai-demo-ping-gateway` | 8443→3036 | AI-DEMO2 `docker-compose.yml` |
| Privilege Agent Gateway | `ai-demo-ping-mcpgw` | 8620/8623/8690 | AI-DEMO2 `docker-compose.yml` |

## Adding a product

Same shape every time: loopback-only port publish, joined to the external
`ping-shared` network, labels `io.ping-shared.product=<name>` and
`io.ping-shared.health=<path>`, named volume for state. Add the row to the
tables above and a HEALTH entry in `probe.mjs`.

## Network

Labs join with:

```yaml
networks:
  ping-shared:
    external: true
```

## Lab declarations (rule 20, step 4)

Each lab's `docs/shelf-entry.json` (and the shelf registry entry) declares
`pingProducts: []` — the probe names above. The shelf warns on a card whose
products are not shared-and-healthy.
