import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lookup } from "node:dns/promises";
import {
	certSha256,
	configPath,
	isLoopbackHost,
	models as configuredModels,
	resolveGateway,
	telemetryServiceName,
	validateUrl,
	writeConfig,
} from "./config.ts";
import tls from "node:tls";
import { selectModels, unknownModelIds } from "./models.ts";
import { createTelemetry } from "./telemetry.ts";

const PROVIDER_ID = "claude-gateway";
const PROVIDER_NAME = "Claude apps gateway";
export const VERSION = "0.1.0";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SURFACE = "pi";
const USER_AGENT = `pi-claude-gateway/${VERSION} (${SURFACE})`;
const FORM_HEADERS = {
	"content-type": "application/x-www-form-urlencoded",
	"user-agent": USER_AGENT,
};
const EXPIRY_SKEW_MS = 60_000;
const OFFLINE_CODES = [
	"ENOTFOUND",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNRESET",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
];

interface DeviceGrant {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface Endpoints {
	deviceAuthorization: string;
	token: string;
}

export function gatewayUrl(): string | undefined {
	return resolveGateway().url;
}

export function isPrivateAddress(address: string): boolean {
	if (address.includes(":")) return /^(::1|f[cd])/i.test(address);
	const [a, b] = address.split(".").map(Number);
	if (a === 10 || a === 127) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 169 && b === 254) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}

function base(): string {
	const url = gatewayUrl();
	if (!url) {
		throw new Error(
			"CLAUDE_GATEWAY_URL is not set to an https:// gateway origin. See the README for setup.",
		);
	}
	return url;
}

function describeNetworkError(error: unknown): string {
	const code =
		(error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
	if (code && OFFLINE_CODES.includes(code)) {
		return "Cannot reach the gateway. Most gateways are private, so check your VPN or network route";
	}
	return error instanceof Error ? error.message : String(error);
}

async function request(url: string, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		throw new Error(`${describeNetworkError(error)} — ${url}`);
	}
}

async function leafFingerprint(target: string): Promise<string | undefined> {
	const { hostname, port, protocol } = new URL(target);
	if (protocol !== "https:") return undefined;
	return await new Promise<string | undefined>((resolve) => {
		const socket = tls.connect({ host: hostname, port: Number(port) || 443, servername: hostname }, () => {
			const cert = socket.getPeerCertificate(false);
			socket.end();
			resolve(cert?.fingerprint256?.replace(/:/g, "").toLowerCase());
		});
		socket.setTimeout(5000, () => {
			socket.destroy();
			resolve(undefined);
		});
		socket.on("error", () => resolve(undefined));
	});
}

async function warnIfPublic(target: string, callbacks: OAuthLoginCallbacks): Promise<void> {
	const { hostname } = new URL(target);
	if (isLoopbackHost(hostname)) return;
	try {
		const addresses = await lookup(hostname, { all: true });
		if (addresses.some((entry) => !isPrivateAddress(entry.address))) {
			callbacks.onProgress?.(
				`Warning: ${hostname} resolves to a public address. A trusted gateway can push settings to this machine.`,
			);
		}
	} catch {
		return;
	}
}

async function reportCertificate(callbacks: OAuthLoginCallbacks): Promise<void> {
	const observed = await leafFingerprint(base());
	if (!observed) return;
	const expected = certSha256().value;
	if (expected && expected !== observed) {
		throw new Error(
			`Gateway certificate sha256 is ${observed}, but the configured pin expects ${expected}. Stopping sign-in.`,
		);
	}
	callbacks.onProgress?.(
		expected
			? `Gateway certificate pin matched (${observed.slice(0, 16)})`
			: `Gateway certificate sha256 starts ${observed.slice(0, 16)} — compare it with the fingerprint your administrator published`,
	);
}

export function sameOrigin(candidate: string | undefined, origin: string): string | undefined {
	if (!candidate) return undefined;
	try {
		if (new URL(candidate).origin !== new URL(origin).origin) {
			throw new Error(`The gateway advertised an off-origin OAuth endpoint: ${candidate}`);
		}
		return candidate;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("The gateway advertised")) throw error;
		return undefined;
	}
}

