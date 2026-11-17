import { defineConfig } from "vitest/config";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
	plugins: [
		solidPlugin()
	],
	test: {
		name: "treflex",
		// The index consistency walk on every reconciliation, so every test is
		// a bypass detector. Consumers get the budgeted default (see
		// createWriteGateway).
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		},
		// vite-plugin-solid defaults this to jsdom.
		environment: "node",
		include: [
			"tests/**/*.test.ts"
		]
	},
	resolve: {
		conditions: [
			"treflex-source",
			"solid",
			"browser"
		]
	},
	// Solid's server build (the default Node export) has no reactive runtime:
	// createSignal setters don't propagate and createMemo runs once and never
	// recomputes. https://github.com/solidjs/solid/discussions/1428
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
