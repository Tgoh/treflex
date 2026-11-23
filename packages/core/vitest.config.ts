import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "treflex",
		// The index consistency walk on every reconciliation for the tests on a bare
		// createRuntime too, so every test is a bypass detector.
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		},
		environment: "node",
		setupFiles: [
			"./src/Testing/vitest.ts"
		],
		include: [
			"tests/**/*.test.ts"
		]
	},
	resolve: {
		conditions: [
			"treflex-source",
			"browser"
		]
	},
	ssr: {
		resolve: {
			conditions: [
				"treflex-source",
				"browser"
			]
		}
	}
});
