import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
	plugins: [react()],
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
