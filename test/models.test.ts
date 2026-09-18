import { describe, expect, it } from "vitest";
import { CATALOG, selectModels, unknownModelIds } from "../extensions/models.ts";

describe("CATALOG", () => {
	it("has unique ids", () => {
		const ids = CATALOG.map((model) => model.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("declares a price, a window and an output cap for every entry", () => {
		for (const model of CATALOG) {
			expect(model.contextWindow, model.id).toBeGreaterThan(0);
			expect(model.maxTokens, model.id).toBeGreaterThan(0);
			expect(model.maxTokens, model.id).toBeLessThanOrEqual(model.contextWindow);
			expect(model.cost.input, model.id).toBeGreaterThan(0);
			expect(model.cost.output, model.id).toBeGreaterThan(0);
		}
	});

	it("disables long cache retention everywhere, because gateways lack the 1h TTL", () => {
		for (const model of CATALOG) {
			expect(model.compat?.supportsLongCacheRetention, model.id).toBe(false);
		}
	});

	it("never claims strict tools or mid-conversation effort on a gateway transport", () => {
		for (const model of CATALOG) {
			expect(model.compat?.supportsStrictTools, model.id).toBeUndefined();
			expect(model.compat?.supportsMidConvoEffort, model.id).toBeUndefined();
		}
	});
});

describe("selectModels", () => {
	it("prefers the short alias and hides the dated duplicate by default", () => {
		const ids = selectModels(undefined).map((model) => model.id);
		expect(ids).toContain("claude-haiku-4-5");
		expect(ids).not.toContain("claude-haiku-4-5-20251001");
	});

	it("returns the requested subset in order", () => {
		const ids = selectModels("claude-sonnet-5,claude-opus-5").map((model) => model.id);
		expect(ids).toEqual(["claude-sonnet-5", "claude-opus-5"]);
	});

	it("strips a bracketed suffix such as [1m]", () => {
		const ids = selectModels("claude-opus-5[1m]").map((model) => model.id);
		expect(ids).toEqual(["claude-opus-5"]);
	});

	it("tolerates whitespace and empty entries", () => {
		const ids = selectModels(" claude-opus-5 , ,claude-sonnet-5 ").map((model) => model.id);
		expect(ids).toEqual(["claude-opus-5", "claude-sonnet-5"]);
	});

	it("registers an unknown id conservatively rather than dropping it", () => {
		const [model] = selectModels("some-private-model");
		expect(model.id).toBe("some-private-model");
		expect(model.contextWindow).toBe(200_000);
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(model.compat?.supportsLongCacheRetention).toBe(false);
	});

	it("keeps catalog pricing for a known id", () => {
		const [model] = selectModels("claude-opus-5");
		expect(model.cost.input).toBe(5);
		expect(model.contextWindow).toBe(1_000_000);
	});
});

describe("unknownModelIds", () => {
	it("is empty for the default catalog and for known ids", () => {
		expect(unknownModelIds(undefined)).toEqual([]);
		expect(unknownModelIds("claude-opus-5,claude-sonnet-5")).toEqual([]);
	});

	it("reports only the ids with no pricing data", () => {
		expect(unknownModelIds("claude-opus-5,mystery-model")).toEqual(["mystery-model"]);
	});

	it("does not report an id that only differs by a stripped suffix", () => {
		expect(unknownModelIds("claude-opus-5[1m]")).toEqual([]);
	});
});