export async function endpoints(signal?: AbortSignal): Promise<Endpoints> {
	const origin = base();
	const fallback: Endpoints = {
		deviceAuthorization: `${origin}/oauth/device_authorization`,
		token: `${origin}/oauth/token`,
	};
	const response = await request(`${origin}/.well-known/oauth-authorization-server`, {
		redirect: "error",
		headers: { "user-agent": USER_AGENT },
		signal,
	});
	if (!response.ok) return fallback;
	const doc = (await response.json().catch(() => ({}))) as Record<string, string | undefined>;
	return {
		deviceAuthorization: sameOrigin(doc.device_authorization_endpoint, origin) ?? fallback.deviceAuthorization,
		token: sameOrigin(doc.token_endpoint, origin) ?? fallback.token,
	};
}

export function toCredentials(payload: Record<string, unknown>): OAuthCredentials {
	const access = (payload.access_token ?? payload.jwt) as string | undefined;
	if (!access) throw new Error("The gateway token response carried no access token.");
	const refresh = (payload.refresh_token ?? payload.idpRefreshToken ?? "") as string;
	const expiresIn = payload.expires_in;
	const expiresAt = payload.expiresAt;
	const expires =
		typeof expiresIn === "number"
			? Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS
			: typeof expiresAt === "number"
				? expiresAt - EXPIRY_SKEW_MS
				: Date.now() + 55 * 60 * 1000;
	return { access, refresh, expires };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForToken(tokenEndpoint: string, grant: DeviceGrant): Promise<OAuthCredentials> {
	let intervalMs = Math.max(1, grant.interval ?? 5) * 1000;
	const deadline = Date.now() + (grant.expires_in ?? 600) * 1000;
	while (Date.now() < deadline) {
		await sleep(intervalMs);
		const response = await request(tokenEndpoint, {
			method: "POST",
			headers: FORM_HEADERS,
			redirect: "error",
			body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: grant.device_code }).toString(),
		});
		const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (response.ok) return toCredentials(payload);
		const error = payload.error as string | undefined;
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		if (error === "access_denied") {
			throw new Error("The gateway denied the sign-in. Check your identity-provider group and email domain.");
		}
		if (error === "expired_token") break;
		throw new Error(`Gateway sign-in failed: ${response.status} ${error ?? JSON.stringify(payload)}`);
	}
	throw new Error("Gateway sign-in expired before you confirmed the code. Run /login again.");
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	await warnIfPublic(base(), callbacks);
	await reportCertificate(callbacks);
	const { deviceAuthorization, token } = await endpoints();
	const response = await request(deviceAuthorization, {
		method: "POST",
		headers: FORM_HEADERS,
		redirect: "error",
		body: new URLSearchParams({ surface: SURFACE }).toString(),
	});
	if (!response.ok) {
		throw new Error(`Device authorization failed: ${response.status} ${await response.text()}`);
	}
	const grant = (await response.json()) as DeviceGrant;
	if (!grant.device_code || !grant.user_code) {
		throw new Error("The gateway returned an incomplete device authorization response.");
	}
	callbacks.onDeviceCode({
		userCode: grant.user_code,
		verificationUri: grant.verification_uri_complete ?? grant.verification_uri,
		intervalSeconds: grant.interval ?? 5,
		expiresInSeconds: grant.expires_in ?? 600,
	});
	return await pollForToken(token, grant);
}

export async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	if (!credentials.refresh) {
		throw new Error(
			`The gateway issued no refresh token, so the session cannot renew. Run /login ${PROVIDER_ID}.`,
		);
	}
	signal.throwIfAborted();
	const { token } = await endpoints(signal);
	const response = await request(token, {
		method: "POST",
		headers: FORM_HEADERS,
		redirect: "error",
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refresh }).toString(),
		signal,
	});
	if (response.status === 401) {
		throw new Error(
			`The gateway rejected the refresh token. Your identity provider may have deprovisioned you. Run /login ${PROVIDER_ID}.`,
		);
	}
	if (!response.ok) {
		throw new Error(
			`Gateway token refresh failed: ${response.status} ${await response.text()}. Run /login ${PROVIDER_ID}.`,
		);
	}
	const next = toCredentials((await response.json()) as Record<string, unknown>);
	return { ...next, refresh: next.refresh || credentials.refresh };
}

