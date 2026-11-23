/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..").replace(/\\/g, "/");
const DOCS = `${ROOT}/docs`;
const PRELUDES = `${ROOT}/tests/docs/preludes`;

interface IWrap {
	match: string;
	before?: string;
	after?: string;
	replace?: [
		string,
		string
	][];
}

interface IPageConfig {
	wrap?: IWrap[];
	react?: string[];
}

interface ILine {
	text: string;
	at: string;
}

const pages = [
	"quickstart.md",
	...readdirSync(`${DOCS}/guide`).map((f) => `guide/${f}`),
	"patterns.md",
	...readdirSync(`${DOCS}/reference`).map((f) => `reference/${f}`),
	...readdirSync(`${DOCS}/design`).map((f) => `design/${f}`)
]
	.filter((f) => f.endsWith(".md"))
	.map((f) => f.slice(0, -".md".length));

const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

const fences = (md: string): IterableIterator<RegExpMatchArray> => md.matchAll(/^( *)```(ts|tsx)[ \t]*\r?\n([\s\S]*?)^\1```/gm);

// One import line per name, so a diagnostic on an import names the block it came from.
function hoist(lines: ILine[], imports: Map<string, Map<string, ILine>>): ILine[] {
	const body: ILine[] = [];
	for (let i = 0; i < lines.length; i++) {
		let { text } = lines[i];
		const { at } = lines[i];
		if (!/^import\s/.test(text)) {
			body.push(lines[i]);
			continue;
		}
		while (!/from\s+"[^"]+";?\s*$/.test(text) && !/^import\s+"[^"]+";?$/.test(text)) {
			text += ` ${lines[++i].text.trim()}`;
		}
		const side = /^import\s+"([^"]+)"/.exec(text);
		const m = side ? null : /^import\s+(type\s+)?(.*?)\s+from\s+"([^"]+)";?\s*$/.exec(text);
		if (!side && !m) {
			throw new Error(`${at}: can't parse the import ${text}`);
		}
		const mod = side ? side[1] : m![3];
		const names = imports.get(mod) ?? new Map<string, ILine>();
		imports.set(mod, names);
		if (side) {
			names.set("", {
				text: `import "${mod}";`,
				at
			});
			continue;
		}
		const [, typeOnly, clause] = m!;
		const named = /\{(.*)\}/.exec(clause);
		const rest = clause.replace(/,?\s*\{.*\}/, "").trim();
		const add = (bare: string, text: string, isType: boolean): void => {
			const held = names.get(bare);
			if (!held || (!isType && held.text.includes("type "))) {
				names.set(bare, {
					text,
					at
				});
			}
		};
		if (rest) {
			add(rest, `import ${typeOnly ?? ""}${rest} from "${mod}";`, !!typeOnly);
		}
		for (const spec of (named?.[1] ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			const isType = !!typeOnly || spec.startsWith("type ");
			const bare = spec.replace(/^type\s+/, "");
			const local = bare.split(/\s+as\s+/).pop()!;
			add(local, `import { ${isType ? "type " : ""}${bare} } from "${mod}";`, isType);
		}
	}
	return body;
}

function render(prelude: ILine[], blocks: ILine[][]): ILine[] {
	const imports = new Map<string, Map<string, ILine>>();
	const bodies = [
		hoist(prelude, imports),
		...blocks.map((b) => hoist(b, imports))
	];
	return [
		...[
			...imports.values()
		].flatMap((names) => [
			...names.values()
		]),
		...bodies.flat(),
		{
			text: "export {};",
			at: ""
		}
	];
}

const TABS = [
	"React",
	"Solid"
];

/**
 * The page's tab groups, as the number of them and the tab of each fence inside one, by the offset of the fence's
 * first line.
 */
