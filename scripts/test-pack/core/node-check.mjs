import { createRuntime } from "treflex";
import { DEV } from "treflex/internal";
import { createSnapshot } from "treflex/snapshot";

if (typeof createRuntime !== "function" || typeof createSnapshot !== "function") {
	throw new Error("the entries loaded without their exports");
}
console.log(JSON.stringify({ dev: DEV }));
