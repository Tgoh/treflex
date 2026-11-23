import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");

// The start of the error treflex-solid throws when its registration answers false, in
// packages/solid/src/Context/TreflexContext.tsx: it survives only if the registration does.
const REGISTRATION = "each with a copy of treflex-solid";

function bundle(contents: string): string {
	const [output] = buildSync({
		stdin: {
			contents,
			resolveDir: ROOT,
			loader: "ts"
		},
		bundle: true,
		minify: true,
		format: "esm",
		platform: "browser",
		conditions: [
			"treflex-source"
		],
		external: [
			"solid-js",
			"@solidjs/web"
		],
		jsx: "preserve",
		write: false,
		logLevel: "silent"
	}).outputFiles;
	return output!.text;
}

describe("treflex-solid's registration under esbuild's minify, which honours sideEffects", () => {
	it("survives a bare import of the package", () => {
		expect(bundle('import "treflex-solid";')).toContain(REGISTRATION);
	});
});
