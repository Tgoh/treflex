import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "../src/index";
import { noHiddenOpen } from "../src/noHiddenOpen";

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
import { open, parallel, type IActionGenerator, type IActionYield, type IOpenMark } from "treflex";
declare function fetchIt(): IActionGenerator<string>;
function* withX<R, Y extends IActionYield | IOpenMark>(body: () => Generator<Y, R, any>): Generator<IActionYield | Y, R, any> { return yield* body(); }
type IDoc = { X: number };
function* loadPreview(d: IDoc) { const r = yield* open(fetchIt()); d.X = r.length; }
function* plain(d: IDoc): IActionGenerator { d.X = (yield* fetchIt()).length; }
`;

const ANY_CALLER = [
	{
		messageId: "anyCaller" as const
	}
];

ruleTester.run("no-hidden-open", noHiddenOpen, {
	valid: [
		`${PREAMBLE} function* a(d: IDoc) { yield* open(fetchIt()); yield* loadPreview(d); }`,
		`${PREAMBLE} function* inferred(d: IDoc) { yield* loadPreview(d); }`,
		`${PREAMBLE} function* a(d: IDoc) { yield* open(fetchIt()); yield* plain(d); yield* fetchIt(); }`,
		`${PREAMBLE} function* a(d: IDoc) { yield* open(parallel(plain(d), fetchIt())); }`,
		`${PREAMBLE} function* a(d: IDoc) { yield* open(fetchIt()); const inner = function* () { yield* fetchIt(); }; }`,
		`${PREAMBLE} function* a(d: IDoc) { yield* open(fetchIt()); yield* withX(() => loadPreview(d)); }`,
		`${PREAMBLE} function* a(d: IDoc) { yield* open(fetchIt()); yield* withX(function* () { const r = yield* open(fetchIt()); d.X = r.length; }); }`,
		`${PREAMBLE} declare const legacy: any; function* a(d: IDoc) { yield* legacy(d); yield* plain(d); }`,
		`${PREAMBLE} import type { ISelectorGenerator } from "treflex"; declare const legacySelector: any; function* s(d: IDoc): ISelectorGenerator<number> { return yield* legacySelector(d); }`,
		`${PREAMBLE} declare function anything(): Generator<any, void, any>; function* a(): IActionGenerator { yield* anything(); }`
	],
	invalid: [
		{
			code: `${PREAMBLE} declare const legacy: any; function* a(d: IDoc) { yield* open(fetchIt()); yield* legacy(d); }`,
			errors: ANY_CALLER
		},
		{
			code: `${PREAMBLE} declare function anything(): Generator<any, void, any>; function* a() { yield* open(fetchIt()); yield* anything(); }`,
			errors: ANY_CALLER
		},
		{
			code: `${PREAMBLE} declare const legacy: any; function* a(d: IDoc) { yield* loadPreview(d); yield* legacy(d); }`,
			errors: ANY_CALLER
		},
		{
			code: `${PREAMBLE} function* wide(d: IDoc): Generator<any, void, any> { yield* loadPreview(d); }`,
			errors: ANY_CALLER
		},
		{
			code: `${PREAMBLE} function* wide(d: IDoc): Generator<any, void, any> { yield* withX(() => open(fetchIt())); }`,
			errors: ANY_CALLER
		},
		{
			code: `${PREAMBLE} declare const helper: any; function* a(d: IDoc): IActionGenerator { yield* helper(d); }`,
			errors: [
				{
					messageId: "unknownCall" as const
				}
			]
		}
	]
});

describe("the plugin", () => {
	it("registers the rule", () => {
		expect(plugin.rules["no-hidden-open"]).toBe(noHiddenOpen);
	});
});
