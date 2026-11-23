import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import parser from "@typescript-eslint/parser";
import { build } from "esbuild";
import { Linter } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../src/index";

const RULE = "treflex/no-main-state-in-lifecycle";
const PACKAGE = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");

const HEAD =
	'import { onMount } from "solid-js";\nimport Thread from "./Thread";\n\nexport function View() {\n\tconst thread = Thread.use();\n';
const SITE = "\tonMount(() => void thread.load());\n";
const TAIL = "\treturn null;\n}\n";

interface IExpected {
	reason: number[];
	site: number[];
}

interface IForm {
	name: string;
	code: string;
	eslint: IExpected;
	oxlint: IExpected;
}

const FORMS: IForm[] = [
	{
		name: "next-line",
		code: `${HEAD}\t// eslint-disable-next-line ${RULE}\n${SITE}${TAIL}`,
		eslint: {
			reason: [
				6
			],
			site: []
		},
		oxlint: {
			reason: [
				5
			],
			site: []
		}
	},
	{
		name: "same-line, line comment",
		code: `${HEAD}\tonMount(() => void thread.load()); // eslint-disable-line ${RULE}\n${TAIL}`,
		eslint: {
			reason: [
				6
			],
			site: []
		},
		oxlint: {
			reason: [
				5
			],
			site: []
		}
	},
	{
		name: "same-line, block comment",
		code: `${HEAD}\tonMount(() => void thread.load()); /* eslint-disable-line ${RULE} */\n${TAIL}`,
		eslint: {
			reason: [
				6
			],
			site: []
		},
		oxlint: {
			reason: [
				5
			],
			site: []
		}
	},
	{
		name: "a range mid-file with no enable",
		code: `${HEAD}\t/* eslint-disable ${RULE} */\n${SITE}${TAIL}`,
		eslint: {
			reason: [
				6
			],
			site: []
		},
		oxlint: {
			reason: [
				5
			],
			site: []
		}
	},
	{
		name: "a range mid-file closed by an enable",
		code: `${HEAD}\t/* eslint-disable ${RULE} */\n${SITE}\t/* eslint-enable ${RULE} */\n${SITE}${TAIL}`,
		eslint: {
			reason: [
				6
			],
			site: [
				9
			]
		},
		oxlint: {
			reason: [
				5
			],
			site: [
				9
			]
		}
	},
	{
		name: "a range at the top of the file with no enable",
		code: `/* eslint-disable ${RULE} */\n${HEAD}${SITE}${TAIL}`,
		eslint: {
			reason: [
				1
			],
			site: []
		},
		oxlint: {
			reason: [
				1
			],
			site: []
		}
	},
	{
		name: "next-line on line 1",
		code: `// eslint-disable-next-line ${RULE}\nonMount(() => void Thread.use().load());\n`,
		eslint: {
			reason: [
				1
			],
			site: []
		},
		oxlint: {
			reason: [
				1
			],
			site: []
		}
	},
	{
		name: "the oxlint- prefix, which only oxlint reads",
		code: `${HEAD}\t// oxlint-disable-next-line ${RULE}\n${SITE}${TAIL}`,
		eslint: {
			reason: [],
			site: [
				7
			]
		},
		oxlint: {
			reason: [
				5
			],
			site: []
		}
	},
	{
		name: "a space-separated rule list, which only oxlint reads as two rules",
		code: `${HEAD}\t// eslint-disable-next-line no-console ${RULE}\n${SITE}${TAIL}`,
		eslint: {
			reason: [
				6
			],
			site: [
				7
			]
		},
		oxlint: {
			reason: [
				5
			],
			site: []
		}
	},
	{
		name: "a bare trailing --",
		code: `${HEAD}\t// eslint-disable-next-line ${RULE} --\n${SITE}${TAIL}`,
		eslint: {
			reason: [
				6
			],
			site: [
				7
			]
		},
		oxlint: {
			reason: [
				5
			],
			site: []
		}
	},
	{
		name: "a reason after --",
		code: `${HEAD}\t// eslint-disable-next-line ${RULE} -- the completion on screen is the visit\n${SITE}${TAIL}`,
		eslint: {
			reason: [],
			site: []
		},
		oxlint: {
			reason: [],
			site: []
		}
	},
	{
		name: "a blanket next-line directive over a site",
		code: `${HEAD}\t// eslint-disable-next-line\n${SITE}${TAIL}`,
		eslint: {
			reason: [
				6
			],
			site: []
		},
		oxlint: {
			reason: [
				5
			],
			site: []
		}
	},
	{
		name: "a blanket next-line directive over no site",
		code: `${HEAD}\t// eslint-disable-next-line\n\tconst other = 1;\n${SITE}\treturn other;\n}\n`,
		eslint: {
			reason: [],
			site: [
				8
			]
		},
		oxlint: {
			reason: [],
			site: [
				8
			]
		}
	},
	{
		name: "a blanket range, which stays open",
		code: `${HEAD}\t/* eslint-disable */\n${SITE}${TAIL}`,
		eslint: {
			reason: [],
			site: []
		},
		oxlint: {
			reason: [],
			site: []
		}
	},
	{
		name: "a reasonless directive on the line of the enable that closes a reasoned range, which isn't seen",
		code: `${HEAD}\t/* eslint-disable ${RULE} -- the visit is on screen */\n${SITE}\t/* eslint-enable ${RULE} */ // eslint-disable-line ${RULE}\n${TAIL}`,
		eslint: {
			reason: [],
			site: []
		},
		oxlint: {
			reason: [],
			site: []
		}
	}
];

