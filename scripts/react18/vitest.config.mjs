import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import base from "../../packages/react/vitest.config.ts";

const modules = fileURLToPath(new URL("node_modules/", import.meta.url));
const { dependencies } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));

// react-dom and Testing Library load outside Vite and require react by Node lookup, so every one of
// them must come from this folder's install, or the tests run on two Reacts.
export default mergeConfig(base, {
	root: fileURLToPath(new URL("../../packages/react/", import.meta.url)),
	resolve: {
		alias: [
			{
				find: /^(react|react-dom|@testing-library\/react|@testing-library\/dom)(\/.*)?$/,
				replacement: `${modules}$1$2`
			}
		]
	},
	test: {
		name: "treflex-react-18",
		env: {
			TREFLEX_EXPECTED_REACT: dependencies.react
		},
		setupFiles: [
			"tests/react18.setup.ts"
		]
	}
});
