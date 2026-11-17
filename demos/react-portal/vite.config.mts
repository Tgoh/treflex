import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";
import { DEV_PORTS } from "../portal/src/shell/builds";

export default defineConfig({
	base: "./",
	plugins: [
		react()
	],
	resolve: {
		conditions: [
			"treflex-source",
			...defaultClientConditions
		],
		// The feature files under demos/portal/src import these too, and must reach the copy this app does:
		// src/oneCopy.test.ts checks it.
		dedupe: [
			"treflex",
			"treflex-react",
			"solid-js",
			"react",
			"react-dom"
		]
	},
	optimizeDeps: {
		exclude: [
			"treflex",
			"treflex-react"
		]
	},
	// The record stream panel shows each action's function name, which minification would mangle.
	esbuild: {
		keepNames: true
	},
	build: {
		target: "esnext"
	},
	server: {
		port: DEV_PORTS.react,
		strictPort: true,
		watch: {
			ignored: [
				"!**/node_modules/treflex/**",
				"!**/node_modules/treflex-react/**"
			]
		}
	}
});
