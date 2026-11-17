/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { slug } from "../../docs/.vitepress/slug";

const ROOT = resolve(import.meta.dirname, "../..").replace(/\\/g, "/");

const files = execFileSync(
	"git",
	[
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard"
	],
	{
		cwd: ROOT,
		encoding: "utf8"
	}
)
	.split("\n")
	.filter((f) => f && !f.split("/").includes("node_modules") && existsSync(`${ROOT}/${f}`));
const tracked = new Set(files);
const dirs = new Set(files.flatMap((f) => f.split("/").map((_, i, parts) => parts.slice(0, i).join("/"))));

const markdown = files.filter((f) => f.endsWith(".md"));
const sources = files.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs|grit|json)$/.test(f));

const lines = (file: string): string[] => readFileSync(`${ROOT}/${file}`, "utf8").split(/\r?\n/);

const anchorCache = new Map<string, Set<string>>();
function anchors(file: string): Set<string> {
	let set = anchorCache.get(file);
	if (set) {
		return set;
	}
	set = new Set();
	const counts = new Map<string, number>();
	let fence = false;
	for (const line of lines(file)) {
		if (/^\s*```/.test(line)) {
			fence = !fence;
		}
		if (fence) {
			continue;
		}
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		if (heading) {
			const s = slug(heading[1]);
			const n = counts.get(s) ?? 0;
			counts.set(s, n + 1);
			set.add(n ? `${s}-${n}` : s);
		}
		for (const a of line.matchAll(/<a (?:name|id)="([^"]+)"/g)) {
			set.add(a[1]);
		}
	}
	anchorCache.set(file, set);
	return set;
}

function problem(target: string): string | undefined {
	const [path, anchor] = target.split("#");
	if (path.startsWith("../") || path === "..") {
		return `leaves the repo: ${target}`;
	}
	const file = path.replace(/\/$/, "");
	if (!tracked.has(file) && !dirs.has(file)) {
		return `missing ${target}`;
	}
	if (anchor && tracked.has(file) && file.endsWith(".md") && !anchors(file).has(anchor)) {
		return `no heading for #${anchor} in ${file}`;
	}
	return undefined;
}

const from = (file: string, relative: string): string => {
	const joined = posix.normalize(posix.join(posix.dirname(file), relative));
	return joined === "." ? "" : joined;
};

describe("docs links", () => {
	it("finds the markdown and the sources", () => {
		expect(markdown).toContain("docs/reference/troubleshooting.md");
		expect(markdown).toContain("README.md");
		expect(sources).toContain("packages/core/src/index.ts");
	});

	it("resolves every relative markdown link and anchor", () => {
		const problems: string[] = [];
		for (const file of markdown) {
			let fence = false;
			lines(file).forEach((line, i) => {
				if (/^\s*```/.test(line)) {
					fence = !fence;
				}
				if (fence) {
					return;
				}
				for (const m of line.replace(/`[^`]*`/g, "").matchAll(/\]\(([^)\s]+)\)/g)) {
					const target = m[1];
					if (/^[a-z][a-z+.-]*:/i.test(target)) {
						continue;
					}
					const [path, anchor] = target.split("#");
					const found = problem(path ? `${from(file, path)}${anchor === undefined ? "" : `#${anchor}`}` : `${file}#${anchor}`);
					if (found) {
						problems.push(`${file}:${i + 1}: ${found}`);
					}
				}
			});
		}
		expect(problems).toEqual([]);
	});

	it("resolves every plain-text markdown path", () => {
		const problems: string[] = [];
		for (const file of markdown) {
			lines(file).forEach((line, i) => {
				const text = line.replace(/\[[^\]]*\]\([^)]*\)/g, "");
				for (const m of text.matchAll(/(?<![\w./-])((?:\.{1,2}\/)*(?:[\w.-]+\/)+[\w.-]+\.md)(?:#([\w-]+))?/g)) {
					const [, path, anchor] = m;
					const candidates = [
						from(file, path),
						posix.normalize(path),
						posix.normalize(`docs/${path}`)
					];
					const hit = candidates.find((c) => tracked.has(c));
					const found = hit ? (anchor ? problem(`${hit}#${anchor}`) : undefined) : `missing ${path}`;
					if (found) {
						problems.push(`${file}:${i + 1}: ${found}`);
					}
				}
			});
		}
		expect(problems).toEqual([]);
	});

	it("resolves every docs path and anchor cited from source", {
		timeout: 30_000
	}, () => {
		const problems: string[] = [];
		let cited = 0;
		for (const file of sources) {
			lines(file).forEach((line, i) => {
				for (const m of line.matchAll(/(?<![\w./-])((?:\.\.\/)*docs\/[\w./-]+\.md(?:#[\w-]+)?)/g)) {
					cited++;
					const target = m[1];
					const found = problem(target.startsWith("docs/") ? target : from(file, target));
					if (found) {
						problems.push(`${file}:${i + 1}: ${found}`);
					}
				}
			});
		}
		expect(cited).toBeGreaterThan(20);
		expect(problems).toEqual([]);
	});
});
