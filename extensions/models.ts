export interface GatewayModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, boolean>;
}

const LONG_CACHE_OFF = { supportsLongCacheRetention: false };

export const CATALOG: GatewayModel[] = [
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		compat: { ...LONG_CACHE_OFF, forceAdaptiveThinking: true, supportsTemperature: false },
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		compat: { ...LONG_CACHE_OFF, forceAdaptiveThinking: true },
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		compat: { ...LONG_CACHE_OFF },
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5 (dated ID)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		compat: { ...LONG_CACHE_OFF },
	},
];

export function selectModels(requested: string | undefined): GatewayModel[] {
	if (!requested) return CATALOG.filter((model) => model.id !== "claude-haiku-4-5-20251001");
	const wanted = requested
		.split(",")
		.map((entry) => entry.trim().replace(/\[[^\]]*\]$/, ""))
		.filter(Boolean);
	const chosen: GatewayModel[] = [];
	for (const id of wanted) {
		const known = CATALOG.find((model) => model.id === id);
		chosen.push(
			known ?? {
				id,
				name: id,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
				compat: { ...LONG_CACHE_OFF },
			},
		);
	}
	return chosen;
}

export function unknownModelIds(requested: string | undefined): string[] {
	if (!requested) return [];
	return requested
		.split(",")
		.map((entry) => entry.trim().replace(/\[[^\]]*\]$/, ""))
		.filter((id) => id && !CATALOG.some((model) => model.id === id));
}
