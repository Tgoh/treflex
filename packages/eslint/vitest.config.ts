import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "treflex-eslint",
		environment: "node",
		include: [
			"tests/**/*.test.ts"
		]
	}
});
