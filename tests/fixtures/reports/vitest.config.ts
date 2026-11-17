import { defineConfig } from "vitest/config";

const conditions = [
	"treflex-source",
	"solid",
	"browser"
];

export default defineConfig({
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
		include: [
			"*.fixture.ts"
		],
		setupFiles: [
			"../../../packages/core/src/Testing/vitest.ts"
		]
	}
});
