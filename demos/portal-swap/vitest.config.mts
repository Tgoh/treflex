import { defineConfig } from "vitest/config";
import { buildId } from "../checkout/buildId";
import viteConfig, { jsxPlugins } from "./vite.config.mts";

const conditions = [
	"treflex-source",
	"development",
	"browser"
];

export default defineConfig({
	plugins: [
		...jsxPlugins({
			refresh: false
		}),
		buildId()
	],
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
		setupFiles: [
			"../react-portal/src/jsdom.setup.ts"
		],
		include: [
			"src/**/*.test.ts",
			"robust/**/*.test.ts"
		],
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		}
	}
});
