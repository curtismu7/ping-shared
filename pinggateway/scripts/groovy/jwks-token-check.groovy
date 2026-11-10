/*
 * Inbound bearer-token check for the /mcp route. This is the whole policy of the minimal gateway:
 *   - the token must be an RS256 JWT whose signature verifies against the issuer's JWKS;
 *   - iss must equal GATEWAY_ISSUER, aud must contain GATEWAY_AUDIENCE, exp/nbf must hold (30 s skew);
 *   - if GATEWAY_REQUIRED_SCOPE is set, the scope claim (string or array) must contain it.
 * Anything else is a 401 with a Bearer challenge. With no GATEWAY_ISSUER / GATEWAY_AUDIENCE it denies everything.
 * It calls no other service than the JWKS endpoint, so revocation is not seen until exp.
 *
 * Settings come from the environment (the compose file passes them from ping-shared/.env):
 *   GATEWAY_ISSUER (required), GATEWAY_AUDIENCE (required), GATEWAY_JWKS_URI (optional; default: the jwks_uri in
 *   the issuer's /.well-known/openid-configuration), GATEWAY_REQUIRED_SCOPE (optional).
 */
import groovy.json.JsonSlurper
import org.forgerock.http.protocol.Response
import org.forgerock.http.protocol.Status
import org.forgerock.util.promise.Promises

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec

def issuer        = System.getenv('GATEWAY_ISSUER') ?: ''
def audience      = System.getenv('GATEWAY_AUDIENCE') ?: ''
def jwksUriSetting = System.getenv('GATEWAY_JWKS_URI') ?: ''
def requiredScope = System.getenv('GATEWAY_REQUIRED_SCOPE') ?: ''

def deny = { String reason ->
    logger.info('[token-check] denied: ' + reason)
    def resp = new Response(Status.UNAUTHORIZED)
    resp.headers.put('Content-Type', 'application/json')
    resp.headers.put('WWW-Authenticate', 'Bearer realm="mcp", error="invalid_token", error_description="' + reason + '"')
    resp.entity.setString('{"error":"invalid_token","reason":"' + reason + '"}')
    return Promises.newResultPromise(resp)
}
def b64url = { String s -> java.util.Base64.getUrlDecoder().decode(s) }
def getJson = { String uri ->
    def conn = new URL(uri).openConnection() as java.net.HttpURLConnection
    conn.connectTimeout = 5000
    conn.readTimeout = 5000
    return new JsonSlurper().parse(conn.inputStream)
}

if (!issuer || !audience) return deny('gateway_not_configured')

def authz = request.headers.getFirst('Authorization') ?: ''
if (!authz.toLowerCase().startsWith('bearer ')) return deny('missing_bearer')
def parts = authz.substring(7).trim().split('\\.', -1)
if (parts.length != 3) return deny('malformed_jwt')

def header, claims
byte[] sigBytes
try {
    header = new JsonSlurper().parse(b64url(parts[0]))
    claims = new JsonSlurper().parse(b64url(parts[1]))
    sigBytes = b64url(parts[2])
} catch (Exception e) {
    return deny('undecodable_jwt')
}
if (!(header instanceof Map) || !(claims instanceof Map)) return deny('undecodable_jwt')
if (header['alg'] != 'RS256') return deny('unsupported_alg')

// JWKS, cached five minutes in the script globals. On an unknown kid it refetches, at most once a minute.
def jwksUri = jwksUriSetting
if (!jwksUri) {
    def cachedUri = globals['_gwJwksUri']
    if (cachedUri) {
        jwksUri = cachedUri
    } else {
        try {
            jwksUri = getJson(issuer.replaceAll('/+$', '') + '/.well-known/openid-configuration')['jwks_uri'] as String
            if (jwksUri) globals['_gwJwksUri'] = jwksUri
        } catch (Exception e) {
            logger.warn('[token-check] issuer discovery failed: ' + e.message)
            return deny('jwks_unavailable')
        }
    }
}
if (!jwksUri) return deny('jwks_unavailable')

def fetchKeys = { boolean force ->
    long nowMs = System.currentTimeMillis()
    def cache = globals['_gwJwks']
    if (!force && cache && nowMs < (cache.expiresAt as long)) return cache.keys
    def keys = getJson(jwksUri)['keys'] ?: []
    globals['_gwJwks'] = [keys: keys, expiresAt: nowMs + 300_000L]
    return keys
}
def pick = { List keys ->
    def rsa = keys.findAll { it['kty'] == 'RSA' && (it['use'] == 'sig' || !it['use']) }
    def kid = header['kid'] as String
    return kid ? rsa.find { it['kid'] == kid } : (rsa.size() == 1 ? rsa[0] : null)
}
def jwk
try {
    jwk = pick(fetchKeys(false))
    if (jwk == null) {
        long nowMs = System.currentTimeMillis()
        boolean won = false
        synchronized (globals) {
            if (nowMs - ((globals['_gwForcedAt'] ?: 0L) as long) > 60_000L) {
                globals['_gwForcedAt'] = nowMs
                won = true
            }
        }
        if (won) jwk = pick(fetchKeys(true))
    }
} catch (Exception e) {
    logger.warn('[token-check] JWKS fetch failed: ' + e.message)
    return deny('jwks_unavailable')
}
if (jwk == null) return deny('no_matching_key')

try {
    def pub = KeyFactory.getInstance('RSA').generatePublic(
        new RSAPublicKeySpec(new BigInteger(1, b64url(jwk['n'] as String)), new BigInteger(1, b64url(jwk['e'] as String))))
    def sig = Signature.getInstance('SHA256withRSA')
    sig.initVerify(pub)
    sig.update((parts[0] + '.' + parts[1]).getBytes('US-ASCII'))
    if (!sig.verify(sigBytes)) return deny('bad_signature')
} catch (Exception e) {
    return deny('bad_signature')
}

long now = System.currentTimeMillis().intdiv(1000L)
if (!(claims['exp'] instanceof Number)) return deny('missing_exp')
if (now > (claims['exp'] as long) + 30L) return deny('token_expired')
if (claims['nbf'] instanceof Number && now < (claims['nbf'] as long) - 30L) return deny('token_not_yet_valid')
if ((claims['iss'] ?: '') as String != issuer) return deny('issuer_mismatch')
def rawAud = claims['aud']
def audList = rawAud instanceof List ? rawAud.collect { it as String } : (rawAud ? [rawAud as String] : [])
if (!audList.contains(audience)) return deny('audience_mismatch')
if (requiredScope) {
    def rawScope = claims['scope']
    def scopes = rawScope instanceof List ? rawScope.collect { it as String } : ((rawScope ?: '') as String).tokenize(' ')
    if (!scopes.contains(requiredScope)) return deny('insufficient_scope')
}

return next.handle(context, request)
