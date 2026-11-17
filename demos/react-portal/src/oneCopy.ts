import type { Plugin } from "vite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build, createServer } from "vite";

export const slashed = (path: string): string => path.replaceAll("\\", "/");

export const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A temp folder whose node_modules holds an empty copy of each package, at each entry. Returns a file in it that imports from there. */
export function fixtureWithCopies(packages: Record<string, Record<string, string>>): {
	importer: string;
	remove(): void;
} {
	const fixture = mkdtempSync(join(tmpdir(), "treflex-one-copy-"));
	for (const [name, entries] of Object.entries(packages)) {
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
	}
	mkdirSync(join(fixture, "src"));
	writeFileSync(join(fixture, "src/feature.ts"), 'import "treflex";\n');
	return {
		importer: join(fixture, "src/feature.ts"),
		remove: () =>
			rmSync(fixture, {
				recursive: true,
				force: true
			})
	};
}

/** The ids the app's dev server resolves each specifier to, from each importer. */
export async function devResolutions(
	configFile: string,
	root: string,
	specifiers: string[],
	importers: string[]
): Promise<Record<string, string[]>> {
	const server = await createServer({
		configFile,
		root,
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
		const resolved: Record<string, string[]> = {};
		for (const specifier of specifiers) {
			const ids = new Set<string>();
			for (const importer of importers) {
				ids.add(slashed((await server.pluginContainer.resolveId(specifier, importer))?.id ?? "unresolved"));
			}
			resolved[specifier] = [
				...ids
			];
		}
		return resolved;
	} finally {
		await server.close();
	}
}

/**
 * Every module in the app's production bundle. A dev server or vitest earlier in the process leaves NODE_ENV set, and a
 * build keeps whatever it finds, so this sets it for the build.
 */
export async function productionModules(configFile: string, root: string, plugins: Plugin[] = []): Promise<string[]> {
	const nodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	try {
		const output = await build({
			configFile,
			root,
			mode: "production",
			logLevel: "silent",
			plugins,
			build: {
				write: false
			}
		});
		const outputs = Array.isArray(output)
			? output
			: [
					output
				];
		return outputs
			.flatMap((each) => ("output" in each ? each.output : []))
			.flatMap((chunk) => (chunk.type === "chunk" ? Object.keys(chunk.modules) : []))
			.map((id) => slashed(id).replace(/^\0/, ""));
	} finally {
		if (nodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = nodeEnv;
	}
}

/** The files, sorted, under each copy of `name`'s folder in node_modules, keyed by that copy's folder. */
export function packageFiles(modules: string[], name: string): Record<string, string[]> {
	const pattern = new RegExp(`^(.*/node_modules/${escaped(name)})/(.*)$`);
	const copies: Record<string, Set<string>> = {};
	for (const id of modules) {
		const match = pattern.exec(id.replace(/\?.*$/, ""));
		if (!match) continue;
		copies[match[1]] ??= new Set();
		copies[match[1]].add(match[2]);
	}
	return Object.fromEntries(
		Object.entries(copies).map(([copy, files]) => [
			copy,
			[
				...files
			].sort()
		])
	);
}
