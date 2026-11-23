import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
	plugins: [solid()],
	// A dev server's code changes with every edit, so only a build names its code.
	define:
		command === "build"
			? {
					"import.meta.env.VITE_BUILD_ID": JSON.stringify(
						new Date().toISOString(),
					),
				}
			: {},
}));
