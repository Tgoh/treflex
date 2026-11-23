import solid from "@solidjs/vite-plugin";
import { defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";

// The env matches packages/core/vitest.config.ts.
export default defineConfig({
	plugins: [
		solid()
	],
	test: {
		name: "treflex-solid",
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		},
		// Not "node": the Solid plugin serves solid-js's server build there, which runs no effects.
		environment: "jsdom",
		// Not "treflex/vitest": Vitest resolves a setup file by Node's conditions, to the dist the workspace doesn't build.
		setupFiles: [
			"../core/src/Testing/vitest.ts"
		],
		include: [
			"tests/**/*.test.ts",
			"tests/**/*.test.tsx"
		]
	},
	resolve: {
		conditions: [
			"treflex-source",
			...defaultClientConditions
		]
	}
});
