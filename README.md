# ping-shared — shared Ping infrastructure for standalone labs (rule 20)

One instance per host of the Ping products that standalone labs need. Standalone
labs never ship their own; they probe and reuse these.

## Products and probes (`node probe.mjs <product>`)

| Product | Probed at | Ok statuses | Source |
|---|---|---|---|
| `pingfederate` | `https://127.0.0.1:9031/pf/heartbeat.ping` | 200 | adopted: AI-DEMO2 `ai-demo-pingfederate` (admin 9999, runtime 9031 via shim) |
| `pinggateway` | `https://127.0.0.1:3036/mcp` | 200/401/405 | adopted: AI-DEMO2 `ai-demo-ping-gateway` (401 = enforcement point up) |
| `privilege-gateway` | `http://127.0.0.1:8623/` | 200 | adopted: AI-DEMO2 `ai-demo-ping-mcpgw` (procyon MCP listener; profile `mcpgw`) |
| `pingone` | `https://auth.pingone.<region>/<env>/as/.well-known/openid-configuration` | 200 | SaaS; env id + region from the shared env file |
| `pingone-privilege` | `PRIVILEGE_CONSOLE_URL` (default `https://console.privilege.pingone.com/`) | 200/302/401/403 | SaaS console; users point at their own tenant — ping-shared never ships it |
| `mcp-server` | `http://127.0.0.1:8080/` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-server` (the MCP tool server) |
| `mcp-gateway` | `http://127.0.0.1:3005/health` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-gateway` (the Node MCP gateway) |
| `mcp-resource-server` | `http://127.0.0.1:8081/` (loopback-only) | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-resource-server` (token-protected API) |
| `mcp-jwt-verifier` | `http://127.0.0.1:8083/health` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-jwt-verifier` |
| `api-resource-server` | `http://127.0.0.1:8082/health` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-api-resource-server` (the banking API) |
| `authz-server` | `http://127.0.0.1:9001/health` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-authz-server` |
| `mcp-proxy` | `http://127.0.0.1:8895/` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-proxy` |
| `mcp-audit` | `http://127.0.0.1:8898/` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-audit` |
| `llm-proxy` | `http://127.0.0.1:8090/health` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-llm-proxy` (shared local model endpoint) |
| `mcp-code-search` | `http://127.0.0.1:8095/` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-code-search` |
| `opensearch-mcp-server` | `http://127.0.0.1:9900/` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-opensearch-mcp-server` (profile `mcpgw`) |
| `mcp-weather` | `http://127.0.0.1:8896/` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-weather` |
| `mcp-brave` | `http://127.0.0.1:8897/` | 200/401/404/405 | adopted: AI-DEMO2 `ai-demo-mcp-brave` |
| `bff` | `https://local.ping-devops.com:3001/api/health` | 200 | adopted: AI-DEMO2 `ai-demo-api-server` (session custodian; TLS at the container) |

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

## cimd-doc-server (port 5252)
Shared CIMD Client ID Metadata Document publisher standing in for the public
`https://client.dev/oauth/metadata.json`. Source: `../cimd-doc-server`. Labs
point PingFederate CIMD policies at `http://cimd-doc-server:5252/...` (from the
shared Docker network) or `https://local.ping-devops.com:8443` (via lab-proxy).
Health: `GET /api/health` → `demo-health/1`. See that folder's README.
