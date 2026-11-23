import solid from "@solidjs/vite-plugin";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
	plugins: [
		solid()
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
