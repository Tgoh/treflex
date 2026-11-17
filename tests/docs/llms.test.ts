/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DOCS = resolve(import.meta.dirname, "../../docs");
const SITE = "https://tgoh.github.io/treflex/docs/";

const linked = [
	...readFileSync(resolve(DOCS, "public/llms.txt"), "utf8").matchAll(/\]\((https:\/\/tgoh\.github\.io\/treflex\/docs\/[^)]*)\)/g)
].map(([, url]) => url!.slice(SITE.length).replace(/\.html$/, ".md"));

describe("llms.txt", () => {
	it("links only pages the docs hold", () => {
		expect(linked.filter((page) => !existsSync(resolve(DOCS, page)))).toEqual([]);
	});

	it("lists every guide and reference page", () => {
		const pages = [
			"guide",
			"reference"
		].flatMap((dir) =>
			readdirSync(resolve(DOCS, dir))
				.filter((name) => name.endsWith(".md"))
				.map((name) => `${dir}/${name}`)
		);
		expect(pages.filter((page) => !linked.includes(page))).toEqual([]);
	});
});
