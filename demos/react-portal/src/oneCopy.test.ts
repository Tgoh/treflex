// @vitest-environment node
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { devResolutions, escaped, fixtureWithCopies, packageFiles, productionModules, slashed } from "./oneCopy";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "../..");
const configFile = join(app, "vite.config.mts");

const importers = {
	"a shared feature file": join(repo, "demos/portal/src/portal/session.ts"),
	"the React portal": join(app, "src/mount.tsx"),
	"treflex-react's source": join(repo, "packages/react/src/feature.ts")
};

/** Where Node's lookup, which tsc's bundler resolution follows, finds `name` from `from`, with symlinks resolved. */
function packageDir(from: string, name: string): string | null {
	for (let dir = from; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(candidate)) return slashed(realpathSync(candidate));
		if (dirname(dir) === dir) return null;
	}
}

describe("one copy of treflex", () => {
	it("is what the node_modules lookups from both demos and the binding find, so tsc reads one copy", () => {
		for (const folder of [
			"demos/portal/src",
			"demos/react-portal/src",
			"packages/react/src"
		]) {
			expect(packageDir(join(repo, folder), "treflex")).toBe(slashed(join(repo, "packages/core")));
			expect(packageDir(join(repo, folder), "treflex-react")).toBe(slashed(join(repo, "packages/react")));
		}
	});

	it("is what the dev server resolves, even from a folder with a second copy in its own node_modules", async () => {
		const fixture = fixtureWithCopies({
			treflex: {
				".": "src/index.ts",
				"./snapshot": "src/Snapshot/index.ts",
				"./internal": "src/internal.ts"
			},
			"treflex-react": {
				".": "src/index.ts"
			}
		});
		try {
			const resolved = await devResolutions(
				configFile,
				app,
				[
					"treflex",
					"treflex/snapshot",
					"treflex/internal",
					"treflex-react"
				],
				[
					...Object.values(importers),
					fixture.importer
				]
			);
			for (const ids of Object.values(resolved)) {
				expect(ids).toHaveLength(1);
				expect(ids[0]).toMatch(new RegExp(`^${escaped(slashed(repo))}/packages/(core|react)/src/`));
			}
		} finally {
			fixture.remove();
		}
	});

	it("is the only copy in the production bundle, with no solid-js and one React, its production build", async () => {
		const modules = await productionModules(configFile, app);

		// A second copy would be the same file under another path, so it would show as a second module with the same tail.
		expect(modules.filter((id) => id.endsWith("/src/Runtime/createRuntime.ts"))).toEqual([
			slashed(join(repo, "packages/core/src/Runtime/createRuntime.ts"))
		]);
		expect(modules.filter((id) => id.endsWith("/src/Snapshot/index.ts"))).toEqual([
			slashed(join(repo, "packages/core/src/Snapshot/index.ts"))
		]);
		expect(modules.filter((id) => id.endsWith("/src/createFrames.ts"))).toEqual([
			slashed(join(repo, "packages/react/src/createFrames.ts"))
		]);
		expect(modules.filter((id) => /\/packages\/[^/]+\/dist\/|\/node_modules\/treflex/.test(id))).toEqual([]);

		const nodeModules = slashed(join(repo, "node_modules"));
		expect(packageFiles(modules, "solid-js")).toEqual({});
		expect(Object.keys(packageFiles(modules, "react"))).toEqual([
			`${nodeModules}/react`
		]);
		expect(packageFiles(modules, "react")[`${nodeModules}/react`].filter((file) => file.startsWith("cjs/"))).toEqual([
			"cjs/react-jsx-runtime.production.js",
			"cjs/react.production.js"
		]);
		expect(Object.keys(packageFiles(modules, "react-dom"))).toEqual([
			`${nodeModules}/react-dom`
		]);
		expect(packageFiles(modules, "react-dom")[`${nodeModules}/react-dom`].filter((file) => file.startsWith("cjs/"))).toEqual([
			"cjs/react-dom-client.production.js",
			"cjs/react-dom.production.js"
		]);
		expect(Object.keys(packageFiles(modules, "scheduler"))).toEqual([
			`${nodeModules}/scheduler`
		]);
	}, 120_000);
});
