# Reference

## How sign-in works

```
pi  --/login-->  GET  /.well-known/oauth-authorization-server
                 POST /oauth/device_authorization  surface=pi   -> user_code + URL
                 (browser) IdP authorization code -> /oauth/callback
                 POST /oauth/token  grant=device_code    -> bearer token + refresh token
    --requests-> POST /v1/messages  Authorization: Bearer <token>
    --metrics--> POST /v1/metrics   (OTLP/HTTP, JSON)
                 POST /oauth/token  grant=refresh_token  (pi refreshes before expiry)
```

Pi stores both tokens in `~/.pi/agent/auth.json`. Gateway sessions are short, one hour by
default, so pi refreshes silently one minute before each expiry. When your identity
provider deprovisions you, the gateway answers `401 invalid_grant` and pi asks you to sign
in again.

The extension sends `surface=pi` on device authorization, so a gateway operator can
separate pi sessions from Claude Code sessions.

Every gateway serves its own wire contract at `GET /protocol`. Read it after a gateway
upgrade.

## Settings

Each setting reads from the environment first, then from
`~/.pi/agent/claude-gateway.json`. `/gateway-setup` prints the value and its source.

| Config key | Environment variable | Default |
| --- | --- | --- |
| `url` | `CLAUDE_GATEWAY_URL` | none, required |
| `models` | `CLAUDE_GATEWAY_MODELS` | built-in catalog |
| `certSha256` | `CLAUDE_GATEWAY_CERT_SHA256` | not pinned |
| `telemetry.enabled` | `CLAUDE_GATEWAY_TELEMETRY` | `true` |
| `telemetry.serviceName` | `CLAUDE_GATEWAY_TELEMETRY_SERVICE_NAME` | `pi` |
| `telemetry.intervalMs` | `CLAUDE_GATEWAY_TELEMETRY_INTERVAL_MS` | `60000`, minimum `5000` |
| `telemetry.includeSessionId` | `CLAUDE_GATEWAY_TELEMETRY_INCLUDE_SESSION_ID` | `true` |
| — | `CLAUDE_GATEWAY_TOKEN` | unset |
| — | `CLAUDE_GATEWAY_TELEMETRY_DEBUG` | unset |

Full example:

```json
{
  "url": "https://claude-gateway.internal.example.com",
  "models": "claude-opus-5,claude-sonnet-5",
  "certSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "telemetry": {
    "enabled": true,
    "serviceName": "claude-code",
    "intervalMs": 60000,
    "includeSessionId": true
  }
}
```

### url

Must use `https://`, or a loopback host such as `http://localhost:8080` for local
development. The extension registers no provider when the URL is missing or invalid, and
`/gateway-setup` explains why.

### CLAUDE_GATEWAY_TOKEN

Supplies a bearer token directly and skips `/login`. Intended for tests and CI.

This variable changes auth resolution. Pi resolves an API key before OAuth, so the
provider declares an API-key method only while the variable is set. A stale or empty value
therefore breaks every request instead of falling back to `/login`. Unset it when you want
interactive sign-in.

### Certificate pinning

Claude Code pins the gateway TLS leaf certificate per hostname and prompts again when it
changes. This extension prints the first 16 characters at sign-in so you can compare them.
Set `certSha256` to enforce a match instead; sign-in then stops on any mismatch.

Print the expected value from a certificate file:

```bash
openssl x509 -noout -fingerprint -sha256 -in cert.pem | cut -d= -f2 | tr -d : | tr 'A-F' 'a-f'
```

Republish the value after every certificate rotation.

Sign-in also warns when the gateway hostname resolves to a public address, because a
trusted gateway can push settings that run commands on your machine.

## Models

`extensions/models.ts` holds the catalog: model IDs, context windows, output caps, and
prices. Prices drive pi's cost display, so a wrong entry gives wrong figures.

Override the registered set when your gateway differs:

```json
{ "models": "claude-opus-5,claude-sonnet-5" }
```

A bracketed suffix such as `[1m]` is stripped, because it is a Claude Code plan hint
rather than a model ID.

An ID outside the catalog still registers, with zero prices and a conservative 200k
window, and `/gateway-models` warns about it. Add it to the catalog to get real numbers.

The catalog prefers short aliases such as `claude-haiku-4-5` over dated IDs such as
`claude-haiku-4-5-20251001`, because gateways accept both and the short form reads better
in `/model`. Telemetry is unaffected, because the reported model comes from the gateway
response.

### Context windows

Opus 5 and Sonnet 5 have a native 1M-token context window. No beta header and no `[1m]`
suffix are needed, so the catalog declares 1M.

Pi auto-compacts at `contextWindow - reserveTokens`. If your upstream caps a model lower
than the catalog claims, pi compacts too late and the gateway rejects the request. Correct
the catalog entry in that case.

## Compatibility flags

The catalog sets these deliberately for a gateway transport:

| Flag | Value | Reason |
| --- | --- | --- |
| `supportsLongCacheRetention` | `false` | Gateways support the 5-minute cache TTL only |
| `forceAdaptiveThinking` | `true` on Opus 5 and Sonnet 5 | Those models require adaptive thinking |
| `supportsStrictTools` | unset | A gateway in front of Bedrock is not a first-party Anthropic transport |
| `supportsMidConvoEffort` | unset | Pi restricts it to a faithful Anthropic Messages transport |

Enable the last two per model only after a tool-calling probe passes.

## Known limits

- **Server-side web search** is unavailable. Gateways declare no server-side tools.
- **`count_tokens`** may answer `501` when the upstream is Amazon Bedrock. Pi never calls
  it, so nothing breaks.
- **Managed settings are ignored.** The gateway serves administrator policy at
  `GET /managed/settings`. This extension does not fetch it, so model pins and permission
  rules do not reach pi. Server-side model limits and spend limits still apply, because
  the gateway enforces those at `/v1/messages`.
- **The gateway protocol is documented for Claude Code and Claude Desktop only.** A
  gateway release can change it.
