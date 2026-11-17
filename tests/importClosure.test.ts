import { describe, expect, it } from "vitest";

const globbed = import.meta.glob("../packages/*/src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true
}) as Record<string, string>;

const manifests = import.meta.glob("../packages/*/package.json", {
	import: "default",
	eager: true
}) as Record<
	string,
	{
		name: string;
		exports: Record<
			string,
			{
				"treflex-source": string;
			}
		>;
	}
>;

const sources: Record<string, string> = {};
for (const key of Object.keys(globbed)) {
	sources[key.replace(/^\.\.\//, "")] = globbed[key];
}

const entries: Record<string, string> = {};
const packageNames: string[] = [];
for (const key of Object.keys(manifests)) {
	const dir = key.replace(/^\.\.\//, "").replace(/\/package\.json$/, "");
	const { name, exports } = manifests[key];
	packageNames.push(name);
	for (const [subpath, conditions] of Object.entries(exports)) {
		entries[subpath === "." ? name : `${name}/${subpath.slice(2)}`] = `${dir}/${conditions["treflex-source"].slice(2)}`;
	}
}

const CORE = "packages/core/";
const BINDINGS = [
	"packages/solid/",
	"packages/react/"
];

// The second alternation is the `import("…")` form, which both a dynamic
// import and an inline `import("…").Type` use.
const SPECIFIER = /(?:(?:from|import)\s+|import\s*\(\s*)"([^"]+)"/g;

function packageOf(key: string): string {
	return key.split("/").slice(0, 2).join("/");
}

function normalize(path: string): string {
	const out: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") {
			continue;
		}
		if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") {
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return out.join("/");
}

function isWorkspaceSpecifier(spec: string): boolean {
	return packageNames.some((name) => spec === name || spec.startsWith(`${name}/`));
}

function resolveSpecifier(fromKey: string, spec: string): string | undefined {
	if (!spec.startsWith(".")) {
		if (!isWorkspaceSpecifier(spec)) {
			return undefined;
		}
		const entry = entries[spec];
		if (entry === undefined || !(entry in sources)) {
			throw new Error(`importClosure: "${spec}" from ${fromKey} names no exports entry`);
		}
		return entry;
	}
	const dir = fromKey.slice(0, fromKey.lastIndexOf("/"));
	const base = normalize(`${dir}/${spec}`);
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}/index.ts`,
		`${base}/index.tsx`
	]) {
		if (candidate in sources) {
			return candidate;
		}
	}
	throw new Error(`importClosure: cannot resolve "${spec}" from ${fromKey}`);
}

function specifiers(key: string): string[] {
	return [
		...sources[key].matchAll(SPECIFIER)
	].map((match) => match[1]);
}

function importClosure(entryKeys: string[]): Set<string> {
	const seen = new Set<string>();
	const queue = [
		...entryKeys
	];
	while (queue.length > 0) {
		const key = queue.pop() as string;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		for (const spec of specifiers(key)) {
			const resolved = resolveSpecifier(key, spec);
			if (resolved !== undefined) {
				queue.push(resolved);
			}
		}
	}
	return seen;
}

const coreEntries = Object.values(entries).filter((key) => key.startsWith(CORE));

describe("package boundaries", () => {
	it("the walk sees every package and every core entry", () => {
		expect(packageNames.sort()).toEqual([
			"treflex",
			"treflex-eslint",
			"treflex-react",
			"treflex-solid"
		]);
		expect(coreEntries.sort()).toEqual([
			"packages/core/src/Snapshot/index.ts",
			"packages/core/src/index.ts",
			"packages/core/src/internal.ts"
		]);
	});

	it("the core entry reaches nothing under packages/core/src/Snapshot", () => {
		const closure = importClosure([
			entries.treflex
		]);
		expect(closure.has("packages/core/src/Runtime/createRuntime.ts")).toBe(true);
		expect(closure.has("packages/core/src/Runtime/processAction.ts")).toBe(true);

		const offenders = [
			...closure
		]
			.filter((key) => key.startsWith("packages/core/src/Snapshot/"))
			.sort();
		expect(offenders).toEqual([]);
	});

	it("core reaches no binding package and no .tsx module", () => {
		const closure = importClosure(coreEntries);
		expect(closure.has("packages/core/src/Solid/host.ts")).toBe(true);

		const offenders = [
			...closure
		]
			.filter((key) => !key.startsWith(CORE) || key.endsWith(".tsx"))
			.sort();
		expect(offenders).toEqual([]);
	});

	it("no core source names treflex-solid or treflex-react", () => {
		const offenders = Object.keys(sources)
			.filter((key) => key.startsWith(CORE))
			.filter((key) => sources[key].includes('"treflex-solid"') || sources[key].includes('"treflex-react"'))
			.sort();
		expect(offenders).toEqual([]);
	});

	it("no core source outside Snapshot names the treflex/snapshot specifier", () => {
		const offenders = Object.keys(sources)
			.filter((key) => key.startsWith(CORE) && !key.startsWith("packages/core/src/Snapshot/"))
			.filter((key) => sources[key].includes('"treflex/snapshot"'))
			.sort();
		expect(offenders).toEqual([]);
	});

	it("no package reaches another by a relative path", () => {
		const offenders: string[] = [];
		for (const key of Object.keys(sources)) {
			for (const spec of specifiers(key)) {
				if (spec.startsWith(".")) {
					const resolved = resolveSpecifier(key, spec) as string;
					if (packageOf(resolved) !== packageOf(key)) {
						offenders.push(`${key} -> ${spec}`);
					}
				}
			}
		}
		expect(offenders.sort()).toEqual([]);
	});

	it("each binding reaches core only through treflex or treflex/internal", () => {
		const offenders: string[] = [];
		for (const key of Object.keys(sources).filter((key) => BINDINGS.some((binding) => key.startsWith(binding)))) {
			for (const spec of specifiers(key)) {
				if (isWorkspaceSpecifier(spec) && spec !== "treflex" && spec !== "treflex/internal") {
					offenders.push(`${key} -> ${spec}`);
				}
			}
		}
		expect(offenders.sort()).toEqual([]);
	});

	it("treflex/internal exports only what a binding imports from it", () => {
		const imported = new Set<string>();
		for (const key of Object.keys(sources).filter((key) => BINDINGS.some((binding) => key.startsWith(binding)))) {
			for (const match of sources[key].matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"treflex\/internal"/g)) {
				for (const name of match[1].split(",")) {
					imported.add(name.trim());
				}
			}
		}
		const internal = sources[entries["treflex/internal"]].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		const REEXPORT = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"[^"]+";/g;
		expect(internal.replace(REEXPORT, "").trim()).toBe("");
		const exported = [
			...internal.matchAll(REEXPORT)
		].flatMap((match) => match[1].split(",").map((name) => name.trim()));
		expect(exported.length).toBeGreaterThan(0);
		expect(exported.filter((name) => !imported.has(name)).sort()).toEqual([]);
	});

	it("the solid entry reaches the bindings and the runtime it binds to", () => {
		const closure = importClosure([
			entries["treflex-solid"]
		]);
		expect(closure.has("packages/solid/src/Context/createEntityFeature.tsx")).toBe(true);
		expect(closure.has("packages/solid/src/Context/TreflexContext.tsx")).toBe(true);
		expect(closure.has("packages/solid/src/Hooks/useComponentState.ts")).toBe(true);
		expect(closure.has("packages/core/src/Runtime/sliceSetState.ts")).toBe(true);
	});

	it("the react entry reaches the frames and the runtime it binds to", () => {
		const closure = importClosure([
			entries["treflex-react"]
		]);
		expect(closure.has("packages/react/src/createFrames.ts")).toBe(true);
		expect(closure.has("packages/core/src/Runtime/viewProxy.ts")).toBe(true);
	});

	it("the snapshot entry reaches the core it restores into", () => {
		const closure = importClosure([
			entries["treflex/snapshot"]
		]);
		expect(closure.has("packages/core/src/Snapshot/loadSnapshot.ts")).toBe(true);
		expect(closure.has("packages/core/src/Runtime/processAction.ts")).toBe(true);
	});
});
