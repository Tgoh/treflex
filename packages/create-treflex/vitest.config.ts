import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "create-treflex",
		environment: "node",
		include: [
			"tests/**/*.test.ts"
		]
	}
});
