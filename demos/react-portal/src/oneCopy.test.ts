// @vitest-environment node
import type { RollupOutput } from "rollup";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { describe, expect, it } from "vitest";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "../..");
const configFile = join(app, "vite.config.mts");

const slashed = (path: string): string => path.replaceAll("\\", "/");

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
		const fixture = mkdtempSync(join(tmpdir(), "treflex-one-copy-"));
		const fakePackage = (name: string, entries: Record<string, string>): void => {
			const dir = join(fixture, "node_modules", name);
			const exports: Record<string, Record<string, string>> = {};
			for (const [entry, file] of Object.entries(entries)) {
				mkdirSync(dirname(join(dir, file)), {
					recursive: true
				});
				writeFileSync(join(dir, file), "export {};\n");
				exports[entry] = {
					"treflex-source": `./${file}`,
					import: `./${file}`
				};
			}
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					name,
					type: "module",
					exports
				})
			);
		};
		fakePackage("treflex", {
			".": "src/index.ts",
			"./snapshot": "src/Snapshot/index.ts",
			"./internal": "src/internal.ts"
		});
		fakePackage("treflex-react", {
			".": "src/index.ts"
		});
		mkdirSync(join(fixture, "src"));
		writeFileSync(join(fixture, "src/feature.ts"), 'import "treflex";\n');
		const fromFixture = join(fixture, "src/feature.ts");

		const server = await createServer({
			configFile,
			root: app,
			logLevel: "silent",
			appType: "custom",
			optimizeDeps: {
				noDiscovery: true
			},
			server: {
				middlewareMode: true,
				hmr: false,
				ws: false
			}
		});
		try {
			for (const specifier of [
				"treflex",
				"treflex/snapshot",
				"treflex/internal",
				"treflex-react"
			]) {
				const ids = new Set<string>();
				for (const importer of [
					...Object.values(importers),
					fromFixture
				]) {
					const resolved = await server.pluginContainer.resolveId(specifier, importer);
					ids.add(slashed(resolved?.id ?? "unresolved"));
				}
				expect([
					...ids
				]).toHaveLength(1);
				expect(
					[
						...ids
					][0]
				).toMatch(new RegExp(`^${slashed(repo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/packages/(core|react)/src/`));
			}
		} finally {
			await server.close();
			rmSync(fixture, {
				recursive: true,
				force: true
			});
		}
	});

	it("is the only copy in the production bundle, with one solid-js and one React", async () => {
		const output = (await build({
			configFile,
			root: app,
			logLevel: "silent",
			build: {
				write: false
			}
		})) as RollupOutput;
		const modules = output.output
			.flatMap((chunk) => (chunk.type === "chunk" ? Object.keys(chunk.modules) : []))
			.map((id) => slashed(id).replace(/^\0/, ""));
		const roots = (pattern: RegExp) => new Set(modules.map((id) => pattern.exec(id)?.[1]).filter((root) => root !== undefined));

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
		expect(roots(/^(.*\/node_modules\/solid-js)\//)).toEqual(
			new Set([
				slashed(join(repo, "node_modules/solid-js"))
			])
		);
		expect(roots(/^(.*\/node_modules\/react)\//)).toEqual(
			new Set([
				slashed(join(repo, "node_modules/react"))
			])
		);
		expect(roots(/^(.*\/node_modules\/react-dom)\//)).toEqual(
			new Set([
				slashed(join(repo, "node_modules/react-dom"))
			])
		);
	}, 120_000);
});
