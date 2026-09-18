# Telemetry

The extension exports OTLP metrics to the gateway at `POST /v1/metrics`. It uses the metric
names Claude Code uses, so an existing dashboard needs no new queries.

Set `"telemetry": { "enabled": false }` to send nothing.

## What is sent

| Metric | Unit | Extra attributes |
| --- | --- | --- |
| `claude_code.session.count` | none | `start_type` |
| `claude_code.token.usage` | tokens | `type` (`input`, `output`, `cacheRead`, `cacheCreation`), `model`, `query_source` |
| `claude_code.cost.usage` | USD | `model`, `query_source` |
| `claude_code.active_time.total` | s | `type` (`cli`, `user`) |

Every data point also carries `user.email`, `user.id`, `identity.source`,
`app.entrypoint=pi`, `client.name=pi`, and `session.id`.

No prompts, file contents, or command output are sent.

Counters are cumulative and monotonic, as OpenTelemetry sums. The exporter batches for 60
seconds and flushes on exit.

## What is not sent

`lines_of_code.count`, `commit.count`, `pull_request.count`, and
`code_edit_tool.decision`. Pi has no permission dialog, so the decision metric has no
source. The other three need diff and git parsing. Those dashboard widgets stay
Claude-Code-only.

Logs and traces are not exported.

## Identity

`user.email` and `user.id` come from the `email` and `sub` claims of the gateway token.
The gateway protocol calls that token opaque, so this reads a claim it does not promise to
keep. When the claims are absent, the metrics carry no identity and per-user dashboard
rows will not show pi usage.

## Model names

The gateway sometimes answers with an upstream model ID such as
`anthropic.claude-haiku-4-5-20251001-v1:0`. The exporter removes the region prefix, the
`anthropic.` prefix, and the version suffix, so pi rows group with Claude Code rows in
by-model widgets.

## Appearing in an existing dashboard

The default `service.name` is `pi`. A Claude Code dashboard usually filters on:

```
@resource.service.name =~ "claude-code|claude-code-desktop|claude-desktop|cowork"
```

That filter excludes `pi`, so pi usage will not appear. Choose one:

1. **Add `|pi` to the dashboard filter.** Preferred. Pi usage stays distinguishable.
2. **Set `"telemetry": { "serviceName": "claude-code" }`.** No dashboard change, but pi
   then reports itself as Claude Code. The `client.name=pi` attribute still separates the
   two.

## session.id and cardinality

`session.id` is included by default, matching Claude Code. Dropping it lowers metric
cardinality and cost. However, two pi processes running at once then share one counter
series, and their cumulative totals conflict. Drop it only when you run one pi at a time:

```json
{ "telemetry": { "includeSessionId": false } }
```

## Debugging

Set `CLAUDE_GATEWAY_TELEMETRY_DEBUG=1` to print the status of each export:

```
[claude-gateway-telemetry] shutdown -> 200
```

A gateway returns `200` whether it forwards or discards the metrics, so a `200` does not
prove arrival. Check your metrics backend.

Where the metrics land after the gateway forwards them depends on your operator's
collector. Ask them which backend to query.
