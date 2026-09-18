import { hostname } from "node:os";
import { arch, platform } from "node:process";
import {
	telemetryDebug,
	telemetryEnabled,
	telemetryIncludeSessionId,
	telemetryIntervalMs,
	telemetryServiceName,
} from "./config.ts";

const SCOPE_NAME = "pi-claude-gateway";

const DEFAULT_INTERVAL_MS = 60_000;
const START_NANOS = String(Date.now() * 1_000_000);
const processId = `pi-${process.pid}-${Date.now().toString(36)}`;

type Attrs = Record<string, string | undefined>;

interface Point {
	attrs: Attrs;
	value: number;
}

interface Counter {
	name: string;
	unit?: string;
	isInt: boolean;
	points: Map<string, Point>;
}

interface Identity {
	email?: string;
	subject?: string;
}

export interface TelemetryOptions {
	providerId: string;
	gatewayUrl: () => string;
	userAgent: string;
	version: string;
}

function enabled(): boolean {
	return telemetryEnabled().value;
}

function debug(): boolean {
	return telemetryDebug();
}

function serviceName(): string {
	return telemetryServiceName().value;
}

function intervalMs(): number {
	return telemetryIntervalMs().value;
}

function includeSessionId(): boolean {
	return telemetryIncludeSessionId().value;
}

function decodeIdentity(token: string): Identity {
	try {
		const segment = token.split(".")[1];
		if (!segment) return {};
		const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
		const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
		return {
			email: typeof claims.email === "string" ? claims.email : undefined,
			subject: typeof claims.sub === "string" ? claims.sub : undefined,
		};
	} catch {
		return {};
	}
}

function attrKeyOf(attrs: Attrs): string {
	return Object.keys(attrs)
		.filter((key) => attrs[key] !== undefined && attrs[key] !== "")
		.sort()
		.map((key) => `${key}=${attrs[key]}`)
		.join("\u0001");
}

