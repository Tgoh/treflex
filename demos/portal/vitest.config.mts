import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import { buildId } from "../checkout/buildId";

const conditions = [
	"treflex-source",
	"development",
	"browser"
];

export default defineConfig({
	plugins: [
		solid({
			refresh: false
		}),
		buildId()
	],
	resolve: {
		conditions
	},
	ssr: {
		resolve: {
			conditions
		}
	},
	test: {
		environment: "node",
		// Not "treflex/vitest": Vitest resolves a setup file by Node's conditions, to the dist the workspace doesn't build.
		setupFiles: [
			"../../packages/core/src/Testing/vitest.ts"
		],
		css: {
			include: [
				/styles\/.*\.css/
			]
		},
		include: [
			"src/**/*.test.ts"
		],
		env: {
			TREFLEX_VERIFY_INDEX: "always"
		}
	}
});
