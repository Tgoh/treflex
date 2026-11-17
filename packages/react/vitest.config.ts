import { defineConfig } from "vitest/config";

// The env and the solid-js conditions match packages/core/vitest.config.ts:
// the runtime under the binding needs Solid's reactive build.
export default defineConfig({
	test: {
		name: "treflex-react",
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		},
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
			"solid",
			"browser"
		]
	},
	ssr: {
		resolve: {
			conditions: [
				"treflex-source",
				"solid",
				"browser"
			]
		}
	}
});