function setupReport(): string {
	const resolved = resolveGateway();
	const service = telemetryServiceName();
	const catalog = configuredModels();
	const pin = certSha256();
	const lines = [
		`config file : ${configPath()}`,
		`models      : ${catalog.value ?? "built-in catalog"}   (${catalog.source})`,
		`cert pin    : ${pin.value ? `${pin.value.slice(0, 16)}…` : "not pinned"}   (${pin.source})`,
		`telemetry service.name: ${service.value}   (${service.source})`,
	];
	if (resolved.url) {
		return [
			`gateway     : ${resolved.url}   (${resolved.source})`,
			...lines,
			"",
			"Provider claude-gateway is registered. Run /login claude-gateway.",
		].join("\n");
	}
	const detail = resolved.raw ? `${resolved.source} value "${resolved.raw}" ${resolved.problem}` : resolved.problem;
	return [
		"No gateway is configured, so the claude-gateway provider is NOT registered.",
		`reason      : ${detail}`,
		...lines,
		"",
		"Set it once, for every future session:",
		"  /gateway-setup https://claude-gateway.internal.example.com",
		"",
		"Environment changes need a new pi process; /reload cannot alter a running process.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("gateway-setup", {
		description: "Show or set the Claude apps gateway URL",
		handler: async (args: string, ctx: Record<string, any>) => {
			const requested = args?.trim();
			if (!requested) {
				ctx.ui?.notify?.(setupReport(), resolveGateway().url ? "info" : "error");
				return;
			}
			const checked = validateUrl(requested, "argument");
			if (!checked.url) {
				ctx.ui?.notify?.(`"${requested}" ${checked.problem}`, "error");
				return;
			}
			const path = writeConfig({ url: checked.url });
			ctx.ui?.notify?.(
				[`Wrote ${path}`, `Gateway: ${checked.url}`, "", "Restart pi, then run /login claude-gateway."].join("\n"),
				"info",
			);
		},
	} as never);

	const resolved = resolveGateway();
	const url = resolved.url;

	if (!url) {
		pi.on("session_start", async (_event: unknown, ctx: Record<string, any>) => {
			ctx.ui?.setStatus?.("claude-gateway", "claude-gateway: not configured, run /gateway-setup");
		});
		return;
	}

	const envToken = process.env.CLAUDE_GATEWAY_TOKEN;
	const requested = configuredModels().value;

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: url,
		api: "anthropic-messages",
		...(envToken ? { apiKey: "$CLAUDE_GATEWAY_TOKEN" } : {}),
		authHeader: true,
		models: selectModels(requested),
		oauth: {
			name: PROVIDER_NAME,
			login,
			refreshToken,
			getApiKey: (credentials: OAuthCredentials) => credentials.access,
		},
	});

	createTelemetry(pi, { providerId: PROVIDER_ID, gatewayUrl: base, userAgent: USER_AGENT, version: VERSION });

	pi.registerCommand("gateway-models", {
		description: "List the models the gateway advertises",
		handler: async (_args: string, ctx: Record<string, any>) => {
			const notify = (message: string, level: "info" | "error" = "info") => ctx.ui?.notify?.(message, level);
			const unknown = unknownModelIds(requested);
			if (unknown.length) {
				notify(`These model IDs have no pricing data in the catalog: ${unknown.join(", ")}`, "error");
			}
			try {
				const auth = await ctx.modelRegistry?.getProviderAuth?.(PROVIDER_ID);
				const key: string | undefined = auth?.apiKey ?? auth?.auth?.apiKey;
				if (!key) {
					notify(`Not signed in. Run /login ${PROVIDER_ID}.`, "error");
					return;
				}
				const response = await request(`${url}/v1/models?limit=1000`, {
					headers: { authorization: `Bearer ${key}`, "user-agent": USER_AGENT },
					redirect: "error",
				});
				if (response.status === 404) {
					notify("This gateway does not implement /v1/models. The built-in catalog is in use.");
					return;
				}
				if (!response.ok) {
					notify(`Model discovery failed: ${response.status} ${await response.text()}`, "error");
					return;
				}
				const body = (await response.json()) as { data?: { id: string; display_name?: string }[] };
				const rows = (body.data ?? []).map(
					(entry) => `  ${entry.id}${entry.display_name && entry.display_name !== entry.id ? ` — ${entry.display_name}` : ""}`,
				);
				notify(rows.length ? `Gateway models:\n${rows.join("\n")}` : "The gateway returned no models.");
			} catch (error) {
				notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	} as never);
}
