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
