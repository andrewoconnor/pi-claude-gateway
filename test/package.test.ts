import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../extensions/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("package metadata", () => {
	it("reports the same version as package.json", () => {
		expect(VERSION).toBe(pkg.version);
	});

	it("has the version in the changelog", () => {
		expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(`[${pkg.version}]`);
	});

	it("carries the pi-package keyword, so the gallery lists it", () => {
		expect(pkg.keywords).toContain("pi-package");
	});

	it("declares the pi extension entry point", () => {
		expect(pkg.pi.extensions).toEqual(["./extensions/index.ts"]);
	});

	it("ships every path the readme links to", () => {
		const readme = readFileSync(join(root, "README.md"), "utf8");
		for (const link of readme.matchAll(/\]\((docs\/[^)]+)\)/g)) {
			expect(() => readFileSync(join(root, link[1]), "utf8"), link[1]).not.toThrow();
		}
	});

	it("keeps pi core packages as optional peer dependencies, not bundled", () => {
		for (const [name, range] of Object.entries(pkg.peerDependencies as Record<string, string>)) {
			expect(range, name).toBe("*");
			expect(pkg.peerDependenciesMeta[name].optional, name).toBe(true);
		}
		expect(pkg.dependencies).toBeUndefined();
	});
});

describe("shipped files carry no private data", () => {
	const shipped = ["README.md", "CHANGELOG.md", "docs/reference.md", "docs/telemetry.md", "docs/development.md"];
	const everyFile = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter((name) => name && name !== "package-lock.json");

	it("uses example.com hostnames only", () => {
		for (const file of shipped) {
			const text = readFileSync(join(root, file), "utf8");
			for (const url of text.matchAll(/https?:\/\/([a-z0-9.-]+)/g)) {
				const host = url[1];
				const allowed =
					host.endsWith("example.com") ||
					host === "localhost" ||
					host === "127.0.0.1" ||
					["github.com", "raw.githubusercontent.com", "code.claude.com", "platform.claude.com", "keepachangelog.com", "semver.org", "npmjs.com"].includes(host);
				expect(allowed, `${file} references ${host}`).toBe(true);
			}
		}
	});

	it("uses only canonical private addresses, never a real host from a real network", () => {
		const canonical = new Set([
			"0.0.0.0",
			"10.0.0.1",
			"127.0.0.1",
			"169.254.1.1",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.0.1",
			"192.168.1.1",
			"100.64.0.1",
		]);
		const privateRange = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g;
		for (const file of everyFile) {
			const text = readFileSync(join(root, file), "utf8");
			for (const match of text.matchAll(privateRange)) {
				expect(canonical.has(match[0]), `${file} embeds ${match[0]}`).toBe(true);
			}
		}
	});

	it("contains no real-looking certificate fingerprint or account id", () => {
		for (const file of shipped) {
			const text = readFileSync(join(root, file), "utf8");
			for (const hex of text.matchAll(/\b[0-9a-f]{64}\b/g)) {
				expect(/^0+$/.test(hex[0]), `${file} embeds a real fingerprint`).toBe(true);
			}
			expect(/\b\d{12}\b/.test(text), `${file} embeds an AWS account id`).toBe(false);
		}
	});
});
