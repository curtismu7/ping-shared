/*
 * GET /health. 200 whenever the gateway is up. "tokenCheck" says whether the JWKS check has the settings it
 * needs (GATEWAY_ISSUER and GATEWAY_AUDIENCE); until it does, /mcp answers 401 to everything (fail closed).
 */
import org.forgerock.http.protocol.Response
import org.forgerock.http.protocol.Status
import org.forgerock.util.promise.Promises

def configured = (System.getenv('GATEWAY_ISSUER') ?: '') && (System.getenv('GATEWAY_AUDIENCE') ?: '')
def resp = new Response(Status.OK)
resp.headers.put('Content-Type', 'application/json')
resp.entity.setString('{"schema":"demo-health/1","status":"ok","service":"ping-shared-pinggateway","tokenCheck":"' +
    (configured ? 'configured' : 'not_configured') + '"}')
return Promises.newResultPromise(resp)
