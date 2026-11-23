/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as solid from "solid-js";
import { createRuntime } from "treflex";
import { registerOutsideGraph } from "treflex/internal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { solidGraph, TreflexProvider } from "../../src/Context/TreflexContext";

const STEPS = /treflex-solid needs solid-js \^2\.0\.3\. Dedupe solid-js and @solidjs\/signals.*overrides in package\.json for npm/;

let scratch: string;
let other: typeof solid;

// A bundle with @solidjs/signals inlined is a second copy, with its own $TRACK and owner. esbuild runs in a child
// process because its JavaScript API refuses jsdom's TextEncoder, and the bundle sits in node_modules so that Vitest
// leaves it to Node rather than its own resolver, which refuses a file outside the project.
beforeAll(async () => {
	const require = createRequire(import.meta.url);
	const solidDir = dirname(require.resolve("solid-js/package.json"));
	const cache = join(solidDir, "../.cache");
	mkdirSync(cache, {
		recursive: true
	});
	scratch = mkdtempSync(join(cache, "treflex-solid-copy-"));
	const entry = join(solidDir, "dist/solid.dev.js");
	const outfile = join(scratch, "solid-copy.mjs");
	execFileSync(process.execPath, [
		"-e",
		"require(process.argv[1]).buildSync(JSON.parse(process.argv[2]))",
		require.resolve("esbuild"),
		JSON.stringify({
			entryPoints: [
				entry
			],
			bundle: true,
			format: "esm",
			platform: "browser",
			conditions: [
				"browser",
				"development"
			],
			outfile,
			logLevel: "error"
		})
	]);
	other = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
});

afterAll(() => {
	rmSync(scratch, {
		recursive: true,
		force: true
	});
});

describe("12. one copy", () => {
	it("is a second copy of solid-js", () => {
		expect(other.$TRACK).not.toBe(solid.$TRACK);
	});

	it("throws from a provider a second copy of solid-js renders, naming the range and the steps", () => {
		const runtime = createRuntime({
			$Id: "root"
		});
		expect(() =>
			other.createRoot(() =>
				other.createComponent(TreflexProvider as never, {
					value: runtime
				})
			)
		).toThrow(/TreflexProvider found no Solid owner on the copy of solid-js that treflex-solid imports/);
		expect(() =>
			other.createRoot(() =>
				other.createComponent(TreflexProvider as never, {
					value: runtime
				})
			)
		).toThrow(STEPS);
		runtime.dispose();
	});

	it("throws the same from a provider called outside any render", () => {
		const runtime = createRuntime({
			$Id: "root"
		});
		expect(() =>
			TreflexProvider({
				value: runtime
			})
		).toThrow(/found no Solid owner.*or TreflexProvider was called outside a render/);
		runtime.dispose();
	});

	it("answers false to a registration from another copy, and true with no mirrors to one from the same copy", () => {
		const createMirror = vi.fn(() => ({
			track() {},
			write() {}
		}));
		expect(
			registerOutsideGraph({
				TRACK: other.$TRACK,
				isReading: () => other.getObserver() !== null,
				createMirror,
				untrack: other.untrack
			})
		).toBe(false);
		expect(
			registerOutsideGraph({
				...solidGraph,
				createMirror
			})
		).toBe(true);
		const runtime = createRuntime({
			$Id: "root",
			N: 0
		});
		const dispose = solid.createRoot((d) => {
			solid.createRenderEffect(
				() => runtime.state.N,
				() => {}
			);
			return d;
		});
		expect(createMirror).not.toHaveBeenCalled();
		dispose();
		runtime.dispose();
	});

	it("throws at import from a second binding on another copy of solid-js", async () => {
		vi.resetModules();
		vi.doMock("solid-js", () => other);
		await expect(import("../../src/Context/TreflexContext")).rejects.toThrow(
			/Two copies of solid-js are loaded, each with a copy of treflex-solid, and the runtime serves only the first/
		);
		vi.doUnmock("solid-js");
		vi.resetModules();
	});
});
