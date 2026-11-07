# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First public release.

### Added

- OAuth device-flow login to a Claude apps gateway, registered as the `claude-gateway`
  provider so `/login claude-gateway` works.
- Silent token refresh, with a clear re-login message when the identity provider
  deprovisions a user.
- OTLP metric export to the gateway's `/v1/metrics`, using the metric names Claude Code
  uses so existing dashboards need no new queries.
- Configuration through `~/.pi/agent/claude-gateway.json`, with environment variables as
  overrides, so no shell export is required.
- `/gateway-setup` to write and inspect that configuration, and report why the provider
  is missing when it is.
- `/gateway-models` to list what the gateway advertises for your identity-provider group.
- Certificate fingerprint reporting at login, optional pin enforcement, and a warning when
  the gateway hostname resolves to a public address.
- An editable model catalog with a `CLAUDE_GATEWAY_MODELS` override.
- `claude-opus-5-5` (Claude Opus 5.5) as the first entry in the model catalog.
- `claude-sonnet-5-5` (Claude Sonnet 5.5) in the model catalog.
- `claude-haiku-5-5` (Claude Haiku 5.5) in the model catalog, with its price tier for prompts
  over 100,000 tokens.
- A unit test suite, plus an offline OTLP capture harness under `verify/`.

### Fixed

- Bounded the metric export so the shutdown flush cannot hold the quit path open. pi stops
  its terminal UI before extension shutdown runs, so an unreachable gateway delayed the exit
  by about 10 seconds. A Ctrl+C during that pause killed pi before it printed its
  `To resume this session:` hint.
