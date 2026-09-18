# pi-claude-gateway

Use [pi](https://github.com/earendil-works/pi) with a self-hosted
[Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway).

You sign in with your company account. The gateway holds the cloud credentials, so you
never handle an API key. Your usage also appears in your team's dashboards.

> Unofficial. Not affiliated with Anthropic.

## Before you start

You need two things from whoever runs your gateway:

1. The gateway URL, for example `https://claude-gateway.internal.example.com`.
2. Network access to it. Most gateways are private, so connect your VPN first.

## Install

```bash
pi install npm:pi-claude-gateway
```

Start pi and set the URL one time:

```
/gateway-setup https://claude-gateway.internal.example.com
```

Restart pi, then sign in:

```
/login claude-gateway
```

Pi shows a URL and a code. Open the URL, confirm the code, and sign in with your company
account. Pi also prints the first 16 characters of the gateway certificate fingerprint.
Compare it with the value your administrator published.

Finally, choose a model:

```
/model
```

That is the whole setup. Pi renews your session automatically, so you sign in again only
after your company account changes.

## Everyday use

| Command | Purpose |
| --- | --- |
| `/model` | Choose a gateway model |
| `/gateway-models` | List the models your account may use |
| `/gateway-setup` | Show the current settings and where they come from |
| `/login claude-gateway` | Sign in again |

To make a gateway model your default for new sessions, press `Ctrl+S` in the `/model`
picker.

## Configuration

`/gateway-setup` writes `~/.pi/agent/claude-gateway.json`. Only `url` is required:

```json
{
  "url": "https://claude-gateway.internal.example.com"
}
```

Common extras:

| Key | Purpose |
| --- | --- |
| `models` | Comma-separated model IDs, when your gateway offers a different set |
| `certSha256` | Refuse to sign in if the gateway certificate changes |
| `telemetry.serviceName` | Set to `claude-code` to appear in an existing Claude Code dashboard |
| `telemetry.enabled` | Set to `false` to send no usage metrics |

Every key also has an environment variable, such as `CLAUDE_GATEWAY_URL`, which wins over
the file. See [docs/reference.md](docs/reference.md) for the full list.

## Telemetry

The extension reports your token usage, cost, and session count to the gateway, using the
same metric names as Claude Code. Your administrator sees the same figures for pi as for
Claude Code.

It reports no prompts, no file contents, and no command output. Set
`"telemetry": { "enabled": false }` to send nothing. See
[docs/telemetry.md](docs/telemetry.md) for the exact metrics.

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| `/login` does not list the gateway | No URL is set. Run `/gateway-setup` to see why |
| `/model` shows no gateway models | You are not signed in yet. Run `/login claude-gateway` |
| `Cannot reach the gateway` | Connect your VPN |
| Certificate fingerprint changed | Ask your administrator before you continue. Do not approve a change you cannot confirm |
| Settings look correct, pi disagrees | A running pi cannot see a new shell variable. Restart pi, or use `/gateway-setup` |

## Limits

- Web search does not work through a gateway.
- Prompt caching uses the 5-minute window, not the 1-hour window.
- Administrator settings from the gateway do not reach pi. Model limits and spend limits
  still apply, because the gateway enforces those itself.

## Documentation

- [docs/reference.md](docs/reference.md) — every setting, the sign-in flow, model catalog
- [docs/telemetry.md](docs/telemetry.md) — metrics, attributes, dashboards
- [docs/development.md](docs/development.md) — tests, layout, running a local gateway

## License

MIT
