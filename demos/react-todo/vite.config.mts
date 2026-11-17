import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
	plugins: [
		react()
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
			"treflex-react"
		]
	},
	build: {
		target: "esnext"
	},
	server: {
		watch: {
			ignored: [
				"!**/node_modules/treflex/**",
				"!**/node_modules/treflex-react/**"
			]
		}
	}
});
