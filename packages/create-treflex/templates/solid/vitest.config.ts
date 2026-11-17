import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Vitest otherwise resolves solid-js to its server build, where createRuntime
// throws SolidServerBuildError.
const conditions = ["solid", "browser"];

export default defineConfig({
	plugins: [solid({ hot: false })],
	resolve: { conditions },
	ssr: { resolve: { conditions } },
	// vite-plugin-solid switches an unset environment to jsdom.
	test: { environment: "node", setupFiles: ["treflex/vitest"] },
});
