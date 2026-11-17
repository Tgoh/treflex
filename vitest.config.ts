import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			"packages/core",
			"packages/solid",
			"packages/react",
			"packages/eslint",
			{
				test: {
					name: "repo",
					environment: "node",
					include: [
						"tests/**/*.test.ts"
					]
				}
			}
		]
	}
});
