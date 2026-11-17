import { defineConfig } from "vitest/config";

// treflex runs on solid-js, which Vitest otherwise resolves to its server
// build, where createRuntime throws SolidServerBuildError.
const conditions = ["solid", "browser"];

export default defineConfig({
	resolve: { conditions },
	ssr: { resolve: { conditions } },
	test: { environment: "node", setupFiles: ["treflex/vitest"] },
});
