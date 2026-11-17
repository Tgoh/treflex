/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..").replace(/\\/g, "/");
const PAGE = "docs/reference/troubleshooting.md";

const emitted = new Map<string, Set<string>>();
for (const pkg of readdirSync(`${ROOT}/packages`)) {
	let entries: string[];
	try {
		entries = readdirSync(`${ROOT}/packages/${pkg}/src`, {
			recursive: true
		}) as string[];
	} catch {
		continue;
	}
	for (const entry of entries.filter((e) => /\.tsx?$/.test(e))) {
		const file = `packages/${pkg}/src/${entry.replace(/\\/g, "/")}`;
		for (const m of readFileSync(`${ROOT}/${file}`, "utf8").matchAll(/\bcode:\s*"([a-z]+\/[a-z-]+)"/g)) {
			const at = emitted.get(m[1]) ?? new Set<string>();
			at.add(file);
			emitted.set(m[1], at);
		}
	}
}

const page = readFileSync(`${ROOT}/${PAGE}`, "utf8").replace(/\r\n/g, "\n");
const start = page.indexOf("\n## Every code");
const end = page.indexOf("\n## ", start + 1);
const table = page.slice(start, end === -1 ? undefined : end);
const rows = new Map(
	[
		...table.matchAll(/^\| \[`([a-z]+\/[a-z-]+)`\]\(#([a-z-]+)\)/gm)
	].map((m) => [
		m[1],
		m[2]
	])
);
const entries = new Set(
	[
		...page.matchAll(/^### `([a-z]+\/[a-z-]+)`$/gm)
	].map((m) => m[1])
);

describe("the diag table", () => {
	it("finds the table and the codes", () => {
		expect(start).toBeGreaterThan(-1);
		expect(emitted.size).toBeGreaterThan(20);
	});

	it("lists every emitted code, with an entry", () => {
		const problems: string[] = [];
		for (const [code, where] of emitted) {
			if (!rows.has(code)) {
				problems.push(
					`${code} (${[
						...where
					].join(", ")}) has no row in ${PAGE}`
				);
			}
			if (!entries.has(code)) {
				problems.push(`${code} has no ### entry in ${PAGE}`);
			}
		}
		expect(problems).toEqual([]);
	});

	it("lists only emitted codes, each linking its own entry", () => {
		const problems: string[] = [];
		for (const [code, anchor] of rows) {
			if (!emitted.has(code)) {
				problems.push(`${code} has a row but nothing under packages/*/src emits it`);
			}
			if (anchor !== code.replace("/", "")) {
				problems.push(`${code}'s row links #${anchor}, not its entry #${code.replace("/", "")}`);
			}
		}
		for (const code of entries) {
			if (!rows.has(code)) {
				problems.push(`${code} has an entry but no row`);
			}
		}
		expect(problems).toEqual([]);
	});
});
