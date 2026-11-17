import { createRequire } from "node:module";
import { noEditAfterWrite } from "./noEditAfterWrite";
import { noGlobalOpen } from "./noGlobalOpen";
import { noHiddenOpen } from "./noHiddenOpen";
import { noYieldInFinally } from "./noYieldInFinally";

export { type INoEditAfterWriteMessageId, noEditAfterWrite } from "./noEditAfterWrite";
export { type INoGlobalOpenMessageId, noGlobalOpen } from "./noGlobalOpen";
export { type INoHiddenOpenMessageId, noHiddenOpen } from "./noHiddenOpen";
export { type INoYieldInFinallyMessageId, noYieldInFinally } from "./noYieldInFinally";

// eslint reads plugin.meta for config inspection and for the messages it
// prints about disable directives.
const { version } = createRequire(import.meta.url)("../package.json");

const rules = {
	"no-edit-after-write": noEditAfterWrite,
	"no-global-open": noGlobalOpen,
	"no-hidden-open": noHiddenOpen,
	"no-yield-in-finally": noYieldInFinally
};

export interface ITreflexPlugin {
	meta: {
		name: string;
		version: string;
	};
	rules: typeof rules;
	configs: {
		/** Every treflex rule as an error on `.ts` and `.tsx`, and eslint's `require-yield` off there. */
		recommended: {
			files: string[];
			plugins: {
				treflex: ITreflexPlugin;
			};
			rules: Record<string, "error" | "off">;
		};
	};
}

export const plugin: ITreflexPlugin = {
	meta: {
		name: "treflex",
		version
	},
	rules,
	configs: {
		recommended: {
			files: [
				"**/*.ts",
				"**/*.tsx"
			],
			plugins: {} as ITreflexPlugin["configs"]["recommended"]["plugins"],
			rules: {
				"treflex/no-edit-after-write": "error",
				"treflex/no-global-open": "error",
				"treflex/no-hidden-open": "error",
				"treflex/no-yield-in-finally": "error",
				"require-yield": "off"
			}
		}
	}
};
// The same object a config registers by hand, or eslint refuses to redefine the plugin.
plugin.configs.recommended.plugins.treflex = plugin;

export default plugin;
