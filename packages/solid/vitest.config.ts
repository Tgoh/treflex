import { defineConfig } from "vitest/config";
import solidPlugin from "vite-plugin-solid";

// The env, environment and solid-js conditions match packages/core/vitest.config.ts.
export default defineConfig({
	// Solid's JSX transform. Without it the classic React factory is used and
	// `props` is a plain object, so a binding that captures `props.state` once
	// passes every test that does not re-read it.
	plugins: [
		solidPlugin()
	],
	test: {
		name: "treflex-solid",
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		},
		environment: "node",
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
