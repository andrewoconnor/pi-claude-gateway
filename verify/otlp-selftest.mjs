// Offline self-test for the OTLP exporter. Start verify/otlp-capture.mjs first,
// then run this. It asserts the payload shape without touching a real gateway.
//
//   node verify/otlp-capture.mjs &
//   node verify/otlp-selftest.mjs
//   kill %1

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configDir = "/tmp/pi-claude-gateway-selftest";
process.env.PI_CODING_AGENT_DIR = configDir;
mkdirSync(configDir, { recursive: true });
writeFileSync(
	join(configDir, "claude-gateway.json"),
	JSON.stringify({ url: "http://127.0.0.1:4319", telemetry: { serviceName: "claude-code", intervalMs: 5000 } }),
);

const { createTelemetry } = await import(join(here, "..", "telemetry.ts"));

const claims = Buffer.from(JSON.stringify({ email: "test@example.com", sub: "user-123" })).toString("base64url");
const handlers = {};
const pi = { on: (name, fn) => (handlers[name] = fn) };
const ctx = {
	sessionManager: { getSessionId: () => "selftest-session" },
	modelRegistry: { getProviderAuth: async () => ({ apiKey: `header.${claims}.signature` }) },
};

const telemetry = createTelemetry(pi, {
	providerId: "claude-gateway",
	gatewayUrl: () => "http://127.0.0.1:4319",
	userAgent: "selftest",
	version: "0.0.0",
});

await handlers.session_start({ reason: "startup" }, ctx);
await handlers.message_end(
	{
		message: {
			role: "assistant",
			provider: "claude-gateway",
			model: "anthropic.claude-haiku-4-5-20251001-v1:0",
			usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.0002 } },
		},
	},
	ctx,
);
await telemetry.flush("selftest");
console.log("exported. inspect the capture output for service.name, user.email and normalized model ids.");