function lintWithEslint(
	code: string,
	namespace = "treflex"
): {
	reason: number[];
	site: number[];
	messages: string[];
} {
	const rule = `${namespace}/no-main-state-in-lifecycle`;
	const messages = new Linter().verify(
		code,
		[
			{
				files: [
					"**/*.tsx"
				],
				languageOptions: {
					parser
				},
				linterOptions: {
					reportUnusedDisableDirectives: "off"
				},
				plugins: {
					[namespace]: plugin
				},
				rules: {
					[rule]: "error"
				}
			}
		] as never,
		"view.tsx"
	);
	const own = messages.filter((message) => message.ruleId === rule);
	return {
		reason: own.filter((message) => message.messageId === "reasonRequired").map((message) => message.line),
		site: own.filter((message) => message.messageId === "noMainStateInLifecycle").map((message) => message.line),
		messages: own.map((message) => message.message)
	};
}

describe("the reason on the opt-in, under ESLint", () => {
	for (const form of FORMS) {
		it(`reports ${form.name} where no directive covers the report`, () => {
			const { reason, site } = lintWithEslint(form.code);
			expect({
				reason,
				site
			}).toEqual(form.eslint);
		});
	}

	it("lands at the start of the directive's line, before the directive", () => {
		const [message] = new Linter()
			.verify(
				`/* eslint-disable ${RULE} */\n${HEAD}${SITE}${TAIL}`,
				[
					{
						files: [
							"**/*.tsx"
						],
						languageOptions: {
							parser
						},
						plugins: {
							treflex: plugin
						},
						rules: {
							[RULE]: "error"
						}
					}
				] as never,
				"view.tsx"
			)
			.filter((m) => m.ruleId === RULE);
		expect([
			message?.line,
			message?.column
		]).toEqual([
			1,
			0
		]);
	});

	it("names the rule as it is registered", () => {
		const { reason, messages } = lintWithEslint(
			`${HEAD}\t// eslint-disable-next-line other/no-main-state-in-lifecycle\n${SITE}${TAIL}`,
			"other"
		);
		expect(reason).toEqual([
			6
		]);
		expect(messages[0]).toContain("This turns other/no-main-state-in-lifecycle off");
	});
});

const require = createRequire(import.meta.url);
const OXLINT = (() => {
	try {
		return join(require.resolve("oxlint/package.json"), "..", "bin", "oxlint");
	} catch {
		return undefined;
	}
})();
const BUNDLE = join(PACKAGE, "node_modules", `.treflex-oxlint-plugin-${process.pid}.mjs`);
const SKIP_OXLINT = "TREFLEX_SKIP_OXLINT";

function requireOxlint(unavailable: string | undefined, skip: (note: string) => void): void {
	if (!unavailable) {
		return;
	}
	if (process.env[SKIP_OXLINT] === "1") {
		skip(`${SKIP_OXLINT}=1, so oxlint's half of the boundary isn't checked: ${unavailable}`);
	}
	throw new Error(
		`oxlint can't start, so its half of the boundary goes unchecked: ${unavailable}. Set ${SKIP_OXLINT}=1 to skip it on purpose.`
	);
}