function toOtlpAttrs(attrs: Attrs): { key: string; value: { stringValue: string } }[] {
	return Object.entries(attrs)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

export function normalizeModel(id: string): string {
	return id
		.replace(/^(?:us|eu|apac|global)\./, "")
		.replace(/^anthropic\./, "")
		.replace(/-v\d+:\d+$/, "");
}

export function createTelemetry(pi: any, options: TelemetryOptions) {
	const SCOPE_VERSION = options.version;
	if (!enabled()) return;

	const counters = new Map<string, Counter>();
	const resourceAttrs: Attrs = {
		"service.name": serviceName(),
		"service.version": SCOPE_VERSION,
		"os.type": platform,
		"host.arch": arch,
		"host.name": hostname(),
	};

	let context: any;
	let identity: Identity = {};
	let sessionId: string | undefined;
	let timer: NodeJS.Timeout | undefined;
	let turnStartedAt: number | undefined;
	let promptStartedAt: number | undefined;
	let exporting = false;

	function add(name: string, unit: string | undefined, isInt: boolean, attrs: Attrs, value: number) {
		if (!Number.isFinite(value) || value <= 0) return;
		let counter = counters.get(name);
		if (!counter) {
			counter = { name, unit, isInt, points: new Map() };
			counters.set(name, counter);
		}
		const merged: Attrs = {
			...attrs,
			"session.id": includeSessionId() ? (sessionId ?? processId) : undefined,
		};
		const key = attrKeyOf(merged);
		const point = counter.points.get(key);
		if (point) point.value += value;
		else counter.points.set(key, { attrs: merged, value });
	}

	function identityAttrs(): Attrs {
		return {
			"user.email": identity.email,
			"user.id": identity.subject,
			"identity.source": identity.email ? "gateway-oidc" : undefined,
			"app.entrypoint": "pi",
			"client.name": "pi",
		};
	}

	function payload() {
		const now = String(Date.now() * 1_000_000);
		const metrics = [...counters.values()].map((counter) => ({
			name: counter.name,
			...(counter.unit ? { unit: counter.unit } : {}),
			sum: {
				aggregationTemporality: 2,
				isMonotonic: true,
				dataPoints: [...counter.points.values()].map((point) => ({
					attributes: toOtlpAttrs({ ...point.attrs, ...identityAttrs() }),
					startTimeUnixNano: START_NANOS,
					timeUnixNano: now,
					...(counter.isInt ? { asInt: String(Math.round(point.value)) } : { asDouble: point.value }),
				})),
			},
		}));
		return {
			resourceMetrics: [
				{
					resource: { attributes: toOtlpAttrs(resourceAttrs) },
					scopeMetrics: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, metrics }],
				},
			],
		};
	}

	async function token(): Promise<string | undefined> {
		try {
			const auth = await context?.modelRegistry?.getProviderAuth?.(options.providerId);
			return auth?.apiKey ?? auth?.auth?.apiKey;
		} catch {
			return undefined;
		}
	}

	async function flush(reason: string) {
		if (exporting || counters.size === 0) return;
		const bearer = await token();
		if (!bearer) return;
		if (!identity.email) identity = decodeIdentity(bearer);
		exporting = true;
		try {
			const response = await fetch(`${options.gatewayUrl()}/v1/metrics`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${bearer}`,
					"content-type": "application/json",
					"user-agent": options.userAgent,
				},
				redirect: "error",
				body: JSON.stringify(payload()),
			});
			if (debug()) {
				const detail = response.ok ? "" : ` ${(await response.text()).slice(0, 200)}`;
				console.error(`[claude-gateway-telemetry] ${reason} -> ${response.status}${detail}`);
			}
		} catch (error) {
			if (debug()) console.error(`[claude-gateway-telemetry] ${reason} failed:`, error);
		} finally {
			exporting = false;
		}
	}

	function start() {
		if (timer) return;
		timer = setInterval(() => void flush("interval"), intervalMs());
		timer.unref?.();
	}

	function stop() {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	pi.on("session_start", async (event: any, ctx: any) => {
		context = ctx;
		sessionId = ctx?.sessionManager?.getSessionId?.();
		if (event?.reason === "reload") return start();
		const startType = event?.reason === "resume" ? "resume" : "fresh";
		add("claude_code.session.count", undefined, true, { start_type: startType }, 1);
		start();
	});

	pi.on("ui_prompt_start", async (_event: any, ctx: any) => {
		context = ctx;
		promptStartedAt = Date.now();
	});

	pi.on("ui_prompt_end", async (_event: any, ctx: any) => {
		context = ctx;
		if (promptStartedAt === undefined) return;
		add("claude_code.active_time.total", "s", false, { type: "user" }, (Date.now() - promptStartedAt) / 1000);
		promptStartedAt = undefined;
	});

	pi.on("turn_start", async (_event: any, ctx: any) => {
		context = ctx;
		turnStartedAt = Date.now();
	});

	pi.on("turn_end", async (_event: any, ctx: any) => {
		context = ctx;
		if (turnStartedAt === undefined) return;
		add("claude_code.active_time.total", "s", false, { type: "cli" }, (Date.now() - turnStartedAt) / 1000);
		turnStartedAt = undefined;
	});

	pi.on("message_end", async (event: any, ctx: any) => {
		context = ctx;
		const message = event?.message;
		if (message?.role !== "assistant") return;
		if (message.provider !== options.providerId) return;
		const usage = message.usage;
		if (!usage) return;
		const model = normalizeModel(String(message.model ?? ctx?.model?.id ?? "unknown"));
		const base: Attrs = { model, query_source: "main" };
		add("claude_code.token.usage", "tokens", true, { ...base, type: "input" }, usage.input ?? 0);
		add("claude_code.token.usage", "tokens", true, { ...base, type: "output" }, usage.output ?? 0);
		add("claude_code.token.usage", "tokens", true, { ...base, type: "cacheRead" }, usage.cacheRead ?? 0);
		add("claude_code.token.usage", "tokens", true, { ...base, type: "cacheCreation" }, usage.cacheWrite ?? 0);
		add("claude_code.cost.usage", "USD", false, base, usage.cost?.total ?? 0);
	});

	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		context = ctx;
		stop();
		await flush("shutdown");
	});

	return { flush, stop };
}
