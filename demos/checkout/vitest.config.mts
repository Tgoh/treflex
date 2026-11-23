import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

const conditions = [
	"treflex-source",
	"development",
	"browser"
];

export default defineConfig({
	plugins: [
		solid({
			refresh: false
		})
	],
	resolve: {
		conditions
	},
	ssr: {
		resolve: {
			conditions
		}
	},
	test: {
		environment: "node",
		// Not "treflex/vitest": Vitest resolves a setup file by Node's conditions, to the dist the workspace doesn't build.
		setupFiles: [
			"../../packages/core/src/Testing/vitest.ts"
		],
		include: [
			"src/**/*.test.ts",
			"src/**/*.test.tsx"
		],
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		}
	}
});
