import { createRuntime } from "treflex";
import { DEV } from "treflex/internal";
import { createSnapshot } from "treflex/snapshot";

if (typeof createRuntime !== "function" || typeof createSnapshot !== "function") {
	throw new Error("the entries loaded without their exports");
}
// Resolved, not imported: it registers Vitest hooks, which need a Vitest run.
if (!import.meta.resolve("treflex/vitest").endsWith("/dist/Testing/vitest.js")) {
	throw new Error(`treflex/vitest resolves to ${import.meta.resolve("treflex/vitest")}`);
}
console.log(JSON.stringify({ dev: DEV }));
