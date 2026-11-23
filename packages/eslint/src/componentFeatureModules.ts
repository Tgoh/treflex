import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".js",
	".jsx",
	".mjs"
];
const SOURCE_FOR_OUTPUT: Record<string, string[]> = {
	".js": [
		".ts",
		".tsx"
	],
	".mjs": [
		".mts"
	]
};

const texts = new Map<
	string,
	{
		mtimeMs: number;
		text: string;
	}
>();

/** Where each specifier resolved, for one file's lint: files can appear, move or go between lints. */
export type IResolutions = Map<string, string | null>;

function fileTime(path: string): number | undefined {
	try {
		const stats = statSync(path, {
			throwIfNoEntry: false
		});
		return stats?.isFile() ? stats.mtimeMs : undefined;
	} catch {
		return undefined;
	}
}

function candidates(base: string): string[] {
	const found = [
		base,
		...EXTENSIONS.map((extension) => base + extension)
	];
	for (const [output, sources] of Object.entries(SOURCE_FOR_OUTPUT)) {
		if (base.endsWith(output)) {
			found.push(...sources.map((source) => base.slice(0, -output.length) + source));
		}
	}
	found.push(...EXTENSIONS.map((extension) => `${base}/index${extension}`));
	return found;
}

function resolved(fromFile: string, specifier: string, resolutions: IResolutions): string | undefined {
	const key = `${dirname(fromFile)}\0${specifier}`;
	const known = resolutions.get(key);
	if (known !== undefined) {
		return known ?? undefined;
	}
	const path = candidates(resolve(dirname(fromFile), specifier)).find((candidate) => fileTime(candidate) !== undefined);
	resolutions.set(key, path ?? null);
	return path;
}

function textOf(fromFile: string, specifier: string, resolutions: IResolutions): string | undefined {
	const path = resolved(fromFile, specifier, resolutions);
	const mtimeMs = path === undefined ? undefined : fileTime(path);
	if (path === undefined || mtimeMs === undefined) {
		return undefined;
	}
	const cached = texts.get(path);
	if (cached?.mtimeMs === mtimeMs) {
		return cached.text;
	}
	try {
		const text = readFileSync(path, "utf8");
		texts.set(path, {
			mtimeMs,
			text
		});
		return text;
	} catch {
		return undefined;
	}
}

function escapeDollars(name: string): string {
	return name.replace(/[$]/g, "\\$");
}

function bindsByName(text: string, name: string): boolean {
	return new RegExp(`(?:const|let|var)\\s+${escapeDollars(name)}(?![\\w$])[^=;]*=\\s*createComponentFeature\\b`).test(text);
}

/**
 * Whether the module a relative `specifier` names, from `fromFile`, binds `imported` (or its default export, for
 * `"default"`) directly to a `createComponentFeature(...)` call, read from its text.
 */
export function importsComponentFeature(fromFile: string, specifier: string, imported: string, resolutions: IResolutions): boolean {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return false;
	}
	const text = textOf(fromFile, specifier, resolutions);
	if (text === undefined) {
		return false;
	}
	if (imported !== "default") {
		return bindsByName(text, imported);
	}
	if (/export\s+default\s+createComponentFeature\b/.test(text)) {
		return true;
	}
	const named = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*(?:$|\n)/m.exec(text)?.[1];
	return named !== undefined && bindsByName(text, named);
}
