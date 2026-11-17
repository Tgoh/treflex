import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { requireName } from "../src/requireName";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const FIXTURE = decodeURIComponent(new URL("./fixture", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");

const ruleTester = new RuleTester({
	languageOptions: {
		parserOptions: {
			project: "./tsconfig.json",
			tsconfigRootDir: FIXTURE
		}
	}
});

const UNNAMED = [
	{
		messageId: "unnamed" as const
	}
];

const lines = (...text: string[]): string => text.join("\n");
const crlf = (...text: string[]): string => lines(...text).replace(/\n/g, "\r\n");

const TYPES = `import type { IActionGenerator, IAction, IEntity } from "treflex";
interface IDoc extends IEntity { N: number }
declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };`;

ruleTester.run("require-name", requireName, {
	valid: [
		lines(
			`import { named, type IActionGenerator, type IEntity, type ISelectorGenerator } from "treflex";`,
			`import { createEntityFeature } from "treflex-react";`,
			"interface IDoc extends IEntity { N: number }",
			"function* inc(d: IDoc): IActionGenerator { d.N++; }",
			`named(inc, "Doc/Inc");`,
			"function* clicks(d: IDoc): ISelectorGenerator<number> { return d.N; }",
			`export const Doc = createEntityFeature<IDoc>("X")({ inc }, { clicks });`
		),
		lines(
			`import * as T from "treflex";`,
			"interface IDoc extends T.IEntity { N: number }",
			"function* save(d: IDoc): T.IActionGenerator { d.N++; }",
			`T.named(save, "Doc/Save");`,
			"T.leading(save);"
		),
		lines(
			TYPES,
			`import { named } from "treflex";`,
			"function* save(d: IDoc): IActionGenerator { d.N++; }",
			`named(save, "Doc/Save");`,
			`runtime.dispatch(save, "a");`
		),
		lines(
			TYPES,
			`import { named as nameIt } from "treflex";`,
			`runtime.dispatch(save, "a");`,
			"function* save(d: IDoc): IActionGenerator { d.N++; }",
			`nameIt(save, "Doc/Save");`
		),
		lines(TYPES, `import { namedElsewhere } from "./actions";`, `runtime.dispatch(namedElsewhere, "a");`),
		lines(TYPES, "declare const save: IAction<IDoc>;", `runtime.dispatch(save, "a");`),
		lines(TYPES, "function* a(d: IDoc) {}", "function* b(d: IDoc) {}", "declare const c: boolean;", `runtime.dispatch(c ? a : b, "a");`),
		lines(TYPES, "declare const R: { handle: IAction<IDoc> };", `runtime.dispatch(R.handle, "a");`),
		lines(TYPES, "function* save(d: IDoc) {}", "const other = { mark(fn: unknown) {} };", "other.mark(save);"),
		lines(TYPES, "function helper(d: IDoc) {}", `runtime.dispatch(helper, "a");`),
		lines(TYPES, "function* save(d: IDoc): IActionGenerator { d.N++; }", "start(save);"),
		lines(TYPES, "const leading = (action: unknown) => action;", "function* save(d: IDoc): IActionGenerator { d.N++; }", "leading(save);")
	],
	invalid: [
		{
			code: lines(
				TYPES,
				`import { named } from "treflex";`,
				"function* other(d: IDoc): IActionGenerator { d.N--; }",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the template string is the source under test
				"named(other, `${String(other)}/Other`);",
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`runtime.dispatch(save, "a");`
			),
			output: null,
			errors: UNNAMED
		},
		{
			code: lines(
				`import type { IActionGenerator, IEntity } from "treflex";`,
				"declare global { function latest(action: unknown): void }",
				"function* save(d: IEntity): IActionGenerator {}",
				"latest(save);"
			),
			output: lines(
				`import type { IActionGenerator, IEntity } from "treflex";`,
				`import { named } from "treflex";`,
				"declare global { function latest(action: unknown): void }",
				"function* save(d: IEntity): IActionGenerator {}",
				`named(save, "Fixture/Save");`,
				"latest(save);"
			),
			errors: UNNAMED
		},
		{
			code: lines(
				`import { type IActionGenerator, type IEntity, leading } from "treflex";`,
				"declare global { function named(action: unknown, name: string): void }",
				"function* save(d: IEntity): IActionGenerator {}",
				"leading(save);"
			),
			output: lines(
				`import { type IActionGenerator, type IEntity, leading, named } from "treflex";`,
				"declare global { function named(action: unknown, name: string): void }",
				"function* save(d: IEntity): IActionGenerator {}",
				`named(save, "Fixture/Save");`,
				"leading(save);"
			),
			errors: UNNAMED
		},
		{
			code: lines(
				`import { type IActionGenerator, type IEntity, leading } from "treflex";`,
				"interface IDoc extends IEntity { N: number }",
				"export function* save(d: IDoc): IActionGenerator { d.N++; }",
				"leading(save);"
			),
			output: lines(
				`import { type IActionGenerator, type IEntity, leading, named } from "treflex";`,
				"interface IDoc extends IEntity { N: number }",
				"export function* save(d: IDoc): IActionGenerator { d.N++; }",
				`named(save, "Fixture/Save");`,
				"leading(save);"
			),
			errors: UNNAMED
		},
		{
			code: lines(
				"import {",
				"\ttype IActionGenerator,",
				"\ttype IEntity,",
				"\tleading,",
				"\topen,",
				`} from "treflex";`,
				`import { createEntityFeature } from "treflex-react";`,
				"interface ITodo extends IEntity { N: number }",
				"export function* addItem(d: ITodo): IActionGenerator { d.N++; }",
				"export const saveDraft = function* (d: ITodo): IActionGenerator { d.N--; };",
				`export const TodoList = createEntityFeature<ITodo>("Features/TodoList")({ addItem, save: saveDraft });`
			),
			output: [
				lines(
					"import {",
					"\ttype IActionGenerator,",
					"\ttype IEntity,",
					"\tleading,",
					"\tnamed,",
					"\topen,",
					`} from "treflex";`,
					`import { createEntityFeature } from "treflex-react";`,
					"interface ITodo extends IEntity { N: number }",
					"export function* addItem(d: ITodo): IActionGenerator { d.N++; }",
					`named(addItem, "TodoList/AddItem");`,
					"export const saveDraft = function* (d: ITodo): IActionGenerator { d.N--; };",
					`export const TodoList = createEntityFeature<ITodo>("Features/TodoList")({ addItem, save: saveDraft });`
				),
				lines(
					"import {",
					"\ttype IActionGenerator,",
					"\ttype IEntity,",
					"\tleading,",
					"\tnamed,",
					"\topen,",
					`} from "treflex";`,
					`import { createEntityFeature } from "treflex-react";`,
					"interface ITodo extends IEntity { N: number }",
					"export function* addItem(d: ITodo): IActionGenerator { d.N++; }",
					`named(addItem, "TodoList/AddItem");`,
					"export const saveDraft = function* (d: ITodo): IActionGenerator { d.N--; };",
					`named(saveDraft, "TodoList/SaveDraft");`,
					`export const TodoList = createEntityFeature<ITodo>("Features/TodoList")({ addItem, save: saveDraft });`
				)
			],
			errors: [
				...UNNAMED,
				...UNNAMED
			]
		},
		{
			filename: "todo-list/file.ts",
			code: lines(TYPES, "function* add_item(d: IDoc): IActionGenerator { d.N++; }", `runtime.dispatch(add_item, "a");`),
			output: lines(
				`import type { IActionGenerator, IAction, IEntity } from "treflex";`,
				`import { named } from "treflex";`,
				"interface IDoc extends IEntity { N: number }",
				"declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };",
				"function* add_item(d: IDoc): IActionGenerator { d.N++; }",
				`named(add_item, "TodoList/AddItem");`,
				`runtime.dispatch(add_item, "a");`
			),
			errors: UNNAMED
		},
		{
			code: lines(
				`import { start, workTag, latest } from "treflex";`,
				TYPES,
				`const Busy = workTag("Busy");`,
				"function* a(d: IDoc): IActionGenerator { d.N++; }",
				"Busy.mark(a);",
				"function* b(d: IDoc): IActionGenerator { yield* start(a, d); }",
				"latest(b);"
			),
			output: [
				lines(
					`import { named, start, workTag, latest } from "treflex";`,
					TYPES,
					`const Busy = workTag("Busy");`,
					"function* a(d: IDoc): IActionGenerator { d.N++; }",
					`named(a, "Fixture/A");`,
					"Busy.mark(a);",
					"function* b(d: IDoc): IActionGenerator { yield* start(a, d); }",
					"latest(b);"
				),
				lines(
					`import { named, start, workTag, latest } from "treflex";`,
					TYPES,
					`const Busy = workTag("Busy");`,
					"function* a(d: IDoc): IActionGenerator { d.N++; }",
					`named(a, "Fixture/A");`,
					"Busy.mark(a);",
					"function* b(d: IDoc): IActionGenerator { yield* start(a, d); }",
					`named(b, "Fixture/B");`,
					"latest(b);"
				)
			],
			errors: [
				...UNNAMED,
				...UNNAMED,
				...UNNAMED
			]
		},
		{
			code: lines(
				TYPES,
				`import { named as nameIt } from "treflex";`,
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`runtime.dispatch(save, "a");`
			),
			output: lines(
				TYPES,
				`import { named as nameIt } from "treflex";`,
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`nameIt(save, "Fixture/Save");`,
				`runtime.dispatch(save, "a");`
			),
			errors: UNNAMED
		},
		{
			code: lines(TYPES, `import { elsewhere } from "./actions";`, `runtime.dispatch(elsewhere, "a");`),
			output: null,
			errors: UNNAMED
		},
		{
			code: lines(
				`import { start } from "treflex";`,
				`import { createEntityFeature } from "treflex-react";`,
				`import * as Feature from "./actions";`,
				`export const Doc = createEntityFeature<Feature.IDoc>("Doc")(Feature.actions);`,
				"function* starts(d: Feature.IDoc) { yield* start(Feature.elsewhere, d); yield* start(Feature.namedElsewhere, d); }"
			),
			output: null,
			errors: [
				{
					messageId: "unnamed",
					data: {
						label: "elsewhere"
					},
					line: 4
				},
				{
					messageId: "unnamed",
					data: {
						label: "elsewhere"
					},
					line: 5
				}
			]
		},
		{
			code: lines(TYPES, "const save: IAction<IDoc> = function* (d: IDoc) { d.N++; };", `runtime.dispatch(save, "a");`),
			output: null,
			errors: UNNAMED
		},
		{
			code: lines(TYPES, `runtime.dispatch(function* (d: IDoc) { d.N++; }, "a");`),
			output: null,
			errors: UNNAMED
		},
		{
			code: lines(
				TYPES,
				`import { named } from "treflex";`,
				"function* other(d: IDoc) {}",
				`named(other, "Fixture/Save");`,
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`runtime.dispatch(save, "a");`
			),
			output: null,
			errors: UNNAMED
		},
		{
			code: lines(
				TYPES,
				"function component() {",
				"\tfunction* save(d: IDoc): IActionGenerator { d.N++; }",
				`\treturn runtime.dispatch(save, "a");`,
				"}"
			),
			output: null,
			errors: UNNAMED
		},
		{
			code: lines(TYPES, "function* save(d: IDoc): IActionGenerator { d.N++; }", "function dispatch(fn: unknown) {}", "dispatch(save);"),
			output: lines(
				`import type { IActionGenerator, IAction, IEntity } from "treflex";`,
				`import { named } from "treflex";`,
				"interface IDoc extends IEntity { N: number }",
				"declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };",
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`named(save, "Fixture/Save");`,
				"function dispatch(fn: unknown) {}",
				"dispatch(save);"
			),
			errors: UNNAMED
		},
		{
			code: lines(
				TYPES,
				`import { named } from "./lib";`,
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`runtime.dispatch(save, "a");`
			),
			output: null,
			errors: UNNAMED
		},
		{
			code: lines(
				TYPES,
				"function named(a: unknown, b: string) {}",
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`runtime.dispatch(save, "a");`
			),
			output: null,
			errors: UNNAMED
		},
		{
			code: crlf(TYPES, "function* save(d: IDoc): IActionGenerator { d.N++; } // keep", `runtime.dispatch(save, "a");`),
			output: crlf(
				`import type { IActionGenerator, IAction, IEntity } from "treflex";`,
				`import { named } from "treflex";`,
				"interface IDoc extends IEntity { N: number }",
				"declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };",
				"function* save(d: IDoc): IActionGenerator { d.N++; } // keep",
				`named(save, "Fixture/Save");`,
				`runtime.dispatch(save, "a");`
			),
			errors: UNNAMED
		},
		{
			code: lines(
				`import * as T from "treflex";`,
				`import * as R from "treflex-react";`,
				"interface IDoc extends T.IEntity { N: number }",
				"function* a(d: IDoc): T.IActionGenerator { d.N++; }",
				"T.leading(a);",
				"function* b(d: IDoc): T.IActionGenerator { yield* T.start(a, d); }",
				"T.latest(b);",
				"function* c(d: IDoc): T.IActionGenerator { d.N--; }",
				`export const Doc = R.createEntityFeature<IDoc>("Doc")({ c });`
			),
			output: lines(
				`import * as T from "treflex";`,
				`import * as R from "treflex-react";`,
				"interface IDoc extends T.IEntity { N: number }",
				"function* a(d: IDoc): T.IActionGenerator { d.N++; }",
				`T.named(a, "Doc/A");`,
				"T.leading(a);",
				"function* b(d: IDoc): T.IActionGenerator { yield* T.start(a, d); }",
				`T.named(b, "Doc/B");`,
				"T.latest(b);",
				"function* c(d: IDoc): T.IActionGenerator { d.N--; }",
				`T.named(c, "Doc/C");`,
				`export const Doc = R.createEntityFeature<IDoc>("Doc")({ c });`
			),
			errors: [
				...UNNAMED,
				...UNNAMED,
				...UNNAMED,
				...UNNAMED
			]
		},
		{
			code: lines(
				TYPES,
				`import { named } from "treflex";`,
				"function* save(d: IDoc): IActionGenerator { d.N++; } /* keep",
				"   this */",
				`runtime.dispatch(save, "a");`
			),
			output: lines(
				TYPES,
				`import { named } from "treflex";`,
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`named(save, "Fixture/Save"); /* keep`,
				"   this */",
				`runtime.dispatch(save, "a");`
			),
			errors: UNNAMED
		},
		{
			code: lines(
				TYPES,
				`import { named } from "treflex";`,
				"function* save(d: IDoc): IActionGenerator { d.N++; } const m = `a",
				"b`;",
				`runtime.dispatch(save, m);`
			),
			output: lines(
				TYPES,
				`import { named } from "treflex";`,
				"function* save(d: IDoc): IActionGenerator { d.N++; }",
				`named(save, "Fixture/Save"); const m = \`a`,
				"b`;",
				`runtime.dispatch(save, m);`
			),
			errors: UNNAMED
		},
		{
			code: lines(
				`import { named } from "treflex";`,
				`import type { IActionGenerator, IEntity } from "treflex";`,
				"interface IDoc extends IEntity { N: number }",
				"function save(d: IDoc): IActionGenerator;",
				"function save(d: IDoc, n: number): IActionGenerator;",
				"function* save(d: IDoc, n = 1): IActionGenerator { d.N += n; }",
				"declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };",
				`runtime.dispatch(save, "a");`
			),
			output: lines(
				`import { named } from "treflex";`,
				`import type { IActionGenerator, IEntity } from "treflex";`,
				"interface IDoc extends IEntity { N: number }",
				"function save(d: IDoc): IActionGenerator;",
				"function save(d: IDoc, n: number): IActionGenerator;",
				"function* save(d: IDoc, n = 1): IActionGenerator { d.N += n; }",
				`named(save, "Fixture/Save");`,
				"declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };",
				`runtime.dispatch(save, "a");`
			),
			errors: UNNAMED
		},
		{
			code: lines(
				`import { named } from "treflex";`,
				"export function* save(d: { $Id: string; N: number }) { d.N++; } export const Labels = {",
				`\tsave: "Save"`,
				"};",
				"declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };",
				`runtime.dispatch(save, "a");`
			),
			output: lines(
				`import { named } from "treflex";`,
				"export function* save(d: { $Id: string; N: number }) { d.N++; }",
				`named(save, "Fixture/Save"); export const Labels = {`,
				`\tsave: "Save"`,
				"};",
				"declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };",
				`runtime.dispatch(save, "a");`
			),
			errors: UNNAMED
		},
		{
			code: lines(
				"// @ts-expect-error",
				"function* save(d: { $Id: string; N: number }) { d.N++; }",
				"declare const runtime: { dispatch(action: unknown, target: string): Promise<unknown> };",
				`runtime.dispatch(save, "a");`
			),
			output: null,
			errors: UNNAMED
		},
		{
			code: lines(
				TYPES,
				`import { named } from "treflex";`,
				"function* saveDraft(d: IDoc): IActionGenerator { d.N++; }",
				"function* save_draft(d: IDoc): IActionGenerator { d.N--; }",
				`runtime.dispatch(saveDraft, "a");`,
				`runtime.dispatch(save_draft, "a");`
			),
			output: lines(
				TYPES,
				`import { named } from "treflex";`,
				"function* saveDraft(d: IDoc): IActionGenerator { d.N++; }",
				`named(saveDraft, "Fixture/SaveDraft");`,
				"function* save_draft(d: IDoc): IActionGenerator { d.N--; }",
				`runtime.dispatch(saveDraft, "a");`,
				`runtime.dispatch(save_draft, "a");`
			),
			errors: [
				...UNNAMED,
				...UNNAMED
			]
		}
	]
});
