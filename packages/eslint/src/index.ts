import { createRequire } from "node:module";
import { named } from "./named";
import { noDiscardedGenerator } from "./noDiscardedGenerator";
import { noEditAfterWrite } from "./noEditAfterWrite";
import { noGlobalOpen } from "./noGlobalOpen";
import { noHiddenOpen } from "./noHiddenOpen";
import { noReturnedPromise } from "./noReturnedPromise";
import { noYieldInFinally } from "./noYieldInFinally";
import { requireName } from "./requireName";

export { type INamedMessageId, named } from "./named";
export { type INoDiscardedGeneratorMessageId, noDiscardedGenerator } from "./noDiscardedGenerator";
export { type INoEditAfterWriteMessageId, noEditAfterWrite } from "./noEditAfterWrite";
export { type INoGlobalOpenMessageId, noGlobalOpen } from "./noGlobalOpen";
export { type INoHiddenOpenMessageId, noHiddenOpen } from "./noHiddenOpen";
export { type INoReturnedPromiseMessageId, noReturnedPromise } from "./noReturnedPromise";
export { type INoYieldInFinallyMessageId, noYieldInFinally } from "./noYieldInFinally";
export { type IRequireNameMessageId, requireName } from "./requireName";

// eslint reads plugin.meta for config inspection and for the messages it
// prints about disable directives.
const { version } = createRequire(import.meta.url)("../package.json");

const rules = {
	named,
	"no-discarded-generator": noDiscardedGenerator,
	"no-edit-after-write": noEditAfterWrite,
	"no-global-open": noGlobalOpen,
	"no-hidden-open": noHiddenOpen,
	"no-returned-promise": noReturnedPromise,
	"no-yield-in-finally": noYieldInFinally,
	"require-name": requireName
};

export interface ITreflexPlugin {
	meta: {
		name: string;
		version: string;
	};
	rules: typeof rules;
	configs: {
		/** Every treflex rule but `require-name` as an error on `.ts` and `.tsx`, and eslint's `require-yield` off there. */
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
				"treflex/named": "error",
				"treflex/no-discarded-generator": "error",
				"treflex/no-edit-after-write": "error",
				"treflex/no-global-open": "error",
				"treflex/no-hidden-open": "error",
				"treflex/no-returned-promise": "error",
				"treflex/no-yield-in-finally": "error",
				"require-yield": "off"
			}
		}
	}
};
// The same object a config registers by hand, or eslint refuses to redefine the plugin.
plugin.configs.recommended.plugins.treflex = plugin;

export default plugin;
