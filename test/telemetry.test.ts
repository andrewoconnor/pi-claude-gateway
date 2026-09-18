import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../extensions/config.ts";
import { createTelemetry, normalizeModel } from "../extensions/telemetry.ts";

const GATEWAY = "https://gw.internal.example.com";
const CLAIMS = Buffer.from(JSON.stringify({ email: "dev@example.com", sub: "idp-subject-1" })).toString("base64url");
const TOKEN = `header.${CLAIMS}.signature`;

interface Exported {
	metrics: Record<string, { unit?: string; temporality: number; monotonic: boolean; points: Point[] }>;
	resource: Record<string, string>;
	scope: { name: string; version: string };
}

interface Point {
	attrs: Record<string, string>;
	value: number;
}

let dir: string;
let bodies: string[];

function attrsOf(list: { key: string; value: { stringValue: string } }[]): Record<string, string> {
	return Object.fromEntries(list.map((entry) => [entry.key, entry.value.stringValue]));
}

function parse(body: string): Exported {
	const resourceMetrics = JSON.parse(body).resourceMetrics[0];
	const scopeMetrics = resourceMetrics.scopeMetrics[0];
	const metrics: Exported["metrics"] = {};
	for (const metric of scopeMetrics.metrics) {
		metrics[metric.name] = {
			unit: metric.unit,
			temporality: metric.sum.aggregationTemporality,
			monotonic: metric.sum.isMonotonic,
			points: metric.sum.dataPoints.map((point: any) => ({
				attrs: attrsOf(point.attributes),
				value: point.asInt !== undefined ? Number(point.asInt) : point.asDouble,
			})),
		};
	}
	return { metrics, resource: attrsOf(resourceMetrics.resource.attributes), scope: scopeMetrics.scope };
}

function harness(overrides: Record<string, unknown> = {}) {
	const handlers: Record<string, (event: any, ctx: any) => Promise<void> | void> = {};
	const pi = { on: (name: string, fn: any) => (handlers[name] = fn) };
	const ctx = {
		sessionManager: { getSessionId: () => "session-abc" },
		modelRegistry: { getProviderAuth: async () => ({ apiKey: TOKEN }) },
		...overrides,
	};
	const telemetry = createTelemetry(pi, {
		providerId: "claude-gateway",
		gatewayUrl: () => GATEWAY,
		userAgent: "test-agent",
		version: "9.9.9",
	});
	return { handlers, ctx, telemetry: telemetry! };
}

function assistant(model: string, usage: Record<string, unknown>, provider = "claude-gateway") {
	return { message: { role: "assistant", provider, model, usage } };
}