function oxlintStart(): string | undefined {
	if (!OXLINT) {
		return "oxlint isn't installed";
	}
	const probe = spawnSync(
		process.execPath,
		[
			OXLINT,
			"--version"
		],
		{
			encoding: "utf8",
			timeout: 60_000
		}
	);
	if (probe.error || probe.status !== 0) {
		return `oxlint --version failed: ${probe.error?.message ?? probe.stderr.trim()}`;
	}
	return undefined;
}

describe("the reason on the opt-in, under oxlint", () => {
	const unavailable = oxlintStart();
	const dir = mkdtempSync(join(tmpdir(), "treflex-oxlint-"));
	const reports = new Map<
		string,
		IExpected & {
			messages: string[];
		}
	>();

	function lintWithOxlint(files: Record<string, string>, jsPlugin: unknown, rule: string): void {
		writeFileSync(
			join(dir, ".oxlintrc.json"),
			JSON.stringify({
				jsPlugins: [
					jsPlugin
				],
				plugins: [],
				rules: {
					[rule]: "error"
				}
			})
		);
		for (const [name, code] of Object.entries(files)) {
			writeFileSync(join(dir, name), code);
		}
		const run = spawnSync(
			process.execPath,
			[
				OXLINT!,
				"-c",
				".oxlintrc.json",
				"-f",
				"json",
				...Object.keys(files)
			],
			{
				cwd: dir,
				encoding: "utf8",
				timeout: 120_000
			}
		);
		if (!run.stdout.trimStart().startsWith("{")) {
			throw new Error(`oxlint printed no report: ${run.stdout}${run.stderr}`);
		}
		const output = JSON.parse(run.stdout) as {
			diagnostics: {
				message: string;
				code: string;
				filename: string;
				labels: {
					span: {
						line: number;
					};
				}[];
			}[];
		};
		for (const name of Object.keys(files)) {
			reports.set(name, {
				reason: [],
				site: [],
				messages: []
			});
		}
		for (const diagnostic of output.diagnostics) {
			const entry = reports.get(diagnostic.filename.replace(/^.*[\\/]/, ""));
			const line = diagnostic.labels[0]?.span.line ?? 0;
			if (!entry || !diagnostic.code.endsWith("(no-main-state-in-lifecycle)")) {
				continue;
			}
			entry.messages.push(diagnostic.message);
			(diagnostic.message.startsWith("This turns") ? entry.reason : entry.site).push(line);
		}
	}

	beforeAll(async () => {
		if (unavailable) {
			return;
		}
		mkdirSync(join(PACKAGE, "node_modules"), {
			recursive: true
		});
		await build({
			entryPoints: [
				join(PACKAGE, "src", "index.ts")
			],
			bundle: true,
			platform: "node",
			format: "esm",
			packages: "external",
			external: [
				"typescript"
			],
			outfile: BUNDLE,
			logLevel: "silent"
		});
		const pluginPath = BUNDLE.replace(/\\/g, "/");
		lintWithOxlint(
			Object.fromEntries(
				FORMS.map((form, index) => [
					`form${index}.tsx`,
					form.code
				])
			),
			pluginPath,
			RULE
		);
		lintWithOxlint(
			{
				"alias.tsx": `${HEAD}\t// eslint-disable-next-line other/no-main-state-in-lifecycle\n${SITE}${TAIL}`
			},
			{
				name: "other",
				specifier: pluginPath
			},
			"other/no-main-state-in-lifecycle"
		);
	}, 180_000);

	afterAll(() => {
		rmSync(dir, {
			recursive: true,
			force: true
		});
		rmSync(BUNDLE, {
			force: true
		});
	});

	FORMS.forEach((form, index) => {
		it(`reports ${form.name} where no directive covers the report`, (context) => {
			requireOxlint(unavailable, (note) => context.skip(note));
			const { reason, site } = reports.get(`form${index}.tsx`)!;
			expect({
				reason,
				site
			}).toEqual(form.oxlint);
		});
	});

	it("names the rule as it is registered", (context) => {
		requireOxlint(unavailable, (note) => context.skip(note));
		const { reason, messages } = reports.get("alias.tsx")!;
		expect(reason).toEqual([
			5
		]);
		expect(messages[0]).toContain("This turns other/no-main-state-in-lifecycle off");
	});
});
