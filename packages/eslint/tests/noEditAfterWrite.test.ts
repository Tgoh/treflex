import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "../src/index";
import { noEditAfterWrite } from "../src/noEditAfterWrite";

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

const PREAMBLE = `
interface IState { $Id: string; [key: string]: any; }
declare const c: boolean;
declare const xs: any[];
declare function make(): any;
declare function lookup(...args: any[]): any;
declare function park(): Generator<any, any, any>;
`;

const action = (body: string): string => `${PREAMBLE}function* a(d: IState) { ${body} }`;

const REPORTED = [
	{
		messageId: "noEditAfterWrite" as const
	}
];

const flagged = (body: string, name = "row") => ({
	code: action(body),
	errors: [
		{
			messageId: "noEditAfterWrite" as const,
			data: {
				name
			}
		}
	]
});

ruleTester.run("no-edit-after-write", noEditAfterWrite, {
	valid: [
		action(`const row: any = { a: 1 }; row.b = 2; d.Rows.push(row);`),
		action(`const row: any = []; row.push(1); d.X = row;`),

		action(`let row: any = { a: 1 }; d.X = row; row = { a: 2 }; row.b = 2;`),
		action(`let row: any = { a: 1 }; d.X = row; [row] = xs; row.b = 2;`),
		action(`let row: any = { a: 1 }; d.X = row; ({ row } = make()); row.b = 2;`),
		action(`let row: any = { a: 1 }; d.X = row; for (row of xs) { row.b = 2; }`),

		action(`const row: any = { a: 1 }; d.X = row; const b = row.a; lookup(row);`),
		action(`const row: any = [1]; d.X = row; row.map((n: number) => n); row.slice().sort(); row.at(0);`),
		action(`const row: any = { a: [1] }; d.X = row; row.a.slice().reverse();`),

		action(`const n = d.Rows[0]; d.Other = n; n.x = 1;`),
		action(`const n = d.Rows.find((r: any) => r.On); d.Other = n; n.x = 1;`),
		action(`const n = d.Rows[0] as any; d.Other = n!; n.x = 1;`),
		action(`const { n } = d; d.Other = n; n.x = 1;`),
		action(`const m = d.Rows[0]; const n = m.Child; d.Other = n; n.x = 1;`),
		action(`let n: any; n = d.Rows[0]; d.Other = n; n.x = 1;`),
		action(`let n: any; if (c) { n = d.Rows[0]; } else { n = {}; } d.Other = n; n.x = 1;`),
		action(`let n: any = {}; n = d.Rows[0]; d.Other = n; n.x = 1;`),
		action(`for (const n of d.Rows) { d.Other = n; n.x = 1; }`),

		action(`const n = lookup(d.Rows, "id"); d.Other = n; n.x = 1;`),
		action(`const n = yield* park2(d); d.Other = n; n.x = 1; function* park2(x: any) { return x.A; }`),
		action(`const n = d.A ?? {}; d.Other = n; n.x = 1;`),
		action(`const rows = d.Rows.slice(); const n = rows[0]; d.Other = n; n.x = 1;`),

		action(`const copy = d.Rows.slice(); const row: any = { a: 1 }; copy.push(row); row.b = 2;`),
		action(`const list: any[] = []; const row: any = { a: 1 }; list.push(row); row.b = 2;`),

		action(`const row: any = { a: 1 }; d.X = row; { const row: any = {}; row.b = 2; }`),
		action(`const row: any = { a: 1 }; { const row: any = {}; d.X = row; } row.b = 2;`),
		`${PREAMBLE}const d: any = {}; function* a(e: IState) { const row: any = {}; d.X = row; row.b = 2; }`,

		action(`const row: any = { a: 1 }; d.X = row; const later = () => { row.b = 2; };`),
		action(`const row: any = { a: 1 }; const f = () => { d.X = row; }; row.b = 2;`),

		action(`const row: any = { a: 1 }; if (c) { d.X = row; } else { row.b = 2; }`),
		action(`const row: any = { a: 1 }; c ? (d.X = row) : (row.b = 2);`),
		action(`const row: any = { a: 1 }; switch (make()) { case 1: d.X = row; break; default: row.b = 2; }`),

		action(`const row: any = { a: 1 }; if (c) { d.X = row; return; } row.b = 2;`),
		action(`const row: any = { a: 1 }; if (c) { d.X = row; throw new Error(); } row.b = 2;`),
		action(`const row: any = { a: 1 }; if (c) return void d.Other.push(row); row.b = 2;`),
		action(`const row: any = { a: 1 }; if (c) throw (d.X = row); row.b = 2;`),
		action(`const row: any = { a: 1 }; done: { if (c) { d.X = row; break done; } row.b = 2; }`),
		action(`const row: any = { a: 1 }; outer: for (const x of xs) { for (const y of xs) { d.X = row; break outer; } row.b = 2; }`),
		action(`const row: any = { a: 1 }; outer: for (const x of xs) { for (const y of xs) { d.X = row; continue outer; } row.b = 2; }`),
		action(`for (const x of xs) { const row: any = { x }; if (c) { d.Rows.push(row); continue; } row.b = 2; d.Other.push(row); }`),

		// Object.assign freezes what the source holds, not the source.
		action(`const row: any = { a: 1 }; Object.assign(d.X, row); row.b = 2;`),
		action(`const row: any = { a: 1 }; Object.assign(d.X, row); delete row.a;`),
		action(`const row: any = [1]; Object.assign(d.X, row); row.push(2);`),
		action(`const row: any = { a: 1 }; Object.assign(d.X, row); Object.assign(row, { b: 2 });`),
		action(`const row: any = { a: 1 }; Object.assign(row, { b: 2 }); d.X = row;`),
		action(`const row: any = { a: {} }; Object.assign(make(), row); row.a.b = 2;`),
		action(`const row: any = { a: {} }; foo.assign(d.X, row); row.a.b = 2;`),

		action(`const at: any = { a: 1 }; d.Rows.splice(at, 1); at.b = 2;`),
		action(`const n: any = { a: 1 }; d.Rows.splice(0, n); n.b = 2;`),

		// A spread argument freezes the elements and leaves the array open.
		action(`const rows: any[] = []; d.Rows.push(...rows); rows.push(1);`),

		// A parameter may be a live node.
		`${PREAMBLE}function* a(d: IState, row: any) { d.X = row; row.b = 2; }`,
		`${PREAMBLE}function* a(d: IState, n: any) { const kid = n.Child; delete n.Child; d.Other.push(kid); kid.x = 5; }`,
		`${PREAMBLE}function* a(d: IState, n: any) { const kid = n; d.Other.push(kid); kid.x = 5; }`,
		action(`for (const r of d.Rows) { const kid = r.Child; delete r.Child; d.Other.push(kid); kid.x = 5; }`),
		action(`for (const r of xs) { const kid = r.Items.find((i: any) => i.On); d.Other.push(kid); kid.x = 5; }`),
		action(`let r: any; for (r of xs) { const kid = r.Child; d.Other.push(kid); kid.x = 5; }`),
		action(`const { n } = make(); const kid = n.Child; d.X = kid; kid.b = 2;`),
		action(`const { n } = make(); d.X = n; n.b = 2;`),

		action(`const row: any = { a: 1 }; d.X = row; typeof row.a; !row.a;`),
		action(`const row: any = {}; let s: any = d; s = make(); s.X = row; row.b = 2;`),

		action(`function* inner() { const row: any = {}; d.X = row; row.b = 2; }`),
		action(`function inner() { const row: any = {}; d.X = row; row.b = 2; }`),
		action(`const inner = function () { const row: any = {}; d.X = row; row.b = 2; };`),
		action(`const inner = () => { const row: any = {}; d.X = row; row.b = 2; };`),

		`${PREAMBLE}function* a(d: { $Id: number; X: any }) { const row: any = {}; d.X = row; row.b = 2; }`,
		`${PREAMBLE}function a(d: IState) { const row: any = {}; d.X = row; row.b = 2; }`,
		`${PREAMBLE}function* a(d: { X: any }) { const row: any = {}; d.X = row; row.b = 2; }`,
		`${PREAMBLE}function* a(id: string, d: IState) { const row: any = {}; d.X = row; row.b = 2; }`,
		`${PREAMBLE}function* a() { const row: any = {}; const d: IState = make(); d.X = row; row.b = 2; }`
	],
	invalid: [
		flagged(`const row: any = { a: 1 }; d.X = row; row.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.a.b = row; row.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.Rows[0] = row; row.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.Rows.push(row); row.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.Rows.unshift(row); row.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.Rows.splice(0, 0, row); row.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.a.Rows.push(make(), row); row.b = 2;`),
		flagged(`const row: any = { a: 1 }; (d.Rows as any[]).push(row as any); row.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.Rows?.push(row); row.b = 2;`),
		flagged(`const row: any = { a: {} }; Object.assign(d.X, row); row.a.b = 2;`, "row.a"),
		flagged(`const row: any = { a: [] }; Object.assign(d.X, make(), row); row.a.push(1);`, "row.a"),
		flagged(`const row: any = { a: {} }; Object.assign(d.X, row); Object.assign(row.a, { b: 2 });`, "row.a"),
		flagged(`const row: any = { a: {} }; Object.assign(d.X, row); d.Y = row; row.a.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.X = row; Object.assign(row, { b: 2 });`),
		flagged(`const row: any = { a: {} }; d.X = row; Object.assign(row.a, { b: 2 });`),
		{
			code: `${PREAMBLE}function* a(d: IState, id: string) { const row = make(id); d.X = row; row.b = 2; }`,
			errors: REPORTED
		},
		flagged(`const row: any = { a: 1 }; done: { d.X = row; break done; } row.b = 2;`),
		flagged(`const row: any = { a: 1 }; outer: for (const x of xs) { for (const y of xs) { d.X = row; break outer; } } row.b = 2;`),

		flagged(`const rows = d.Rows; const row: any = { a: 1 }; rows.push(row); row.b = 2;`),
		flagged(`const { Rows } = d; const row: any = { a: 1 }; Rows.push(row); row.b = 2;`),
		flagged(`const s = d; const row: any = { a: 1 }; s.X = row; row.b = 2;`),
		flagged(`const n = d.Rows.find((r: any) => r.On); const row: any = { a: 1 }; n.Child = row; row.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.Rows.at(-1).Items.push(row); row.b = 2;`),

		flagged(`const row: any = { a: {} }; d.X = row; row.a.b = 2;`),
		flagged(`const row: any = { a: 1 }; d.X = row; row["a"] = 2;`),
		flagged(`const row: any = { a: 1 }; d.X = row; row.a += 2;`),
		flagged(`const row: any = { a: 1 }; d.X = row; delete row.a;`),
		flagged(`const row: any = { a: 1 }; d.X = row; delete row?.a;`),
		flagged(`const row: any = { a: 1 }; d.X = row; row.a++;`),
		flagged(`const row: any = { a: 1 }; d.X = row; --row.a;`),
		flagged(`const row: any = { a: 1 }; d.X = row; (row as any).b = 2;`),
		flagged(`const row: any = { a: 1 }; d.X = row; row!.b = 2;`),
		flagged(`const row: any = []; d.X = row; row.push(1);`),
		flagged(`const row: any = []; d.X = row; row.pop();`),
		flagged(`const row: any = []; d.X = row; row.shift();`),
		flagged(`const row: any = []; d.X = row; row.unshift(1);`),
		flagged(`const row: any = []; d.X = row; row.splice(0, 1);`),
		flagged(`const row: any = []; d.X = row; row.sort();`),
		flagged(`const row: any = []; d.X = row; row.reverse();`),
		flagged(`const row: any = []; d.X = row; row.fill(0);`),
		flagged(`const row: any = []; d.X = row; row.copyWithin(0, 1);`),
		flagged(`const row: any = { a: [] }; d.X = row; row.a.sort();`),

		flagged(`const row = make(); d.X = row; row.b = 2;`),
		flagged(`const row = yield* park(); d.X = row; row.b = 2;`),
		flagged(`const row: any = { ...d.Rows[0] }; d.Other = row; row.b = 2;`),
		flagged(`const row: any = { Id: d.NextId }; d.Rows.push(row); row.b = 2;`),
		flagged(`let row: any; row = { a: 1 }; d.X = row; row.b = 2;`),
		flagged(`let row: any = { a: 1 }; d.X = row; row = { a: 2 }; d.Y = row; row.b = 2;`),

		flagged(`const row: any = { a: 1 }; d.X = row; yield* park(); row.b = 2;`),

		flagged(`const row: any = { a: 1 }; if (c) { d.X = row; } row.b = 2;`),
		flagged(`const row: any = { a: 1 }; if (c) { d.X = row; } else { d.Y = row; } row.b = 2;`),
		flagged(`const row: any = { a: 1 }; if (d.X = row) { row.b = 2; }`),
		flagged(`const row: any = { a: 1 }; for (const x of xs) { if (x) { d.X = row; break; } } row.b = 2;`),
		flagged(`const row: any = { a: 1 }; switch (make()) { case 1: d.X = row; default: row.b = 2; }`),
		flagged(`const row: any = { a: 1 }; try { d.X = row; row.b = 2; } catch {}`),

		{
			code: `${PREAMBLE}const a = function* (d: IState) { const row: any = {}; d.X = row; row.b = 2; };`,
			errors: [
				{
					messageId: "noEditAfterWrite" as const
				}
			]
		},
		{
			code: `${PREAMBLE}const o = { *a(d: IState) { const row: any = {}; d.X = row; row.b = 2; } };`,
			errors: [
				{
					messageId: "noEditAfterWrite" as const
				}
			]
		},

		{
			code: action(`const row: any = {}; const other: any = []; d.X = row; d.Y = other; row.b = 2; other.push(1); row.c = 3;`),
			errors: [
				{
					messageId: "noEditAfterWrite" as const,
					data: {
						name: "row"
					}
				},
				{
					messageId: "noEditAfterWrite" as const,
					data: {
						name: "other"
					}
				},
				{
					messageId: "noEditAfterWrite" as const,
					data: {
						name: "row"
					}
				}
			]
		}
	]
});

describe("the plugin", () => {
	it("registers the rule", () => {
		expect(plugin.rules["no-edit-after-write"]).toBe(noEditAfterWrite);
	});
});
