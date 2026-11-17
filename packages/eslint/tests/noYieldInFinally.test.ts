import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "../src/index";
import { noYieldInFinally } from "../src/noYieldInFinally";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

const REPORTED = [
	{
		messageId: "noYieldInFinally" as const
	}
];

ruleTester.run("no-yield-in-finally", noYieldInFinally, {
	valid: [
		"function* a() { try { yield* work(); } finally { cleanUp(); } }",
		"function* a() { try { yield* work(); } catch (error) { yield* report(error); } }",
		"function* a() { try { yield* work(); } finally {} yield* after(); }",
		"function* a() { try { yield* work(); } finally { const later = function* () { yield* work(); }; } }",
		"function* a() { try { yield* work(); } finally { items.forEach(() => cleanUp()); } }",
		"function a() { try { work(); } finally { cleanUp(); } }",
		`import { transient } from "treflex"; function* a(d) { try { yield* work(); } finally { (yield* transient(d, "Load", { Count: 0 })).Count--; } }`,
		`import { transient as named } from "treflex"; function* a(d) { try { yield* work(); } finally { (yield* named(d, "Load", { Count: 0 })).Count--; } }`,
		`function* a(d) { try { yield* work(); } finally { (yield* transient(d, "Load", { Count: 0 })).Count--; } }`
	],
	invalid: [
		{
			code: "function* a() { try { yield* work(); } finally { yield* cleanUp(); } }",
			errors: REPORTED
		},
		{
			code: `function* a() { try { yield* work(); } finally { yield { Type: "echo" }; } }`,
			errors: REPORTED
		},
		{
			code: "const a = function* () { try { yield* work(); } finally { if (x) { yield* cleanUp(); } } };",
			errors: REPORTED
		},
		{
			code: "function* a() { try { yield* work(); } finally { try { cleanUp(); } catch { yield* report(); } } }",
			errors: REPORTED
		},
		{
			code: "function* a() { try { yield* work(); } finally { const b = function* () { try {} finally { yield* cleanUp(); } }; } }",
			errors: REPORTED
		},
		{
			code: `import { open, start } from "treflex"; function* a() { try { yield* work(); } finally { yield* open(load()); yield* start(save, "row"); } }`,
			errors: [
				...REPORTED,
				...REPORTED
			]
		},
		{
			code: `function transient() {} function* a(d) { try { yield* work(); } finally { yield* transient(d); } }`,
			errors: REPORTED
		},
		{
			code: `import { transient } from "treflex"; function* a(d) { try { yield* work(); } finally { yield transient(d, "Load", {}); } }`,
			errors: REPORTED
		}
	]
});

describe("the plugin", () => {
	it("registers the rule", () => {
		expect(plugin.rules["no-yield-in-finally"]).toBe(noYieldInFinally);
	});
});
