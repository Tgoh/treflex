import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";
import { buildId } from "../checkout/buildId";
import { DEV_PORTS } from "../portal/src/shell/builds";

export default defineConfig({
	base: "./",
	plugins: [
		react(),
		buildId()
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
	build: {
		target: "esnext",
		rolldownOptions: {
			output: {
				// The record stream panel shows an unnamed action's function name, which minification would mangle.
				keepNames: true
			}
		}
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
