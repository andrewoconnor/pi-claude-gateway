import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	certSha256,
	configPath,
	loadConfig,
	models,
	resetConfigCache,
	resolveGateway,
	telemetryEnabled,
	telemetryIncludeSessionId,
	telemetryIntervalMs,
	telemetryServiceName,
	validateUrl,
	writeConfig,
} from "../extensions/config.ts";

const GATEWAY = "https://gw.internal.example.com";
const ENV_KEYS = [
	"CLAUDE_GATEWAY_URL",
	"CLAUDE_GATEWAY_MODELS",
	"CLAUDE_GATEWAY_CERT_SHA256",
	"CLAUDE_GATEWAY_TELEMETRY",
	"CLAUDE_GATEWAY_TELEMETRY_SERVICE_NAME",
	"CLAUDE_GATEWAY_TELEMETRY_INTERVAL_MS",
	"CLAUDE_GATEWAY_TELEMETRY_INCLUDE_SESSION_ID",
];

let dir: string;

function writeFile(contents: unknown) {
	writeFileSync(join(dir, "claude-gateway.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
	resetConfigCache();
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-claude-gateway-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	for (const key of ENV_KEYS) delete process.env[key];
	resetConfigCache();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	for (const key of ENV_KEYS) delete process.env[key];
});

describe("validateUrl", () => {
	it("accepts https and strips trailing slashes", () => {
		expect(validateUrl("https://gw.example.com///", "test").url).toBe("https://gw.example.com");
	});

	it("rejects plain http on a non-loopback host", () => {
		const result = validateUrl("http://gw.example.com", "test");
		expect(result.url).toBeUndefined();
		expect(result.problem).toMatch(/https/);
	});

	it("allows http on loopback for local development", () => {
		expect(validateUrl("http://127.0.0.1:8080", "test").url).toBe("http://127.0.0.1:8080");
		expect(validateUrl("http://localhost:8080", "test").url).toBe("http://localhost:8080");
	});

	it("rejects a value that is not a URL", () => {
		expect(validateUrl("gw.example.com", "test").url).toBeUndefined();
	});
});

describe("resolveGateway", () => {
	it("reports a clear reason when nothing is configured", () => {
		const result = resolveGateway();
		expect(result.url).toBeUndefined();
		expect(result.source).toBe("nothing");
		expect(result.problem).toMatch(/unset/);
	});

	it("reads the config file when no variable is set", () => {
		writeFile({ url: GATEWAY });
		const result = resolveGateway();
		expect(result.url).toBe(GATEWAY);
		expect(result.source).toBe(configPath());
	});

	it("prefers the environment variable over the file", () => {
		writeFile({ url: GATEWAY });
		process.env.CLAUDE_GATEWAY_URL = "https://override.example.com";
		const result = resolveGateway();
		expect(result.url).toBe("https://override.example.com");
		expect(result.source).toBe("CLAUDE_GATEWAY_URL");
	});

	it("surfaces an unusable file value instead of falling back silently", () => {
		writeFile({ url: "http://public.example.com" });
		const result = resolveGateway();
		expect(result.url).toBeUndefined();
		expect(result.raw).toBe("http://public.example.com");
	});

	it("surfaces malformed JSON", () => {
		writeFile("{ not json");
		const result = resolveGateway();
		expect(result.url).toBeUndefined();
		expect(result.problem).toMatch(/could not be read/);
	});

	it("reports a file with no url field", () => {
		writeFile({ telemetry: { serviceName: "pi" } });
		expect(resolveGateway().problem).toMatch(/no config file supplies a url|unset/);
	});
});

describe("telemetry settings", () => {
	it("defaults to enabled, service name pi, 60s, session ids on", () => {
		expect(telemetryEnabled()).toEqual({ value: true, source: "default" });
		expect(telemetryServiceName()).toEqual({ value: "pi", source: "default" });
		expect(telemetryIntervalMs()).toEqual({ value: 60_000, source: "default" });
		expect(telemetryIncludeSessionId()).toEqual({ value: true, source: "default" });
	});

	it("reads each value from the config file and records the source", () => {
		writeFile({
			url: GATEWAY,
			telemetry: { enabled: false, serviceName: "claude-code", intervalMs: 15_000, includeSessionId: false },
		});
		expect(telemetryEnabled().value).toBe(false);
		expect(telemetryServiceName()).toEqual({ value: "claude-code", source: configPath() });
		expect(telemetryIntervalMs().value).toBe(15_000);
		expect(telemetryIncludeSessionId().value).toBe(false);
	});

	it("lets the environment override the file", () => {
		writeFile({ url: GATEWAY, telemetry: { serviceName: "claude-code" } });
		process.env.CLAUDE_GATEWAY_TELEMETRY_SERVICE_NAME = "from-env";
		expect(telemetryServiceName()).toEqual({ value: "from-env", source: "CLAUDE_GATEWAY_TELEMETRY_SERVICE_NAME" });
	});

	it("treats 0, false, no and off as disabled", () => {
		for (const value of ["0", "false", "no", "off", "FALSE"]) {
			process.env.CLAUDE_GATEWAY_TELEMETRY = value;
			expect(telemetryEnabled().value, `value ${value}`).toBe(false);
		}
		process.env.CLAUDE_GATEWAY_TELEMETRY = "1";
		expect(telemetryEnabled().value).toBe(true);
	});

	it("ignores an interval below the 5s floor", () => {
		process.env.CLAUDE_GATEWAY_TELEMETRY_INTERVAL_MS = "100";
		expect(telemetryIntervalMs().value).toBe(60_000);
		process.env.CLAUDE_GATEWAY_TELEMETRY_INTERVAL_MS = "5000";
		expect(telemetryIntervalMs().value).toBe(5000);
	});
});

describe("models and certificate pin", () => {
	it("falls back to the built-in catalog", () => {
		expect(models()).toEqual({ value: undefined, source: "built-in catalog" });
	});

	it("reads a model list from the file and lets the environment win", () => {
		writeFile({ url: GATEWAY, models: "claude-opus-5" });
		expect(models().value).toBe("claude-opus-5");
		process.env.CLAUDE_GATEWAY_MODELS = "claude-sonnet-5";
		expect(models()).toEqual({ value: "claude-sonnet-5", source: "CLAUDE_GATEWAY_MODELS" });
	});

	it("normalizes a fingerprint by removing colons and lowercasing", () => {
		process.env.CLAUDE_GATEWAY_CERT_SHA256 = "AB:CD:ef:01";
		expect(certSha256().value).toBe("abcdef01");
	});

	it("reports an unpinned certificate", () => {
		expect(certSha256()).toEqual({ value: undefined, source: "not pinned" });
	});
});

describe("writeConfig", () => {
	it("merges into an existing file instead of replacing it", () => {
		writeFile({ url: GATEWAY, models: "claude-opus-5", telemetry: { serviceName: "claude-code" } });
		writeConfig({ telemetry: { intervalMs: 30_000 } });
		const merged = loadConfig();
		expect(merged.url).toBe(GATEWAY);
		expect(merged.models).toBe("claude-opus-5");
		expect(merged.telemetry).toEqual({ serviceName: "claude-code", intervalMs: 30_000 });
	});

	it("creates the file when none exists", () => {
		const path = writeConfig({ url: GATEWAY });
		expect(path).toBe(configPath());
		resetConfigCache();
		expect(resolveGateway().url).toBe(GATEWAY);
	});
});
