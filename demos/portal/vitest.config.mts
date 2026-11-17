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
		include: [
			"src/**/*.test.ts"
		],
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		}
	}
});