function tabGroups(
	md: string,
	page: string
): {
	count: number;
	tabOf: Map<number, string>;
} {
	const tabOf = new Map<number, string>();
	let count = 0;
	let group:
		| {
				line: number;
				labels: string[];
		  }
		| undefined;
	let label: string | undefined;
	let fence: RegExp | undefined;
	const lines = md.split("\n");
	for (let i = 0, offset = 0; i < lines.length; offset += lines[i].length + 1, i++) {
		const text = lines[i].replace(/\r$/, "");
		if (fence) {
			if (fence.test(text)) {
				fence = undefined;
			}
			continue;
		}
		const open = /^ *(`{3,})/.exec(text);
		const fail = (): Error =>
			new Error(`docs/${page}.md:${group?.line ?? i + 1}: a tab group is ${TABS.join(" then ")}, each tab a **label** line then a fence`);
		if (open) {
			fence = new RegExp(`^ *${open[1]}\`*\\s*$`);
			if (group) {
				if (!label) {
					throw fail();
				}
				group.labels.push(label);
				tabOf.set(offset, label);
				label = undefined;
			}
			continue;
		}
		if (text.trim() === "<!-- tabs -->") {
			if (group) {
				throw fail();
			}
			group = {
				line: i + 1,
				labels: []
			};
			count++;
		} else if (text.trim() === "<!-- /tabs -->") {
			if (!group || label || group.labels.join() !== TABS.join()) {
				throw fail();
			}
			group = undefined;
		} else if (group && text.trim()) {
			const bold = /^\*\*([^*]+)\*\*$/.exec(text.trim());
			if (!bold || label) {
				throw fail();
			}
			label = bold[1];
		}
	}
	if (group) {
		throw new Error(`docs/${page}.md:${group.line}: a tab group has no <!-- /tabs -->`);
	}
	return {
		count,
		tabOf
	};
}

function extract(page: string): Map<string, ILine[]> {
	const md = readFileSync(`${DOCS}/${page}.md`, "utf8");
	const configText = read(`${PRELUDES}/${page}.json`);
	const config: IPageConfig = configText ? JSON.parse(configText) : {};
	const groups = tabGroups(md, page);
	if (groups.count && config.react?.length) {
		throw new Error(
			`tests/docs/preludes/${page}.json: a page with tab groups takes its React samples from its React tabs, so it has no "react" list`
		);
	}
	const used = new Set<string>();
	const solid: ILine[][] = [];
	const react: ILine[][] = [];
	let index = 0;
	for (const m of fences(md)) {
		index++;
		const tab = groups.tabOf.get(m.index!);
		const first = md.slice(0, m.index).split("\n").length + 1;
		const indent = new RegExp(`^ {0,${m[1].length}}`);
		let lines: ILine[] = m[3]
			.replace(/\r?\n$/, "")
			.split(/\r?\n/)
			.map((text, i) => ({
				text: text.replace(indent, ""),
				at: `block ${index}${tab ? `, ${tab} tab` : ""} (docs/${page}.md:${first + i})`
			}));
		const source = lines.map((l) => l.text).join("\n");
		for (const w of config.wrap ?? []) {
			if (!source.includes(w.match)) {
				continue;
			}
			used.add(w.match);
			for (const [from, to] of w.replace ?? []) {
				const line = lines.find((l) => l.text.includes(from));
				if (!line) {
					throw new Error(`tests/docs/preludes/${page}.json: block ${index} has no ${JSON.stringify(from)} to replace`);
				}
				line.text = line.text.replace(from, to);
			}
			const at = `block ${index}${tab ? `, ${tab} tab` : ""} (docs/${page}.md:${first}, wrapped)`;
			const lift = (text: string | undefined): ILine[] =>
				text
					? text.split("\n").map((t) => ({
							text: t,
							at
						}))
					: [];
			lines = [
				...lines.filter((l) => /^import\s/.test(l.text)),
				...lift(w.before),
				...lines.filter((l) => !/^import\s/.test(l.text)),
				...lift(w.after)
			];
		}
		if (groups.count) {
			if (tab !== "React") {
				solid.push(lines);
			}
			if (tab !== "Solid") {
				react.push(lines);
			}
			continue;
		}
		const isReact = (config.react ?? []).some((r) => source.includes(r) && used.add(r));
		(isReact ? react : solid).push(lines);
	}
	for (const match of [
		...(config.wrap ?? []).map((w) => w.match),
		...(config.react ?? [])
	]) {
		if (!used.has(match)) {
			throw new Error(`tests/docs/preludes/${page}.json: no block matches ${JSON.stringify(match)}`);
		}
	}
	const preludeOf = (file: string): ILine[] => {
		const text = read(file).replace(/\r?\n$/, "");
		return text
			? text.split(/\r?\n/).map((line, i) => ({
					text: line,
					at: `${relative(ROOT, file).replace(/\\/g, "/")}:${i + 1}`
				}))
			: [];
	};
	// The page's file sits in preludes/<page>/, so a sample's `./X` import resolves to preludes/<page>/X.ts.
	const files = new Map<string, ILine[]>();
	if (solid.length) {
		files.set(`${PRELUDES}/${page}/page.tsx`, render(preludeOf(`${PRELUDES}/${page}.tsx`), solid));
	}
	if (react.length) {
		const reactPrelude = `${PRELUDES}/${page}.react.tsx`;
		const lines = render(preludeOf(groups.count && !existsSync(reactPrelude) ? `${PRELUDES}/${page}.tsx` : reactPrelude), react);
		files.set(`${PRELUDES}/${page}/page.react.tsx`, [
			{
				text: "/** @jsxImportSource react */",
				at: ""
			},
			...lines
		]);
	}
	return files;
}

