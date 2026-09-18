import { describe, expect, it } from "vitest";
import { isPrivateAddress, sameOrigin, toCredentials } from "../extensions/index.ts";

describe("toCredentials", () => {
	it("reads the standard OAuth token response", () => {
		const before = Date.now();
		const credentials = toCredentials({ access_token: "abc", refresh_token: "def", expires_in: 3600 });
		expect(credentials.access).toBe("abc");
		expect(credentials.refresh).toBe("def");
		expect(credentials.expires).toBeGreaterThan(before + 3500 * 1000);
		expect(credentials.expires).toBeLessThanOrEqual(before + 3600 * 1000);
	});

	it("renews early, so a request never carries a token that expires mid-flight", () => {
		const credentials = toCredentials({ access_token: "abc", expires_in: 3600 });
		const secondsEarly = (Date.now() + 3600 * 1000 - credentials.expires) / 1000;
		expect(secondsEarly).toBeGreaterThanOrEqual(59);
	});

	it("accepts the Claude Code credential field names", () => {
		const credentials = toCredentials({ jwt: "abc", idpRefreshToken: "def", expiresAt: Date.now() + 600_000 });
		expect(credentials.access).toBe("abc");
		expect(credentials.refresh).toBe("def");
	});

	it("defaults the lifetime when the gateway sends none", () => {
		const credentials = toCredentials({ access_token: "abc" });
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("treats a missing refresh token as empty rather than undefined", () => {
		expect(toCredentials({ access_token: "abc", expires_in: 60 }).refresh).toBe("");
	});

	it("throws when there is no access token", () => {
		expect(() => toCredentials({ refresh_token: "def" })).toThrow(/no access token/);
	});
});

describe("sameOrigin", () => {
	it("accepts an endpoint on the gateway origin", () => {
		expect(sameOrigin("https://gw.example.com/oauth/token", "https://gw.example.com")).toBe(
			"https://gw.example.com/oauth/token",
		);
	});

	it("rejects an endpoint on another origin, so a token cannot be redirected", () => {
		expect(() => sameOrigin("https://evil.example.com/oauth/token", "https://gw.example.com")).toThrow(
			/off-origin/,
		);
	});

	it("rejects a different port or scheme on the same host", () => {
		expect(() => sameOrigin("https://gw.example.com:8443/oauth/token", "https://gw.example.com")).toThrow(
			/off-origin/,
		);
		expect(() => sameOrigin("http://gw.example.com/oauth/token", "https://gw.example.com")).toThrow(/off-origin/);
	});

	it("returns undefined for a missing or unparseable value, so the caller uses its fallback", () => {
		expect(sameOrigin(undefined, "https://gw.example.com")).toBeUndefined();
		expect(sameOrigin("/oauth/token", "https://gw.example.com")).toBeUndefined();
	});
});

describe("isPrivateAddress", () => {
	it("recognizes the ranges a gateway is expected to live in", () => {
		for (const address of ["10.0.0.1", "192.168.0.1", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.1.1", "100.64.0.1"]) {
			expect(isPrivateAddress(address), address).toBe(true);
		}
		expect(isPrivateAddress("::1")).toBe(true);
		expect(isPrivateAddress("fd00::1")).toBe(true);
	});

	it("recognizes public addresses, which trigger the login warning", () => {
		for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "192.169.1.1", "203.0.113.5"]) {
			expect(isPrivateAddress(address), address).toBe(false);
		}
		expect(isPrivateAddress("2606:4700::1")).toBe(false);
	});
});
