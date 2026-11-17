import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "../src/index";
import { noDiscardedGenerator } from "../src/noDiscardedGenerator";

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
import { defineEffect, generateGuid, parallel, open, type IActionGenerator, type IEffect, type ISelectorGenerator } from "treflex";
interface IChunk extends IEffect { Type: "app/chunk"; Text: string }
const sendChunk = defineEffect<IChunk, void>("app/chunk");
type IDoc = { $Id: string; X: number };
function* save(d: IDoc): IActionGenerator { d.X = 1; }
function* helper(d: IDoc) { yield* save(d); }
declare function count(d: IDoc): ISelectorGenerator<number>;
async function* stream(): AsyncGenerator<number> { yield 1; }
declare function maybe(): IActionGenerator | undefined;
declare const legacy: any;
declare const cond: boolean;
`;

const DISCARDED = [
	{
		messageId: "discarded" as const
	}
];

function delegated(output: string) {
	return [
		{
			messageId: "discarded" as const,
			suggestions: [
				{
					messageId: "delegate" as const,
					output: `${PREAMBLE} ${output}`
				}
			]
		}
	];
}

ruleTester.run("no-discarded-generator", noDiscardedGenerator, {
	valid: [
		`${PREAMBLE} function* a(d: IDoc) { yield* sendChunk({ Text: "x" }); yield* helper(d); yield* generateGuid(); }`,
		`${PREAMBLE} function* a(d: IDoc) { yield* parallel(save(d), helper(d)); }`,
		`${PREAMBLE} function* a(d: IDoc) { yield* open(save(d)); }`,
		`${PREAMBLE} function a(d: IDoc) { return save(d); }`,
		`${PREAMBLE} const later = (d: IDoc) => save(d);`,
		`${PREAMBLE} function* a(d: IDoc) { const g = save(d); yield* g; }`,
		`${PREAMBLE} function a(d: IDoc) { const g = save(d); g.next(); }`,
		`${PREAMBLE} function a(d: IDoc) { save(d).next(); }`,
		`${PREAMBLE} function a(d: IDoc) { for (const x of helper(d)) { void x; } }`,
		`${PREAMBLE} function a(d: IDoc) { const [first] = helper(d); }`,
		`${PREAMBLE} export const g = save({ $Id: "a", X: 1 });`,
		`${PREAMBLE} function a(d: IDoc) { const g = save(d); return { g }; }`,
		`${PREAMBLE} function a() { legacy(); }`,
		`${PREAMBLE} function a(d: IDoc) { save(d) || legacy; }`,
		`${PREAMBLE} declare const values: number[]; function a() { values.values(); }`,
		`${PREAMBLE} declare function either(): IActionGenerator | number; function a() { either(); }`,
		`${PREAMBLE} interface Generator { next(): void } declare function make(): Generator; function a() { make(); }`,
		`${PREAMBLE} const g = save({ $Id: "a", X: 1 }); export { g };`,
		`${PREAMBLE} declare function iter(): IterableIterator<number>; function a() { iter(); }`,
		`${PREAMBLE} async function a() { for await (const n of stream()) { void n; } }`,
		`${PREAMBLE} async function a() { await (async () => 1)(); }`
	],
	invalid: [
		{
			code: `${PREAMBLE} function* a(d: IDoc) { sendChunk({ Text: "x" }); }`,
			errors: delegated(`function* a(d: IDoc) { yield* sendChunk({ Text: "x" }); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { helper(d); }`,
			errors: delegated(`function* a(d: IDoc) { yield* helper(d); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { generateGuid(); }`,
			errors: delegated(`function* a(d: IDoc) { yield* generateGuid(); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { count(d); }`,
			errors: delegated(`function* a(d: IDoc) { yield* count(d); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { void save(d); }`,
			errors: delegated(`function* a(d: IDoc) { yield* save(d); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { cond && save(d); }`,
			errors: delegated(`function* a(d: IDoc) { cond && (yield* save(d)); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { save(d) as unknown; }`,
			errors: delegated(`function* a(d: IDoc) { yield* save(d); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { save(d) satisfies unknown; }`,
			errors: delegated(`function* a(d: IDoc) { yield* save(d); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { save(d)!; }`,
			errors: delegated(`function* a(d: IDoc) { yield* save(d); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { cond && <unknown>save(d); }`,
			errors: delegated(`function* a(d: IDoc) { cond && (yield* save(d)); }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { legacy ?? save(d); }`,
			errors: delegated(`function* a(d: IDoc) { legacy ?? (yield* save(d)); }`)
		},
		{
			code: `${PREAMBLE} declare const box: { run?: () => IActionGenerator }; function* a() { box.run?.(); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { try { save(d); } finally {} }`,
			errors: delegated(`function* a(d: IDoc) { try { yield* save(d); } finally {} }`)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { try { yield* save(d); } finally { helper(d); } }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { try { yield* save(d); } finally { const inner = function* () { helper(d); }; yield* inner(); } }`,
			errors: delegated(
				`function* a(d: IDoc) { try { yield* save(d); } finally { const inner = function* () { yield* helper(d); }; yield* inner(); } }`
			)
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { class C { static { save(d); } } void C; }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} interface IA extends IActionGenerator { a: 1 } interface IB extends IActionGenerator { b: 1 } declare function mk(): IA | IB; function a() { mk(); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} declare function mk(): (IActionGenerator & { a: 1 }) | (IActionGenerator & { b: 1 }); function a() { mk(); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function a<T extends IActionGenerator>(mk: () => T | IActionGenerator) { mk(); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} declare global { interface Generator<T, TReturn, TNext> { tag?: string } } function a(d: IDoc) { save(d); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { cond ? save(d) : helper(d); }`,
			errors: [
				{
					messageId: "discarded",
					suggestions: [
						{
							messageId: "delegate",
							output: `${PREAMBLE} function* a(d: IDoc) { cond ? (yield* save(d)) : helper(d); }`
						}
					]
				},
				{
					messageId: "discarded",
					suggestions: [
						{
							messageId: "delegate",
							output: `${PREAMBLE} function* a(d: IDoc) { cond ? save(d) : (yield* helper(d)); }`
						}
					]
				}
			]
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { d.X = 2, save(d); }`,
			errors: delegated(`function* a(d: IDoc) { d.X = 2, (yield* save(d)); }`)
		},
		{
			code: `${PREAMBLE} async function* a(d: IDoc) { await save(d); }`,
			errors: delegated(`async function* a(d: IDoc) { yield* save(d); }`)
		},
		{
			code: `${PREAMBLE} function* a() { maybe(); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function a(d: IDoc) { save(d); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { const run = () => { save(d); }; run(); yield* helper(d); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { const g = save(d); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function* a(d: IDoc) { let g = save(d); g = helper(d); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} interface IMine extends Generator<IChunk, void, any> { label: string } declare function mine(): IMine; function* a() { mine(); }`,
			errors: delegated(
				`interface IMine extends Generator<IChunk, void, any> { label: string } declare function mine(): IMine; function* a() { yield* mine(); }`
			)
		},
		{
			code: `${PREAMBLE} declare function tagged(): IActionGenerator & { label: string }; function a() { tagged(); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} function a<G extends IActionGenerator>(make: () => G) { make(); }`,
			errors: DISCARDED
		},
		{
			code: `${PREAMBLE} async function a() { stream(); }`,
			errors: [
				{
					messageId: "discardedAsync" as const
				}
			]
		},
		{
			code: `${PREAMBLE} function* a() { stream(); }`,
			errors: [
				{
					messageId: "discardedAsync" as const
				}
			]
		},
		{
			code: `${PREAMBLE} async function* a() { stream(); }`,
			errors: [
				{
					messageId: "discardedAsync" as const,
					suggestions: [
						{
							messageId: "delegate" as const,
							output: `${PREAMBLE} async function* a() { yield* stream(); }`
						}
					]
				}
			]
		}
	]
});

describe("the plugin", () => {
	it("registers the rule", () => {
		expect(plugin.rules["no-discarded-generator"]).toBe(noDiscardedGenerator);
	});
});
