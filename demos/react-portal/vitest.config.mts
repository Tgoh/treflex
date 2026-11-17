import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.mts";

const conditions = [
	"treflex-source",
	"development",
	"browser"
];

export default defineConfig({
	plugins: viteConfig.plugins,
	resolve: {
		...viteConfig.resolve,
		conditions
	},
	ssr: {
		resolve: {
			conditions
		}
	},
	test: {
		environment: "jsdom",
		// Not "treflex/vitest": Vitest resolves a setup file by Node's conditions, to the dist the workspace doesn't build.
		setupFiles: [
			"./src/jsdom.setup.ts",
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
