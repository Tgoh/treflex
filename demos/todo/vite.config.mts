import { defaultClientConditions, defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
	plugins: [
		solidPlugin()
	],
	resolve: {
		conditions: [
			"treflex-source",
			...defaultClientConditions
		]
	},
	optimizeDeps: {
		exclude: [
			"treflex",
			"treflex-solid"
		]
	},
	build: {
		target: "esnext"
	},
	server: {
		watch: {
			ignored: [
				"!**/node_modules/treflex/**",
				"!**/node_modules/treflex-solid/**"
			]
		}
	}
});
