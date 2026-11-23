import type { Plugin } from "vite";

const ID = "virtual:build-id";
const RESOLVED = `\0${ID}`;

/**
 * Serves `virtual:build-id`, whose `BUILD` is the runtime's `build`. On the dev server it is a value drawn when the
 * server started joined to a count of the source changes it has watched, so a save resumes only into the code that
 * wrote it; a built page gets one id per build.
 */
export function buildId(): Plugin {
	const drawn = Math.random().toString(36).slice(2, 10);
	let changes = 0;
	let serving = false;
	return {
		name: "demo-build-id",
		configureServer(server) {
			serving = true;
			const changed = (): void => {
				changes++;
				const graph = server.environments.client.moduleGraph;
				const module = graph.getModuleById(RESOLVED);
				if (module) graph.invalidateModule(module);
			};
			server.watcher.on("change", changed);
			server.watcher.on("add", changed);
			server.watcher.on("unlink", changed);
		},
		resolveId: (id) => (id === ID ? RESOLVED : undefined),
		load: (id) => (id === RESOLVED ? `export const BUILD = ${JSON.stringify(serving ? `dev-${drawn}-${changes}` : `build-${drawn}`)};\n` : undefined)
	};
}
