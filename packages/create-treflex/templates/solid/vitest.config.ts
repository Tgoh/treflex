import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

// Without "browser", Vitest resolves @solidjs/web to its server build.
const conditions = ["browser"];

export default defineConfig({
	plugins: [solid({ refresh: false })],
	resolve: { conditions },
	ssr: { resolve: { conditions } },
	test: { environment: "node", setupFiles: ["treflex/vitest"] },
});