const base = ts.getParsedCommandLineOfConfigFile(
	`${ROOT}/tsconfig.base.json`,
	{},
	{
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (d) => {
			throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
		}
	}
)!;
const options: ts.CompilerOptions = {
	...base.options,
	declaration: false,
	incremental: false,
	noEmit: true,
	jsx: ts.JsxEmit.Preserve,
	jsxImportSource: "@solidjs/web"
};
const host = ts.createCompilerHost(options);
const cached = new Map<string, ts.SourceFile | undefined>();
const realGetSourceFile = host.getSourceFile;
let virtual = new Map<string, string>();
host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
	const text = virtual.get(fileName);
	if (text !== undefined) {
		return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TSX);
	}
	if (!cached.has(fileName)) {
		cached.set(fileName, realGetSourceFile(fileName, languageVersion, onError, shouldCreate));
	}
	return cached.get(fileName);
};
const realFileExists = host.fileExists;
host.fileExists = (fileName) => virtual.has(fileName) || realFileExists(fileName);
const realReadFile = host.readFile;
host.readFile = (fileName) => virtual.get(fileName) ?? realReadFile(fileName);

function compile(files: Map<string, ILine[]>): string[] {
	virtual = new Map(
		[
			...files
		].map(([name, lines]) => [
			name,
			lines.map((l) => l.text).join("\n")
		])
	);
	const program = ts.createProgram(
		[
			...files.keys()
		],
		options,
		host
	);
	const problems: string[] = [];
	const report = (d: ts.Diagnostic): void => {
		const message = `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
		if (!d.file || d.start === undefined) {
			problems.push(message);
			return;
		}
		const line = d.file.getLineAndCharacterOfPosition(d.start).line;
		const at = files.get(d.file.fileName)?.[line]?.at ?? `${relative(ROOT, d.file.fileName).replace(/\\/g, "/")}:${line + 1}`;
		problems.push(`${at}: ${message}`);
	};
	program.getOptionsDiagnostics().forEach(report);
	program.getGlobalDiagnostics().forEach(report);
	for (const file of program.getSourceFiles()) {
		if (file.fileName.startsWith(`${PRELUDES}/`)) {
			program.getSyntacticDiagnostics(file).forEach(report);
			program.getSemanticDiagnostics(file).forEach(report);
		}
	}
	return problems;
}

const withSamples = pages.filter((page) => !fences(readFileSync(`${DOCS}/${page}.md`, "utf8")).next().done);

describe("docs samples", () => {
	it("has a page for every prelude", () => {
		const orphans: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(join(PRELUDES, dir), {
				withFileTypes: true
			})) {
				const name = dir ? `${dir}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					walk(name);
					continue;
				}
				const page = name.replace(/(\.react)?\.(tsx|json)$/, "").replace(/\/[^/]+\.ts$/, "");
				if (!withSamples.includes(page)) {
					orphans.push(name);
				}
			}
		};
		walk("");
		expect(withSamples).toContain("guide/01-entities");
		expect(orphans).toEqual([]);
	});

	it.each(withSamples)("docs/%s.md compiles", {
		timeout: 30_000
	}, (page) => {
		expect(compile(extract(page))).toEqual([]);
	});
});
