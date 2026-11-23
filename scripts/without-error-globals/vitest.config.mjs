import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import core from "../../packages/core/vitest.config.ts";
import react from "../../packages/react/vitest.config.ts";
import solid from "../../packages/solid/vitest.config.ts";

const setup = fileURLToPath(new URL("setup.mjs", import.meta.url));

function withoutErrorGlobals(base, folder) {
	const config = mergeConfig(base, {
		root: fileURLToPath(new URL(`../../packages/${folder}/`, import.meta.url)),
		test: {
			name: `${base.test.name}-without-error-globals`
		}
	});
	// First: jsdom puts its own SuppressedError on the global before any setup file runs, and core
	// reads both globals once, when its modules load.
	config.test.setupFiles = [
		setup,
		...base.test.setupFiles
	];
	return config;
}

export default defineConfig({
	test: {
		projects: [
			withoutErrorGlobals(core, "core"),
			withoutErrorGlobals(solid, "solid"),
			withoutErrorGlobals(react, "react")
		]
	}
});
