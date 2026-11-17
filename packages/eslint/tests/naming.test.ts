import ts from "typescript";
import { describe, expect, it } from "vitest";
import { actionUses, createNamer, importOf, lineAfter, pascal } from "../src/naming";

const lines = (...text: string[]): string => text.join("\n");

function compile(code: string, path = "/app/todo-list/file.ts") {
	const options: ts.CompilerOptions = {
		noLib: true,
		noResolve: true,
		types: []
	};
	const host = ts.createCompilerHost(options, true);
	const file = ts.createSourceFile(path, code, ts.ScriptTarget.ES2022, true);
	host.getSourceFile = (name) => (name === path ? file : undefined);
	host.fileExists = (name) => name === path;
	const program = ts.createProgram({
		rootNames: [
			path
		],
		options,
		host
	});
	return {
		checker: program.getTypeChecker(),
		file: program.getSourceFile(path)!
	};
}

function applied(
	text: string,
	insertion: {
		at: number;
		text: string;
	} | null
): string {
	return insertion === null ? text : text.slice(0, insertion.at) + insertion.text + text.slice(insertion.at);
}

function calls(file: ts.SourceFile): ts.CallExpression[] {
	const found: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			found.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

describe("pascal", () => {
	it("joins the words of a name, each capitalised", () => {
		expect(pascal("increment")).toBe("Increment");
		expect(pascal("saveDraft")).toBe("SaveDraft");
		expect(pascal("save_draft")).toBe("SaveDraft");
		expect(pascal("todo-list")).toBe("TodoList");
		expect(pascal("--")).toBe("");
	});
});

describe("lineAfter", () => {
	it("is the end of the line when nothing but whitespace or closed comments follows", () => {
		const text = "a(); /* x */ // y\nb();";
		expect(lineAfter(text, 4)).toEqual({
			at: text.indexOf("\n"),
			eol: "\n"
		});
		expect(lineAfter("a();", 4)).toEqual({
			at: 4,
			eol: "\n"
		});
	});

	it("is the code's own end when code or a comment that runs on follows", () => {
		expect(lineAfter("a(); b();\nc();", 4)).toEqual({
			at: 4,
			eol: "\n"
		});
		expect(lineAfter("a(); /* x\n */\r\nc();", 4)).toEqual({
			at: 4,
			eol: "\r\n"
		});
	});

	it("keeps a CRLF line's carriage return after the insertion", () => {
		expect(lineAfter("a();  \r\nb();", 4)).toEqual({
			at: 6,
			eol: "\r\n"
		});
	});
});

describe("importOf", () => {
	const named = (code: string) => {
		const { checker, file } = compile(code);
		const imported = importOf(checker, file);
		return typeof imported === "string"
			? imported
			: {
					local: imported.local,
					text: applied(code, imported.insertion)
				};
	};

	it("uses treflex's named where the module imports it, under any alias, or a namespace import of treflex", () => {
		expect(named(`import { named as nameIt } from "treflex";`)).toEqual({
			local: "nameIt",
			text: `import { named as nameIt } from "treflex";`
		});
		expect(named(`import type { IEntity } from "treflex";\nimport * as T from "treflex";`)).toEqual({
			local: "T.named",
			text: `import type { IEntity } from "treflex";\nimport * as T from "treflex";`
		});
	});

	it("adds named to the treflex import in order, one a line in a multi-line import", () => {
		expect(named(`import { leading, start } from "treflex";`)).toEqual({
			local: "named",
			text: `import { leading, named, start } from "treflex";`
		});
		expect(named(`import { type IEntity, leading } from "treflex";`)).toEqual({
			local: "named",
			text: `import { type IEntity, leading, named } from "treflex";`
		});
		expect(named(lines("import {", "\tleading,", "\tstart", `} from "treflex";`))).toEqual({
			local: "named",
			text: lines("import {", "\tleading,", "\tnamed,", "\tstart", `} from "treflex";`)
		});
	});

	it("adds an import where Biome sorts it: after a treflex import it can't extend", () => {
		expect(
			named(
				lines(`import type { IEntity } from "treflex"; // e`, `import { y } from "treflex-react";`, `import { x } from "./x";`, "x(y);")
			)
		).toEqual({
			local: "named",
			text: lines(
				`import type { IEntity } from "treflex"; // e`,
				`import { named } from "treflex";`,
				`import { y } from "treflex-react";`,
				`import { x } from "./x";`,
				"x(y);"
			)
		});
	});

	it("adds an import ahead of the first package sorting after treflex or relative import, or else after the last import", () => {
		expect(named(lines(`import { a } from "solid-js";`, `import { z } from "zod";`, `import { x } from "./x";`))).toEqual({
			local: "named",
			text: lines(
				`import { a } from "solid-js";`,
				`import { named } from "treflex";`,
				`import { z } from "zod";`,
				`import { x } from "./x";`
			)
		});
		expect(named(lines(`import { x } from "./x";`, "x();"))).toEqual({
			local: "named",
			text: lines(`import { named } from "treflex";`, `import { x } from "./x";`, "x();")
		});
		expect(named(lines(`import { a } from "solid-js";`, "", "// keep", "// @ts-expect-error", `import x from "./legacy";`))).toEqual({
			local: "named",
			text: lines(
				`import { a } from "solid-js";`,
				"",
				`import { named } from "treflex";`,
				"// keep",
				"// @ts-expect-error",
				`import x from "./legacy";`
			)
		});
		expect(named(lines("// header", "", "// @ts-expect-error", `import x from "./legacy";`))).toEqual({
			local: "named",
			text: lines("// header", "", `import { named } from "treflex";`, "// @ts-expect-error", `import x from "./legacy";`)
		});
		expect(named(lines(`import { a } from "solid-js"; // a`, "a();"))).toEqual({
			local: "named",
			text: lines(`import { a } from "solid-js"; // a`, `import { named } from "treflex";`, "a();")
		});
	});

	it("refuses a module with no imports, or with another binding called named", () => {
		expect(named("function* save() {}")).toBe("noImports");
		expect(named(`import { named } from "./lib";`)).toBe("foreignNamed");
		expect(named(`import { leading } from "treflex";\nfunction named() {}`)).toBe("foreignNamed");
		expect(named(`import { type named } from "treflex";`)).toBe("foreignNamed");
	});
});

describe("actionUses", () => {
	const uses = (code: string) => {
		const { checker, file } = compile(code);
		return calls(file).flatMap((call) =>
			actionUses(checker, call).map((use) => (use.symbol === undefined ? `inline ${use.label}` : use.symbol.name))
		);
	};

	it("finds the actions passed to start, dispatch, leading, latest, a work tag's mark and a feature", () => {
		expect(
			uses(
				lines(
					`import { leading, latest as last, start } from "treflex";`,
					`import * as R from "treflex-react";`,
					"interface IWorkTag { mark(...actions: unknown[]): void }",
					"declare const Busy: IWorkTag;",
					"declare const runtime: { dispatch(a: unknown, t: string): void };",
					"function* a() {}",
					"function* b() {}",
					"function* c() { yield* start(a); }",
					"leading(a);",
					"last((b));",
					`runtime.dispatch(c, "x");`,
					"Busy.mark(a, b);",
					`R.createEntityFeature("F")({ a, renamed: b, *inline() {} });`,
					`runtime.dispatch(function* named() {}, "x");`
				)
			)
		).toEqual([
			"a",
			"a",
			"b",
			"c",
			"a",
			"b",
			"a",
			"b",
			"inline inline",
			"inline named"
		]);
	});

	it("follows an actions object passed by reference, and ignores a mark on anything but a work tag", () => {
		expect(
			uses(
				lines(
					`import { createComponentFeature } from "treflex-solid";`,
					"declare const other: { mark(a: unknown): void };",
					"function* a() {}",
					"function* b() {}",
					"const actions = { a, renamed: b };",
					"other.mark(a);",
					`createComponentFeature("F")(actions);`
				)
			)
		).toEqual([
			"a",
			"b"
		]);
	});
});

describe("createNamer", () => {
	const plans = (code: string, path?: string, taken: string[] = []) => {
		const { checker, file } = compile(code, path);
		const namer = createNamer(checker);
		return calls(file).flatMap((call) =>
			actionUses(checker, call).map((use) => {
				const action = use.symbol === undefined ? null : namer.unnamed(use.symbol);
				if (action === null) {
					return null;
				}
				const plan = namer.plan(action, (name) => taken.includes(name));
				return "mark" in plan ? plan.mark.text.trim() : plan;
			})
		);
	};

	it("prefixes the name with the last segment of the module's feature id, or else its folder", () => {
		expect(
			plans(
				lines(
					`import { createEntityFeature } from "treflex-react";`,
					"function* add_item() {}",
					`createEntityFeature("App/Todo")({ add_item });`
				)
			)
		).toEqual([
			`named(add_item, "Todo/AddItem");`
		]);
		expect(plans(lines(`import { leading } from "treflex";`, "function* save() {}", "leading(save);"))).toEqual([
			`named(save, "TodoList/Save");`
		]);
	});

	it("skips an action its module names, and refuses one it can't name", () => {
		expect(
			plans(
				lines(
					`import { leading, named } from "treflex";`,
					"function* kept() {}",
					`named(kept, "TodoList/Kept");`,
					"leading(kept);",
					"function* taken() {}",
					"leading(taken);",
					"function* save() {}",
					"leading(save);",
					"function* Save() {}",
					"leading(Save);",
					"const typed: () => Generator = function* () {};",
					"leading(typed);",
					"function factory() { function* made() {} leading(made); }"
				),
				undefined,
				[
					"TodoList/Taken"
				]
			)
		).toEqual([
			null,
			{
				reason: "clash",
				name: "TodoList/Taken"
			},
			`named(save, "TodoList/Save");`,
			{
				reason: "clash",
				name: "TodoList/Save"
			},
			{
				reason: "typed"
			},
			{
				reason: "notTopLevel"
			}
		]);
	});

	it("reads a mark's action through parentheses, as, satisfies and !", () => {
		expect(
			plans(
				lines(
					`import { leading, named } from "treflex";`,
					"function* jump() {}",
					`named((jump), "Board/Hop");`,
					"function* move() {}",
					`named(move as never, "Board/Move");`,
					"function* skip() {}",
					`named(skip!, "Board/Skip");`,
					"function* leap() {}",
					`named(leap satisfies unknown, "Board/Leap");`,
					"leading(jump);",
					"leading(move);",
					"leading(skip);",
					"leading(leap);"
				)
			)
		).toEqual([
			null,
			null,
			null,
			null
		]);
	});

	it("refuses a module whose feature id ends in nothing to prefix with", () => {
		expect(
			plans(lines(`import { createEntityFeature } from "treflex-react";`, "function* save() {}", `createEntityFeature("App/")({ save });`))
		).toEqual([
			{
				reason: "noPrefix"
			}
		]);
	});
});
