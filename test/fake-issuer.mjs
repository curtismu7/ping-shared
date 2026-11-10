// Test double for the gateway e2e (test/e2e-gateway.sh): a fake OIDC issuer (discovery + JWKS), a token minter
// and a fake MCP backend in one process. Test-only: the keys are generated at start and never leave the container.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 9000);
const ISSUER = process.env.FAKE_ISSUER || `http://psgw-e2e-issuer:${PORT}`;
const good = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (b) => Buffer.from(b).toString('base64url');

export function mint({ iss = ISSUER, aud = 'https://mcp.example/', scope = 'mcp:invoke', exp, nbf, alg = 'RS256', key = 'good', kid = 'k1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg, typ: 'JWT', kid }));
  const claims = { iss, aud, sub: 'user-1', scope, iat: now, exp: exp ?? now + 300 };
  if (nbf !== undefined) claims.nbf = nbf;
  const body = b64(JSON.stringify(claims));
  const data = `${header}.${body}`;
  if (alg === 'none') return `${data}.`;
  if (alg === 'HS256') return `${data}.${b64(crypto.createHmac('sha256', 'x').update(data).digest())}`;
  const priv = (key === 'good' ? good : other).privateKey;
  return `${data}.${b64(crypto.sign('sha256', Buffer.from(data), priv))}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  let backendHits = 0;
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/.well-known/openid-configuration') return send(200, { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    if (url.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (url.pathname === '/mcp') {
      backendHits += 1;
      const seen = { backend: 'reached', hasAuthorization: Boolean(req.headers.authorization), hits: backendHits };
      req.resume(); // read the request body before answering
      return req.on('end', () => send(200, seen));
    }
    if (url.pathname === '/mint') {
      const q = Object.fromEntries(url.searchParams);
      const now = Math.floor(Date.now() / 1000);
      const opts = { ...q };
      delete opts.expIn; delete opts.nbfIn;
      if (q.expIn !== undefined) opts.exp = now + Number(q.expIn);
      if (q.nbfIn !== undefined) opts.nbf = now + Number(q.nbfIn);
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(mint(opts));
    }
    if (url.pathname === '/hits') return send(200, { hits: backendHits });
    send(404, { error: 'not_found' });
  }).listen(PORT, '0.0.0.0', () => console.log(`fake issuer on ${PORT}`));
}
