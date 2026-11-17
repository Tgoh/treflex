import treflex from "treflex-eslint";
import tseslint from "typescript-eslint";

export default [
	{ ignores: ["dist"] },
	tseslint.configs.base,
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	treflex.configs.recommended,
	{
		files: ["**/*.ts", "**/*.tsx"],
		rules: { "treflex/require-name": "error" },
	},
];
