import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "../src/index";
import { noReturnedPromise } from "../src/noReturnedPromise";

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
import { defineEffect, parallel, type IActionGenerator, type IEffect } from "treflex";
interface ISave extends IEffect { Type: "app/save"; X: number }
const save = defineEffect<ISave, string>("app/save");
declare const api: { save(x: number): Promise<string> };
declare const cache: { read(x: number): Promise<string> | string };
interface IQuery { then(resolve: (rows: string[]) => void): void }
declare function query(): IQuery;
`;

function returned(name: string) {
	return [
		{
			messageId: "returnedPromise" as const,
			data: {
				name
			}
		}
	];
}

ruleTester.run("no-returned-promise", noReturnedPromise, {
	valid: [
		`${PREAMBLE} function* a(x: number): IActionGenerator<string> { return yield* save({ X: x }); }`,
		`${PREAMBLE} function* a(x: number) { const p = api.save(x); return x; }`,
		`${PREAMBLE} declare const legacy: any; function* a(x: number) { return legacy.save(x); }`,
		`${PREAMBLE} declare const loose: unknown; function* a() { return loose; }`,
		`${PREAMBLE} function* a<T>(value: T) { return value; }`,
		`${PREAMBLE} function* a(x: number) { const later = () => { return api.save(x); }; yield* save({ X: x }); return 1; }`,
		`${PREAMBLE} function* a(x: number) { [x].map(function (y) { return api.save(y); }); return x; }`,
		`${PREAMBLE} async function* a(x: number) { return api.save(x); }`,
		`${PREAMBLE} function a(x: number) { return api.save(x); }`,
		`${PREAMBLE} function* a() { return; }`,
		`${PREAMBLE} function* a(x: number) { return { saved: api.save(x) }; }`,
		`${PREAMBLE} function* a(): Generator<never, { then: string }> { return { then: "later" }; }`,
		`${PREAMBLE} interface Function { name: string } function* a(v: { then: Function }) { return v; }`
	],
	invalid: [
		{
			code: `${PREAMBLE} function* a(x: number) { return api.save(x); }`,
			errors: returned("api.save(...)")
		},
		{
			code: `${PREAMBLE} function* a() { return query(); }`,
			errors: returned("query(...)")
		},
		{
			code: `${PREAMBLE} function* a(x: number) { return cache.read(x); }`,
			errors: returned("cache.read(...)")
		},
		{
			code: `${PREAMBLE} function* a(x: number) { const pending = api.save(x); return pending; }`,
			errors: returned("pending")
		},
		{
			code: `${PREAMBLE} function* a() { return new Promise<number>((resolve) => resolve(1)); }`,
			errors: returned("new Promise(...)")
		},
		{
			code: `${PREAMBLE} function* a<T extends PromiseLike<number>>(value: T) { return value; }`,
			errors: returned("value")
		},
		{
			code: `${PREAMBLE} function* a(x: number) { if (x > 0) { return api.save(x) as Promise<string>; } return "none"; }`,
			errors: returned("api.save(...)")
		},
		{
			code: `${PREAMBLE} function* branch(x: number) { return api.save(x); } function* a(x: number) { yield* parallel(branch(x), save({ X: x })); }`,
			errors: returned("api.save(...)")
		},
		{
			code: `${PREAMBLE} class Store { *load(x: number) { return api.save(x); } }`,
			errors: returned("api.save(...)")
		},
		{
			code: `${PREAMBLE} const store = { *load(x: number) { return api.save(x); } };`,
			errors: returned("api.save(...)")
		},
		{
			code: `${PREAMBLE} function* a(x: number) { function* inner() { return api.save(x); } yield* inner(); return x; }`,
			errors: returned("api.save(...)")
		},
		{
			code: `${PREAMBLE} function* a(x: number) { return x > 0 ? api.save(x) : "none"; }`,
			errors: returned('x > 0 ? api.save(x) : "none"')
		},
		{
			code: `${PREAMBLE} function* a(v: { then: string | (() => void) }) { return v; }`,
			errors: returned("v")
		},
		{
			code: `${PREAMBLE} function* a(v: { then?: () => void }) { return v; }`,
			errors: returned("v")
		},
		{
			code: `${PREAMBLE} function* a(v: { then: Function }) { return v; }`,
			errors: returned("v")
		}
	]
});

describe("the plugin", () => {
	it("registers the rule", () => {
		expect(plugin.rules["no-returned-promise"]).toBe(noReturnedPromise);
	});
});
