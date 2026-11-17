import parser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import plugin from "../src/index";

const FIXTURE = decodeURIComponent(new URL("./fixture", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");

const YIELD_IN_FINALLY = `import type { IActionGenerator } from "treflex"; declare function work(): IActionGenerator; export function* a() { try { yield* work(); } finally { yield* work(); } }`;

async function lint(code: string, filePath = `${FIXTURE}/file.ts`, after: object[] = []): Promise<(string | null)[]> {
	const eslint = new ESLint({
		cwd: FIXTURE,
		overrideConfigFile: true,
		overrideConfig: [
			{
				files: [
					"**/*.ts"
				],
				languageOptions: {
					parser,
					parserOptions: {
						project: "./tsconfig.json",
						tsconfigRootDir: FIXTURE
					}
				},
				rules: {
					"require-yield": "error"
				}
			},
			plugin.configs.recommended,
			...after
		] as never
	});
	const [result] = await eslint.lintText(code, {
		filePath
	});
	return result!.messages.map((message) => message.ruleId);
}

describe("configs.recommended", () => {
	it("sets every rule the plugin has", () => {
		const { rules } = plugin.configs.recommended;
		for (const name of Object.keys(plugin.rules)) {
			expect(rules[`treflex/${name}`]).toBe("error");
		}
	});

	it("turns require-yield off, for a selector with no yield", async () => {
		const selector = "interface IRow { $Id: string; N: number; } export function* count(draft: IRow) { return draft.N; }";
		expect(await lint(selector)).toEqual([]);
	});

	it("reports a rule that needs no type information", async () => {
		expect(await lint(YIELD_IN_FINALLY)).toEqual([
			"treflex/no-yield-in-finally"
		]);
	});

	it("reports a rule that needs type information", async () => {
		const edited = "interface IRow { $Id: string; X: { A?: number }; } export function* a(d: IRow) { const x = {}; d.X = x; x.A = 1; }";
		expect(await lint(edited)).toEqual([
			"treflex/no-edit-after-write"
		]);
	});

	it("lets a config name the plugin by hand as well, and set a rule's level after it", async () => {
		expect(
			await lint(YIELD_IN_FINALLY, undefined, [
				{
					plugins: {
						treflex: plugin
					},
					rules: {
						"treflex/no-yield-in-finally": "off"
					}
				}
			])
		).toEqual([]);
	});
});
