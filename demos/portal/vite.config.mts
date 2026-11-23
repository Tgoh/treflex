import solid from "@solidjs/vite-plugin";
import { defaultClientConditions, defineConfig } from "vite";
import { buildId } from "../checkout/buildId";
import { DEV_PORTS } from "./src/shell/builds";

export default defineConfig({
	base: "./",
	plugins: [
		solid(),
		buildId()
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
		target: "esnext",
		rolldownOptions: {
			output: {
				// The record stream panel shows an unnamed action's function name, which minification would mangle.
				keepNames: true
			}
		}
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
