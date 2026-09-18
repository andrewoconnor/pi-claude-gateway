import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TelemetryConfig {
	enabled?: boolean;
	serviceName?: string;
	intervalMs?: number;
	includeSessionId?: boolean;
}

export interface FileConfig {
	url?: string;
	models?: string;
	certSha256?: string;
	telemetry?: TelemetryConfig;
}

export interface Resolution {
	url?: string;
	source: string;
	raw?: string;
	problem?: string;
}

export interface Sourced<T> {
	value: T;
	source: string;
}

export function configPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(dir, "claude-gateway.json");
}

let cache: { loaded: boolean; data: FileConfig; error?: string } = { loaded: false, data: {} };

export function resetConfigCache(): void {
	cache = { loaded: false, data: {} };
}

export function loadConfig(): FileConfig {
	if (cache.loaded) return cache.data;
	try {
		const data = JSON.parse(readFileSync(configPath(), "utf8")) as FileConfig;
		cache = { loaded: true, data: data && typeof data === "object" ? data : {} };
	} catch (error) {
		const code = (error as { code?: string }).code;
		cache = {
			loaded: true,
			data: {},
			error: code === "ENOENT" ? undefined : `could not be read: ${(error as Error).message}`,
		};
	}
	return cache.data;
}

export function configError(): string | undefined {
	loadConfig();
	return cache.error;
}

export function writeConfig(patch: FileConfig): string {
	const path = configPath();
	mkdirSync(join(path, ".."), { recursive: true });
	const current = loadConfig();
	const merged: FileConfig = {
		...current,
		...patch,
		...(patch.telemetry || current.telemetry
			? { telemetry: { ...current.telemetry, ...patch.telemetry } }
			: {}),
	};
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
	cache = { loaded: true, data: merged };
	return path;
}

export function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function validateUrl(raw: string, source: string): Resolution {
	const normalized = raw.trim().replace(/\/+$/, "");
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
			return { source, raw, problem: "must use https://, or a loopback host for local development" };
		}
		return { url: normalized, source };
	} catch {
		return { source, raw, problem: "is not a valid URL" };
	}
}

export function resolveGateway(): Resolution {
	const fromEnv = process.env.CLAUDE_GATEWAY_URL?.trim();
	if (fromEnv) return validateUrl(fromEnv, "CLAUDE_GATEWAY_URL");
	const error = configError();
	if (error) return { source: configPath(), problem: error };
	const raw = loadConfig().url?.trim();
	if (raw) return validateUrl(raw, configPath());
	return { source: "nothing", problem: "CLAUDE_GATEWAY_URL is unset and no config file supplies a url" };
}

function envFlag(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export function models(): Sourced<string | undefined> {
	const fromEnv = process.env.CLAUDE_GATEWAY_MODELS?.trim();
	if (fromEnv) return { value: fromEnv, source: "CLAUDE_GATEWAY_MODELS" };
	const fromFile = loadConfig().models?.trim();
	if (fromFile) return { value: fromFile, source: configPath() };
	return { value: undefined, source: "built-in catalog" };
}

export function certSha256(): Sourced<string | undefined> {
	const fromEnv = process.env.CLAUDE_GATEWAY_CERT_SHA256?.trim();
	if (fromEnv) return { value: normalizeFingerprint(fromEnv), source: "CLAUDE_GATEWAY_CERT_SHA256" };
	const fromFile = loadConfig().certSha256?.trim();
	if (fromFile) return { value: normalizeFingerprint(fromFile), source: configPath() };
	return { value: undefined, source: "not pinned" };
}

function normalizeFingerprint(raw: string): string {
	return raw.replace(/:/g, "").toLowerCase();
}

export function telemetryEnabled(): Sourced<boolean> {
	const fromEnv = envFlag("CLAUDE_GATEWAY_TELEMETRY");
	if (fromEnv !== undefined) return { value: fromEnv, source: "CLAUDE_GATEWAY_TELEMETRY" };
	const fromFile = loadConfig().telemetry?.enabled;
	if (fromFile !== undefined) return { value: fromFile, source: configPath() };
	return { value: true, source: "default" };
}

export function telemetryServiceName(): Sourced<string> {
	const fromEnv = process.env.CLAUDE_GATEWAY_TELEMETRY_SERVICE_NAME?.trim();
	if (fromEnv) return { value: fromEnv, source: "CLAUDE_GATEWAY_TELEMETRY_SERVICE_NAME" };
	const fromFile = loadConfig().telemetry?.serviceName?.trim();
	if (fromFile) return { value: fromFile, source: configPath() };
	return { value: "pi", source: "default" };
}

export function telemetryIntervalMs(): Sourced<number> {
	const raw = Number(process.env.CLAUDE_GATEWAY_TELEMETRY_INTERVAL_MS);
	if (Number.isFinite(raw) && raw >= 5000) {
		return { value: raw, source: "CLAUDE_GATEWAY_TELEMETRY_INTERVAL_MS" };
	}
	const fromFile = loadConfig().telemetry?.intervalMs;
	if (typeof fromFile === "number" && fromFile >= 5000) return { value: fromFile, source: configPath() };
	return { value: 60_000, source: "default" };
}

export function telemetryIncludeSessionId(): Sourced<boolean> {
	const fromEnv = envFlag("CLAUDE_GATEWAY_TELEMETRY_INCLUDE_SESSION_ID");
	if (fromEnv !== undefined) return { value: fromEnv, source: "CLAUDE_GATEWAY_TELEMETRY_INCLUDE_SESSION_ID" };
	const fromFile = loadConfig().telemetry?.includeSessionId;
	if (fromFile !== undefined) return { value: fromFile, source: configPath() };
	return { value: true, source: "default" };
}

export function telemetryDebug(): boolean {
	return process.env.CLAUDE_GATEWAY_TELEMETRY_DEBUG === "1";
}
