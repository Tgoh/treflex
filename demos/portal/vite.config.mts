import { defaultClientConditions, defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { DEV_PORTS } from "./src/shell/builds";

export default defineConfig({
	base: "./",
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
	// The record stream panel shows each action's function name, which minification would mangle.
	esbuild: {
		keepNames: true
	},
	build: {
		target: "esnext"
	},
	server: {
		port: DEV_PORTS.solid,
		strictPort: true,
		watch: {
			ignored: [
				"!**/node_modules/treflex/**",
				"!**/node_modules/treflex-solid/**"
			]
		}
	}
});
