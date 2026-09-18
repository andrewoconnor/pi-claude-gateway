# Development

```bash
npm install
npm run check       # tsc --noEmit && vitest --run
npm test            # tests only
npm run test:watch
```

## Layout

| Path | Purpose |
| --- | --- |
| `extensions/index.ts` | Provider registration, OAuth device flow, commands |
| `extensions/config.ts` | Config file and environment resolution |
| `extensions/models.ts` | Model catalog. Add models here |
| `extensions/telemetry.ts` | OTLP metric exporter |
| `test/` | Unit tests, run by vitest |
| `verify/` | Offline OTLP capture harness, not part of `npm test` |

## Tests

The suite covers configuration precedence, the model catalog, the OTLP payload shape, and
OAuth token parsing. It stubs `fetch`, so it needs no gateway and costs nothing.

It does not cover the browser leg of the device flow, certificate pinning against a real
socket, or real inference. Verify those against a gateway.

## Manual harnesses

Inspect the exact OTLP payload against a local listener:

```bash
node verify/otlp-capture.mjs &
node verify/otlp-selftest.mjs
kill %1
```

That harness found a real bug: identity attributes were merged when a counter was first
recorded, before the token had been read, so the first export of every session carried no
`user.email`.

## Testing against a real gateway

Anthropic ships the gateway inside the `claude` binary, so you can run one locally:

```bash
claude gateway --config gateway.yaml
```

The [quickstart](https://code.claude.com/docs/en/claude-apps-gateway) covers the minimal
config, which needs an OIDC client and a PostgreSQL database. Point the extension at it:

```
/gateway-setup http://localhost:8080
```

Loopback is accepted over plain `http`, matching the gateway's own rule.

## Adding a model

Add an entry to `extensions/models.ts` with the real price, context window, and output cap.
Prices drive pi's cost display, so a guess produces wrong figures. Confirm the ID against a
live gateway with `/gateway-models`.

## Secret scanning

The default gitleaks rules find credential shapes only. They do not flag a hostname, a
certificate fingerprint, a cloud account id or an internal IP address, which are the
values most easily pasted into an example by mistake. `.gitleaks.toml` adds rules for
those, with an allowlist of canonical placeholders.

```bash
gitleaks dir --config .gitleaks.toml .     # working tree
gitleaks git --config .gitleaks.toml .     # full history
```

CI runs both on every push. The `unapproved-hostname` rule is allowlist-based, so adding a
link to a new site means adding that host to the allowlist.

The test suite carries the same checks, so `npm test` fails on a private address, a real
fingerprint or an account id in any tracked file. Two controls, because this project has
already shipped that mistake twice.

## Contributing

Issues and pull requests are welcome. Keep `npm run check` green, and add a test for any
behaviour change.
