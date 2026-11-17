// @vitest-environment node
import type { Plugin } from "vite";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { devResolutions, escaped, fixtureWithCopies, packageFiles, productionModules, slashed } from "../../react-portal/src/oneCopy";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "../..");
const configFile = join(app, "vite.config.mts");
const nodeModules = slashed(join(repo, "node_modules"));

const importers = {
	"a shared feature file": join(repo, "demos/portal/src/portal/session.ts"),
	"a Solid view": join(repo, "demos/portal/src/shell/PortalView.tsx"),
	"a React view": join(repo, "demos/react-portal/src/shell/PortalView.tsx"),
	"the Solid mount": join(app, "src/solid/mount.tsx"),
	"the React mount": join(app, "src/react/mount.tsx"),
	"treflex's source": join(repo, "packages/core/src/index.ts"),
	"treflex-solid's source": join(repo, "packages/solid/src/index.ts"),
	"treflex-react's source": join(repo, "packages/react/src/feature.ts")
};

describe("one copy of each runtime, with both renderers in one build", () => {
	it("is what the dev server resolves, even from a folder with a second copy of each in its own node_modules", async () => {
		const fixture = fixtureWithCopies({
			treflex: {
				".": "src/index.ts",
				"./snapshot": "src/Snapshot/index.ts",
				"./internal": "src/internal.ts"
			},
			"treflex-solid": {
				".": "src/index.ts"
			},
			"treflex-react": {
				".": "src/index.ts"
			},
			"solid-js": {
				".": "dist/solid.js",
				"./web": "web/dist/web.js"
			},
			react: {
				".": "index.js"
			},
			"react-dom": {
				"./client": "client.js"
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
					"treflex-solid",
					"treflex-react",
					"solid-js",
					"solid-js/web",
					"react",
					"react-dom/client"
				],
				[
					...Object.values(importers),
					fixture.importer
				]
			);
			const repoPath = escaped(slashed(repo));
			for (const [specifier, ids] of Object.entries(resolved)) {
				expect(ids, specifier).toHaveLength(1);
				expect(ids[0], specifier).toMatch(
					specifier.startsWith("treflex")
						? new RegExp(`^${repoPath}/packages/(core|solid|react)/src/`)
						: new RegExp(`^${repoPath}/(node_modules/${escaped(specifier.split("/")[0])}/|demos/portal-swap/node_modules/\\.vite/deps/)`)
				);
			}
		} finally {
			fixture.remove();
		}
	});

	it("is the only copy in the production bundle, each runtime's production build, and every .tsx compiled by one JSX transform", async () => {
		const tsx = (id: string): string | null => {
			const file = slashed(id).replace(/\?.*$/, "");
			return file.endsWith(".tsx") ? file : null;
		};
		const runtimes = new Map<string, string[]>();
		const recorder: Plugin = {
			name: "record-jsx-runtimes",
			enforce: "post",
			transform(code, id) {
				const file = tsx(id);
				if (!file) return;
				runtimes.set(file, [
					...(/from\s*["']solid-js\/web["']/.test(code)
						? [
								"solid"
							]
						: []),
					...(/from\s*["']react\/jsx-(dev-)?runtime["']/.test(code)
						? [
								"react"
							]
						: [])
				]);
			}
		};
		const modules = await productionModules(configFile, app, [
			recorder
		]);

		const reactViews = new RegExp(`^${escaped(slashed(repo))}/demos/(react-portal/src|portal-swap/src/react)/`);
		const withJsx = [
			...runtimes.keys()
		].filter((file) => /<\/[A-Za-z]|\/>|<>/.test(readFileSync(file, "utf8")));
		expect(withJsx.filter((file) => reactViews.test(file)).length).toBeGreaterThan(15);
		expect(withJsx.filter((file) => !reactViews.test(file)).length).toBeGreaterThan(15);
		for (const [file, found] of runtimes) {
			const expected = reactViews.test(file) ? "react" : "solid";
			expect(found, file).toEqual(
				withJsx.includes(file)
					? [
							expected
						]
					: []
			);
		}
		expect([
			...runtimes.keys()
		]).toContain(slashed(join(repo, "packages/solid/src/Context/TreflexContext.tsx")));

		const tail = (path: string) => modules.filter((id) => id.endsWith(path));
		expect(tail("/src/Runtime/createRuntime.ts")).toEqual([
			slashed(join(repo, "packages/core/src/Runtime/createRuntime.ts"))
		]);
		expect(tail("/src/Snapshot/index.ts")).toEqual([
			slashed(join(repo, "packages/core/src/Snapshot/index.ts"))
		]);
		expect(tail("/src/Context/TreflexContext.tsx")).toEqual([
			slashed(join(repo, "packages/solid/src/Context/TreflexContext.tsx"))
		]);
		expect(tail("/src/createFrames.ts")).toEqual([
			slashed(join(repo, "packages/react/src/createFrames.ts"))
		]);
		expect(modules.filter((id) => /\/packages\/[^/]+\/dist\/|\/node_modules\/treflex/.test(id))).toEqual([]);

		expect(packageFiles(modules, "solid-js")).toEqual({
			[`${nodeModules}/solid-js`]: [
				"dist/solid.js",
				"web/dist/web.js"
			]
		});
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
		expect(packageFiles(modules, "scheduler")).toEqual({
			[`${nodeModules}/scheduler`]: [
				"cjs/scheduler.production.js",
				"index.js"
			]
		});
	}, 120_000);
});
