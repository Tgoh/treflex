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
		include: [
			"src/**/*.test.ts",
			"src/**/*.test.tsx"
		],
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		}
	}
});
