import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "../src/index";
import { noGlobalOpen } from "../src/noGlobalOpen";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

const REPORTED = [
	{
		messageId: "noGlobalOpen" as const
	}
];

ruleTester.run("no-global-open", noGlobalOpen, {
	valid: [
		`import { open } from "treflex"; function* a() { yield* open(load()); }`,
		`import { open as letIn } from "treflex"; function* a() { yield* letIn(load()); }`,
		`import { open } from "node:fs/promises"; async function a() { await open("file.txt"); }`,
		`function open(url) {} open("https://example.com");`,
		`function* a(open) { yield* open(load()); }`,
		`window.open("https://example.com");`,
		`globalThis.open("https://example.com");`
	],
	invalid: [
		{
			code: "function* a() { yield* open(load()); }",
			errors: REPORTED
		},
		{
			code: `import { parallel } from "treflex"; function* a() { yield* open(parallel(load(), load())); }`,
			errors: REPORTED
		},
		{
			code: `button.onclick = () => open("https://example.com");`,
			errors: REPORTED
		}
	]
});

describe("the plugin", () => {
	it("registers the rule", () => {
		expect(plugin.rules["no-global-open"]).toBe(noGlobalOpen);
	});
});
