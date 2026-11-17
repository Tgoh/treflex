import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

const DEV_MODE = decodeURIComponent(new URL("../packages/core/src/Utility/devMode.ts", import.meta.url).pathname).replace(
	/^\/(?=[A-Za-z]:)/,
	""
);

function devIn(define: Record<string, string>, process: unknown): boolean {
	const [output] = buildSync({
		entryPoints: [
			DEV_MODE
		],
		bundle: true,
		format: "cjs",
		// "browser" defines NODE_ENV by itself, which would hide the run-time read.
		platform: "neutral",
		write: false,
		define,
		logLevel: "silent"
	}).outputFiles;
	const module = {
		exports: {} as {
			DEV?: boolean;
		}
	};
	new Function("module", "process", output!.text)(module, process);
	return module.exports.DEV as boolean;
}

describe("DEV in a bundle Vite didn't build", () => {
	it("is false in a browser when the bundler defines NODE_ENV as production", () => {
		expect(
			devIn(
				{
					"process.env.NODE_ENV": '"production"'
				},
				undefined
			)
		).toBe(false);
	});

	it("is true when the bundler defines it as development", () => {
		expect(
			devIn(
				{
					"process.env.NODE_ENV": '"development"'
				},
				undefined
			)
		).toBe(true);
	});

	it("is true in a browser with no define and no process", () => {
		expect(devIn({}, undefined)).toBe(true);
	});

	it("reads a real process when nothing replaced it", () => {
		expect(
			devIn(
				{},
				{
					env: {
						NODE_ENV: "production"
					}
				}
			)
		).toBe(false);
	});
});
