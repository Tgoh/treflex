import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";
import { defaultClientConditions, defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { DEV_PORTS } from "../portal/src/shell/builds";

const REACT_VIEWS = [
	/\/demos\/react-portal\/src\/.*\.tsx$/,
	/\/demos\/portal-swap\/(src|robust)\/react\/.*\.tsx$/
];

export function jsxPlugins({ hot }: { hot: boolean }): PluginOption[] {
	return [
		// `exclude`, not an `include` of the Solid folders: treflex-solid's own .tsx source, served by the treflex-source condition, needs it too.
		solidPlugin({
			hot,
			exclude: REACT_VIEWS
		}),
		react({
			include: REACT_VIEWS
		})
	];
}

export default defineConfig({
	base: "./",
	plugins: jsxPlugins({
		hot: true
	}),
	resolve: {
		conditions: [
			"treflex-source",
			...defaultClientConditions
		],
		// The feature files and both builds' views import these from their own folders, and must reach the copy this app does:
		// src/oneCopy.test.ts checks it.
		dedupe: [
			"treflex",
			"treflex-solid",
			"treflex-react",
			"solid-js",
			"react",
			"react-dom"
		]
	},
	optimizeDeps: {
		exclude: [
			"treflex",
			"treflex-solid",
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
		port: DEV_PORTS.swap,
		strictPort: true,
		watch: {
			ignored: [
				"!**/node_modules/treflex/**",
				"!**/node_modules/treflex-solid/**",
				"!**/node_modules/treflex-react/**"
			]
		}
	}
});
