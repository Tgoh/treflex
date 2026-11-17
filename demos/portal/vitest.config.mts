import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
	plugins: [
		solidPlugin({
			hot: false
		})
	],
	resolve: {
		conditions: [
			"treflex-source",
			"development",
			"browser"
		]
	},
	ssr: {
		resolve: {
			conditions: [
				"treflex-source",
				"development",
				"browser"
			]
		}
	},
	test: {
		environment: "node",
		// Not "treflex/vitest": Vitest resolves a setup file by Node's conditions, to the dist the workspace doesn't build.
		setupFiles: [
			"../../packages/core/src/Testing/vitest.ts"
		],
		css: {
			include: [
				/styles\/.*\.css/
			]
		},
		include: [
			"src/**/*.test.ts"
		],
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		}
	}
});