const USAGE = { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: { total: 0.0025 } };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-claude-gateway-telemetry-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.CLAUDE_GATEWAY_TELEMETRY;
	delete process.env.CLAUDE_GATEWAY_TELEMETRY_SERVICE_NAME;
	delete process.env.CLAUDE_GATEWAY_TELEMETRY_INCLUDE_SESSION_ID;
	writeFileSync(join(dir, "claude-gateway.json"), JSON.stringify({ url: GATEWAY }));
	resetConfigCache();
	bodies = [];
	vi.stubGlobal("fetch", async (_url: string, init: any) => {
		bodies.push(init.body);
		return { ok: true, status: 200, text: async () => "" } as Response;
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("normalizeModel", () => {
	it("reduces an upstream Bedrock id to the Anthropic form", () => {
		expect(normalizeModel("anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5-20251001");
		expect(normalizeModel("us.anthropic.claude-opus-5-v1:0")).toBe("claude-opus-5");
		expect(normalizeModel("eu.anthropic.claude-sonnet-5-v2:1")).toBe("claude-sonnet-5");
		expect(normalizeModel("global.anthropic.claude-opus-5")).toBe("claude-opus-5");
	});

	it("leaves an already-clean id untouched", () => {
		expect(normalizeModel("claude-opus-5")).toBe("claude-opus-5");
		expect(normalizeModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
	});
});

describe("createTelemetry", () => {
	it("returns nothing when telemetry is disabled", () => {
		process.env.CLAUDE_GATEWAY_TELEMETRY = "0";
		resetConfigCache();
		const registered: string[] = [];
		const result = createTelemetry({ on: (name: string) => registered.push(name) } as any, {
			providerId: "claude-gateway",
			gatewayUrl: () => GATEWAY,
			userAgent: "test",
			version: "0.0.0",
		});
		expect(result).toBeUndefined();
		expect(registered).toEqual([]);
	});

	it("exports nothing when no metric was recorded", async () => {
		const { telemetry } = harness();
		await telemetry.flush("test");
		expect(bodies).toHaveLength(0);
	});

	it("counts a session once, with the start type", async () => {
		const { handlers, ctx, telemetry } = harness();
		await handlers.session_start({ reason: "startup" }, ctx);
		await telemetry.flush("test");
		const sessions = parse(bodies[0]).metrics["claude_code.session.count"];
		expect(sessions.points).toHaveLength(1);
		expect(sessions.points[0].value).toBe(1);
		expect(sessions.points[0].attrs.start_type).toBe("fresh");
	});

	it("labels a resumed session and skips a reload", async () => {
		const first = harness();
		await first.handlers.session_start({ reason: "resume" }, first.ctx);
		await first.telemetry.flush("test");
		expect(parse(bodies[0]).metrics["claude_code.session.count"].points[0].attrs.start_type).toBe("resume");

		bodies = [];
		const second = harness();
		await second.handlers.session_start({ reason: "reload" }, second.ctx);
		await second.telemetry.flush("test");
		expect(bodies).toHaveLength(0);
	});

	it("splits token usage by type and normalizes the model id", async () => {
		const { handlers, ctx, telemetry } = harness();
		await handlers.message_end(assistant("anthropic.claude-haiku-4-5-20251001-v1:0", USAGE), ctx);
		await telemetry.flush("test");
		const parsed = parse(bodies[0]);
		const tokens = parsed.metrics["claude_code.token.usage"];
		expect(tokens.unit).toBe("tokens");
		const byType = Object.fromEntries(tokens.points.map((point) => [point.attrs.type, point.value]));
		expect(byType).toEqual({ input: 100, output: 20, cacheRead: 5, cacheCreation: 2 });
		for (const point of tokens.points) {
			expect(point.attrs.model).toBe("claude-haiku-4-5-20251001");
			expect(point.attrs.query_source).toBe("main");
		}
		expect(parsed.metrics["claude_code.cost.usage"].unit).toBe("USD");
		expect(parsed.metrics["claude_code.cost.usage"].points[0].value).toBeCloseTo(0.0025);
	});

	it("stamps identity on the first export, not only on later ones", async () => {
		const { handlers, ctx, telemetry } = harness();
		await handlers.session_start({ reason: "startup" }, ctx);
		await handlers.message_end(assistant("claude-opus-5", USAGE), ctx);
		await telemetry.flush("first");
		for (const metric of Object.values(parse(bodies[0]).metrics)) {
			for (const point of metric.points) {
				expect(point.attrs["user.email"]).toBe("dev@example.com");
				expect(point.attrs["user.id"]).toBe("idp-subject-1");
				expect(point.attrs["identity.source"]).toBe("gateway-oidc");
				expect(point.attrs["client.name"]).toBe("pi");
				expect(point.attrs["app.entrypoint"]).toBe("pi");
			}
		}
	});

	it("omits identity rather than inventing it when the token carries no claims", async () => {
		const { handlers, ctx, telemetry } = harness({
			modelRegistry: { getProviderAuth: async () => ({ apiKey: "opaque-token-with-no-claims" }) },
		});
		await handlers.session_start({ reason: "startup" }, ctx);
		await telemetry.flush("test");
		const point = parse(bodies[0]).metrics["claude_code.session.count"].points[0];
		expect(point.attrs["user.email"]).toBeUndefined();
		expect(point.attrs["identity.source"]).toBeUndefined();
		expect(point.attrs["client.name"]).toBe("pi");
	});

	it("ignores usage from another provider", async () => {
		const { handlers, ctx, telemetry } = harness();
		await handlers.message_end(assistant("claude-opus-5", USAGE, "amazon-bedrock"), ctx);
		await telemetry.flush("test");
		expect(bodies).toHaveLength(0);
	});

	it("accumulates cumulative monotonic totals across turns", async () => {
		const { handlers, ctx, telemetry } = harness();
		await handlers.message_end(assistant("claude-opus-5", USAGE), ctx);
		await telemetry.flush("first");
		await handlers.message_end(assistant("claude-opus-5", USAGE), ctx);
		await telemetry.flush("second");

		const read = (body: string) =>
			parse(body).metrics["claude_code.token.usage"].points.find((point) => point.attrs.type === "input")?.value;
		expect(read(bodies[0])).toBe(100);
		expect(read(bodies[1])).toBe(200);

		const sum = parse(bodies[1]).metrics["claude_code.token.usage"];
		expect(sum.temporality).toBe(2);
		expect(sum.monotonic).toBe(true);
	});

	it("keeps one series per model", async () => {
		const { handlers, ctx, telemetry } = harness();
		await handlers.message_end(assistant("claude-opus-5", USAGE), ctx);
		await handlers.message_end(assistant("claude-sonnet-5", USAGE), ctx);
		await telemetry.flush("test");
		const models = new Set(
			parse(bodies[0]).metrics["claude_code.token.usage"].points.map((point) => point.attrs.model),
		);
		expect(models).toEqual(new Set(["claude-opus-5", "claude-sonnet-5"]));
	});

	it("records active time for a turn and for a prompt separately", async () => {
		const { handlers, ctx, telemetry } = harness();
		await handlers.turn_start({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await handlers.turn_end({}, ctx);
		await handlers.ui_prompt_start({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await handlers.ui_prompt_end({}, ctx);
		await telemetry.flush("test");
		const active = parse(bodies[0]).metrics["claude_code.active_time.total"];
		expect(active.unit).toBe("s");
		const byType = Object.fromEntries(active.points.map((point) => [point.attrs.type, point.value]));
		expect(byType.cli).toBeGreaterThan(0);
		expect(byType.user).toBeGreaterThan(0);
	});

	it("carries the session id, and drops it when asked", async () => {
		const withId = harness();
		await withId.handlers.session_start({ reason: "startup" }, withId.ctx);
		await withId.telemetry.flush("test");
		expect(parse(bodies[0]).metrics["claude_code.session.count"].points[0].attrs["session.id"]).toBe("session-abc");

		bodies = [];
		process.env.CLAUDE_GATEWAY_TELEMETRY_INCLUDE_SESSION_ID = "0";
		resetConfigCache();
		const without = harness();
		await without.handlers.session_start({ reason: "startup" }, without.ctx);
		await without.telemetry.flush("test");
		expect(parse(bodies[0]).metrics["claude_code.session.count"].points[0].attrs["session.id"]).toBeUndefined();
	});

	it("falls back to a per-process id for an ephemeral session", async () => {
		const { handlers, ctx, telemetry } = harness({ sessionManager: { getSessionId: () => undefined } });
		await handlers.session_start({ reason: "startup" }, ctx);
		await telemetry.flush("test");
		expect(parse(bodies[0]).metrics["claude_code.session.count"].points[0].attrs["session.id"]).toMatch(/^pi-\d+-/);
	});

	it("sends the configured service name and the extension version", async () => {
		writeFileSync(join(dir, "claude-gateway.json"), JSON.stringify({ url: GATEWAY, telemetry: { serviceName: "claude-code" } }));
		resetConfigCache();
		const { handlers, ctx, telemetry } = harness();
		await handlers.session_start({ reason: "startup" }, ctx);
		await telemetry.flush("test");
		const parsed = parse(bodies[0]);
		expect(parsed.resource["service.name"]).toBe("claude-code");
		expect(parsed.resource["service.version"]).toBe("9.9.9");
		expect(parsed.scope).toEqual({ name: "pi-claude-gateway", version: "9.9.9" });
	});

	it("does not throw when the gateway rejects the export", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 503, text: async () => "unavailable" }) as Response);
		const { handlers, ctx, telemetry } = harness();
		await handlers.session_start({ reason: "startup" }, ctx);
		await expect(telemetry.flush("test")).resolves.toBeUndefined();
	});

	it("does not throw when the network fails", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("ENOTFOUND");
		});
		const { handlers, ctx, telemetry } = harness();
		await handlers.session_start({ reason: "startup" }, ctx);
		await expect(telemetry.flush("test")).resolves.toBeUndefined();
	});

	it("skips the export when no credential is available", async () => {
		const { handlers, ctx, telemetry } = harness({ modelRegistry: { getProviderAuth: async () => undefined } });
		await handlers.session_start({ reason: "startup" }, ctx);
		await telemetry.flush("test");
		expect(bodies).toHaveLength(0);
	});

	it("flushes on shutdown", async () => {
		const { handlers, ctx } = harness();
		await handlers.session_start({ reason: "startup" }, ctx);
		await handlers.session_shutdown({ reason: "quit" }, ctx);
		expect(bodies).toHaveLength(1);
	});
});
