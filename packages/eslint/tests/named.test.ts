import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { named } from "../src/named";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

const PREAMBLE = `
import { named } from "treflex";
function* save() {}
function* load() {}
`;

ruleTester.run("named", named, {
	valid: [
		`${PREAMBLE} named(save, "Doc/Save"); named(load, "Doc/Load");`,
		`${PREAMBLE} named(save, \`Doc/Save\`);`,
		`import { named as nameIt } from "treflex"; function* save() {} nameIt(save, "Doc/Save");`,
		`function named(a: unknown, b: unknown) {} function* save() {} named(save, save.name);`,
		`import * as T from "treflex"; export function* save() {} T.named(save, "Doc/Save"); T.leading(save);`,
		`function makeSave() { function named(a: unknown, b: string) {} function* save() {} named(save, "Doc/Save"); }`
	],
	invalid: [
		{
			code: `import { named } from "treflex"; export function makeSave(field: string) { function* save() {} named(save, "Doc/Save"); return save; }`,
			errors: [
				{
					messageId: "notTopLevel"
				}
			]
		},
		{
			code: `${PREAMBLE} declare const enabled: boolean; if (enabled) { named(save, "Doc/Save"); }`,
			errors: [
				{
					messageId: "notTopLevel"
				}
			]
		},
		{
			code: `import { named } from "treflex"; export const save = named(function* save() {}, "Doc/Save");`,
			errors: [
				{
					messageId: "notTopLevel"
				}
			]
		},
		{
			code: `import * as T from "treflex"; function* save() {} T.named(save, save.name);`,
			errors: [
				{
					messageId: "notLiteral"
				}
			]
		},
		{
			code: `${PREAMBLE} named(save, save.name);`,
			errors: [
				{
					messageId: "notLiteral"
				}
			]
		},
		{
			code: `${PREAMBLE} const prefix = "Doc"; named(save, \`\${prefix}/Save\`);`,
			errors: [
				{
					messageId: "notLiteral"
				}
			]
		},
		{
			code: `${PREAMBLE} named(save, "Doc/Save"); named(load, "Doc/Save");`,
			errors: [
				{
					messageId: "duplicate",
					data: {
						name: "Doc/Save"
					}
				}
			]
		},
		{
			code: `import { named as nameIt } from "treflex"; function* save() {} function* load() {} nameIt(save, "Doc/Save"); nameIt(load, "Doc/Save");`,
			errors: [
				{
					messageId: "duplicate"
				}
			]
		}
	]
});
