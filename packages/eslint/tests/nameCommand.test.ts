import parser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import plugin from "../src/index";
import { main } from "../src/nameCommand";

const FIXTURE = decodeURIComponent(new URL("./fixture", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");
const PROJECT = `${FIXTURE}/name`;
const SOLUTION = `${FIXTURE}/solution`;
const SOLUTION_PATHS = `${FIXTURE}/solution-paths`;
const REFERENCES = `${FIXTURE}/references`;
const UNREADABLE = `${FIXTURE}/unreadable`;

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

function overlay(
	files = new Map<string, string>(),
	{
		root = PROJECT,
		refuse
	}: {
		root?: string;
		refuse?: string;
	} = {}
) {
	const written: string[] = [];
	const marked: string[] = [];
	const output: string[] = [];
	const sys: ts.System = {
		...ts.sys,
		newLine: "\n",
		write: (text) => output.push(text),
		readFile: (path, encoding) => files.get(path) ?? ts.sys.readFile(path, encoding),
		fileExists: (path) => files.has(path) || ts.sys.fileExists(path),
		writeFile: (path, text, byteOrderMark) => {
			const file = path.slice(root.length + 1);
			if (file === refuse) {
				throw new Error(`EPERM: operation not permitted, open '${path}'`);
			}
			written.push(file);
			if (byteOrderMark) {
				marked.push(file);
			}
			files.set(path, text);
		}
	};
	return {
		sys,
		files,
		written,
		marked,
		printed: () => output.join("").trimEnd().split("\n")
	};
}

const NAMED = [
	"src/board/board.ts: Kanban/Move",
	"src/board/board.ts: Kanban/Archive",
	"src/bom/bom.ts: Bom/Stamp",
	"src/clash/clash.ts: Clash/SaveDraft",
	"src/notes/notes.ts: Notes/Edit",
	"src/notes/notes.ts: Notes/Clear",
	"src/pair/pair.ts: Pair/A",
	"src/pair/pair.ts: Pair/B",
	"src/tags/tags.ts: Tags/Load"
];

const UNNAMEABLE = [
	"src/app.ts:11: vendored is not named: it is declared outside the project",
	"src/app.ts:12: (anonymous) is not named: it is an anonymous function",
	"src/bare/bare.ts:1: bare is not named: its module has no imports to add named to",
	'src/clash/clash.ts:13: save is not named: "Clash/Save" already names another action',
	'src/clash/clash.ts:21: save_draft is not named: "Clash/SaveDraft" already names another action',
	'src/docs/docs.ts:5: save is not named: "Docs/Save" already names another action',
	"src/elsewhere/state.ts:3: retry is not named: it is named in src/elsewhere/contexts.ts, and the mark belongs in the module that declares it",
	"src/elsewhere/state.ts:5: hop is not named: it is named in src/elsewhere/contexts.ts, and the mark belongs in the module that declares it",
	"src/factory/factory.ts:4: save is not named: it is not declared at the top level of its module, and an action a factory makes is a new one on each call",
	"src/foreign/foreign.ts:9: save is not named: its module has another binding called named",
	"src/methods/methods.ts:5: bump is not named: it is a method written inside the actions object; declare it as a top-level function to name it",
	'src/shop/shop.ts:13: pay is not named: "Shop/Pay" already names another action',
	'src/shop/shop.ts:15: refund is not named: "Shop/Refund" already names another action',
	"src/typed/typed.ts:3: typedSave is not named: it is a variable with a type annotation",
	'src/utils/utils.ts:5: save is not named: "Utils/Save" already names another action'
];

describe("treflex-eslint name", () => {
	it("names each action in its declaring module, prints each name, and lists what it can't name", () => {
		const run = overlay();
		expect(
			main(
				[
					"name",
					"-p",
					PROJECT
				],
				run.sys
			)
		).toBe(1);
		expect(run.printed()).toEqual([
			...NAMED,
			...UNNAMEABLE
		]);
		expect(run.written.sort()).toEqual([
			"src/board/board.ts",
			"src/bom/bom.ts",
			"src/clash/clash.ts",
			"src/notes/notes.ts",
			"src/pair/pair.ts",
			"src/tags/tags.ts"
		]);
		expect(run.marked).toEqual([
			"src/bom/bom.ts"
		]);
		expect(run.files.get(`${PROJECT}/src/notes/notes.ts`)).toBe(
			lines(
				`import type { IActionGenerator, IEntity } from "treflex";`,
				`import { named } from "treflex";`,
				"",
				"export interface INote extends IEntity {",
				"\tText: string;",
				"}",
				"",
				"export function* edit(draft: INote, text: string): IActionGenerator {",
				"\tdraft.Text = text;",
				"}",
				`named(edit, "Notes/Edit");`,
				"",
				"export function* clear(draft: INote): IActionGenerator {",
				`\tdraft.Text = "";`,
				"}",
				`named(clear, "Notes/Clear");`,
				"",
				"export const actions = {",
				"\tedit,",
				"\tclear",
				"};"
			)
		);
		expect(run.files.get(`${PROJECT}/src/board/board.ts`)).toBe(
			lines(
				`import { type IActionGenerator, type IEntity, leading, named } from "treflex";`,
				`import { createEntityFeature } from "../feature";`,
				"",
				"export interface ICard extends IEntity {",
				"\tColumn: number;",
				"}",
				"",
				"export function* move(draft: ICard, column: number): IActionGenerator {",
				"\tdraft.Column = column;",
				"}",
				`named(move, "Kanban/Move");`,
				"leading(move);",
				"",
				"export function* archive(draft: ICard): IActionGenerator {",
				"\tdraft.Column = -1;",
				"}",
				`named(archive, "Kanban/Archive");`,
				"",
				`export const Card = createEntityFeature<ICard>("App/Kanban")({`,
				"\tmove",
				"});"
			)
		);
		expect(run.files.get(`${PROJECT}/src/tags/tags.ts`)).toBe(
			lines(
				`import * as T from "treflex";`,
				"",
				`export const Busy = T.workTag("Busy");`,
				"",
				"export function* load(draft: T.IEntity): T.IActionGenerator {}",
				`T.named(load, "Tags/Load");`,
				"Busy.mark(load);"
			)
		);
		expect(run.files.get(`${PROJECT}/src/clash/clash.ts`)).toContain(
			lines("export function* saveDraft(draft: IDoc): IActionGenerator {", "\tdraft.N++;", "}", `named(saveDraft, "Clash/SaveDraft");`)
		);

		const again = overlay(run.files);
		expect(
			main(
				[
					"name",
					"--project",
					`${PROJECT}/tsconfig.json`
				],
				again.sys
			)
		).toBe(1);
		expect(again.written).toEqual([]);
		expect(again.printed()).toEqual(UNNAMEABLE.map((line) => line.replace("clash.ts:21:", "clash.ts:22:")));
	});

	it("writes nothing with --check, and exits 1 while anything is unnamed", () => {
		const check = overlay();
		expect(
			main(
				[
					"name",
					"--check",
					"-p",
					PROJECT
				],
				check.sys
			)
		).toBe(1);
		expect(check.written).toEqual([]);
		expect(check.printed()).toEqual([
			...NAMED,
			`Run npx treflex-eslint name -p ${PROJECT} to name these.`,
			...UNNAMEABLE
		]);
	});

	it("keeps going past a file it can't write, lists it with the reason, and exits 1", () => {
		const run = overlay(undefined, {
			refuse: "src/notes/notes.ts"
		});
		expect(
			main(
				[
					"name",
					"-p",
					PROJECT
				],
				run.sys
			)
		).toBe(1);
		expect(run.written.sort()).toEqual([
			"src/board/board.ts",
			"src/bom/bom.ts",
			"src/clash/clash.ts",
			"src/pair/pair.ts",
			"src/tags/tags.ts"
		]);
		expect(run.printed()).toEqual([
			...NAMED.filter((line) => !line.startsWith("src/notes/")),
			...UNNAMEABLE,
			`src/notes/notes.ts: not written: EPERM: operation not permitted, open '${PROJECT}/src/notes/notes.ts'`
		]);
	});

	it("runs over each project a solution-style tsconfig references, with one set of taken names", () => {
		const run = overlay(undefined, {
			root: SOLUTION
		});
		expect(
			main(
				[
					"name",
					"-p",
					SOLUTION
				],
				run.sys
			)
		).toBe(1);
		expect(run.printed()).toEqual([
			"app/app.ts: App/Load",
			"shared/shared.ts: Shared/Save",
			'app/app.ts:7: sync is not named: "App/Sync" already names another action',
			"shared/actions.ts:3: move is not named: it is named in tools/tools.ts, and the mark belongs in the module that declares it"
		]);
		expect(run.written.sort()).toEqual([
			"app/app.ts",
			"shared/shared.ts"
		]);
		expect(run.files.get(`${SOLUTION}/shared/shared.ts`)).toBe(
			lines(
				`import type { IActionGenerator, IEntity } from "treflex";`,
				`import { named } from "treflex";`,
				"",
				"export declare const runtime: {",
				"\tdispatch(action: unknown, target: string): Promise<unknown>;",
				"};",
				"",
				"export function* save(draft: IEntity): IActionGenerator {}",
				`named(save, "Shared/Save");`
			)
		);
	});

	it("walks a file two projects share in each, naming what each resolves it to, and prints a refusal once", () => {
		const run = overlay(undefined, {
			root: SOLUTION_PATHS
		});
		expect(
			main(
				[
					"name",
					"-p",
					SOLUTION_PATHS
				],
				run.sys
			)
		).toBe(1);
		expect(run.printed()).toEqual([
			"a/lib/lib.ts: Lib/Save",
			"b/lib/lib.ts: Lib/Load",
			'b/lib/lib.ts:3: save is not named: "Lib/Save" already names another action',
			"shared/use.ts:11: (anonymous) is not named: it is an anonymous function"
		]);
	});

	it("follows the references of a tsconfig that includes files, through a cycle", () => {
		const run = overlay(undefined, {
			root: `${REFERENCES}/app`
		});
		expect(
			main(
				[
					"name",
					"-p",
					`${REFERENCES}/app`
				],
				run.sys
			)
		).toBe(0);
		expect(run.printed()).toEqual([
			"../lib/store/store.ts: Store/Save"
		]);
	});

	it("writes the marks of one statement's two actions in the order the rule's fix does", async () => {
		const run = overlay();
		main(
			[
				"name",
				"-p",
				PROJECT
			],
			run.sys
		);
		const eslint = new ESLint({
			cwd: PROJECT,
			overrideConfigFile: true,
			fix: true,
			overrideConfig: [
				{
					files: [
						"**/*.ts"
					],
					languageOptions: {
						parser,
						parserOptions: {
							project: "./tsconfig.json",
							tsconfigRootDir: PROJECT,
							disallowAutomaticSingleRunInference: true
						}
					},
					plugins: {
						treflex: plugin
					},
					rules: {
						"treflex/require-name": "error"
					}
				}
			] as never
		});
		const path = `${PROJECT}/src/pair/pair.ts`;
		const [result] = await eslint.lintText(ts.sys.readFile(path)!, {
			filePath: path
		});
		expect(result!.output).toBeDefined();
		expect(run.files.get(path)).toBe(result!.output);
	});

	it("lists each named call it can't read, writes nothing, and exits 1, with --check or without", () => {
		for (const args of [
			[],
			[
				"--check"
			]
		]) {
			const run = overlay(undefined, {
				root: UNREADABLE
			});
			expect(
				main(
					[
						"name",
						...args,
						"-p",
						UNREADABLE
					],
					run.sys
				)
			).toBe(1);
			expect(run.written).toEqual([]);
			expect(run.printed()).toEqual([
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the template string is the source text printed
				"src/marks.ts:6: named(pay, `${FEATURE.toLowerCase()}/Pay`) can't be read: its name isn't a known string",
				`src/marks.ts:9: named(ghost, "Marks/Ghost") can't be read: its action doesn't resolve to a function declaration`,
				"Nothing was written: a mark that can't be read leaves its name or its action unknown, so a new name could clash."
			]);
		}
	});

	it("exits 0 with --check where every action is named", () => {
		const check = overlay();
		expect(
			main(
				[
					"name",
					"--check",
					"-p",
					FIXTURE
				],
				check.sys
			)
		).toBe(0);
		expect(check.printed()).toEqual([
			"Every action treflex/require-name finds is named."
		]);
	});

	it("exits 2 on a usage error or a missing tsconfig, and 0 for --help", () => {
		const usage = overlay();
		expect(
			main(
				[
					"rename"
				],
				usage.sys
			)
		).toBe(2);
		expect(usage.printed()[0]).toBe("Unknown command: rename");
		expect(
			main(
				[
					"name",
					"--fix"
				],
				overlay().sys
			)
		).toBe(2);
		expect(
			main(
				[
					"name",
					"-p",
					`${PROJECT}/src/notes`
				],
				overlay().sys
			)
		).toBe(2);
		expect(
			main(
				[
					"name",
					"--help"
				],
				overlay().sys
			)
		).toBe(0);
	});
});
