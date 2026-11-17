import { defaultClientConditions, defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { DEV_PORTS } from "./src/shell/builds";

export default defineConfig(({ command }) => ({
	base: "./",
	plugins: [
		solidPlugin()
	],
	// A dev server's code changes with every edit, so only a build names its code.
	define:
		command === "build"
			? {
					"import.meta.env.VITE_BUILD_ID": JSON.stringify(new Date().toISOString())
				}
			: {},
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
	// The record stream panel shows an unnamed action's function name, which minification would mangle.
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
}));
