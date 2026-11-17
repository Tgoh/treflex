#!/usr/bin/env node
// npm run test:pack [-- --keep]
// npm run release:pack

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts/test-pack");
const KEEP = process.argv.includes("--keep");
const RELEASE = process.argv.includes("--release") ? join(ROOT, "release") : undefined;
// A published solid-js outside the ^1.9.7 that treflex and treflex-solid require.
const MISMATCHED_SOLID = "1.8.23";
// vite-plugin-solid 2.11.15 and later dedupe solid-js in builds, which bundles one copy from two on disk.
const UNDEDUPED_VITE_PLUGIN_SOLID = "2.11.14";
// The newest JSX compiler of the 1.8 line, so a later compiler can't break the build against solid-js 1.8.
const MISMATCHED_SOLID_COMPILER = "1.8.22";
// The start of the error TreflexProvider throws, in packages/solid/src/Context/TreflexContext.tsx.
const TWO_SOLIDS = "[treflex] Two copies of solid-js are loaded";
const SHIPS = {
	core: [
		"dist/",
		"biome/"
	],
	"create-treflex": [
		"index.js",
		"templates/"
	]
};
// The binding each template of packages/create-treflex/index.js writes.
const TEMPLATES = {
	react: "treflex-react",
	solid: "treflex-solid"
};
const PLANTED = "export function* planted() {\n\tyield Promise.resolve();\n\treturn Math.random();\n}\n";
// The start of each message in packages/core/biome/require-yield-star.grit and no-nondeterminism.grit.
const PLUGIN_MESSAGES = [
	"Bare `yield` of a call",
	"Non-determinism is confined"
];
// Drops the effect each template declares in src/counter/effects.ts.
const PLANTED_DROP =
	'import type { IActionGenerator } from "treflex";\nimport { delay } from "./counter/effects";\n\nexport function* plantedDrop(): IActionGenerator {\n\tdelay({ Ms: 1 });\n}\n';
// A feature whose actions module imports treflex for types only, as treflex-eslint name meets one.
const PLANTED_TODO_ACTIONS = `import type { IActionGenerator, IEntity } from "treflex";
import { delay } from "../counter/effects";

export interface ITodo extends IEntity {
	Items: string[];
}

export function* addItem(draft: ITodo, text: string): IActionGenerator {
	yield* delay({ Ms: 1 });
	draft.Items.push(text);
}

export function* clearItems(draft: ITodo): IActionGenerator {
	draft.Items = [];
}
`;
const plantedTodo = (binding) => `import { createEntityFeature } from "${binding}";
import { addItem, clearItems, type ITodo } from "./actions";

export const Todo = createEntityFeature<ITodo>("Todo")({
	addItem,
	clearItems,
});
`;
const PLANTED_TODO_MARKS = [
	'named(addItem, "Todo/AddItem");',
	'named(clearItems, "Todo/ClearItems");'
];
const DISCARD_RULE = "treflex/no-discarded-generator";
const PLANTED_REPORT_TITLE = "planted: a failure nothing awaits";
const PLANTED_REPORT = `import { createTestRuntime, type IActionGenerator, settled } from "treflex";
import { it } from "vitest";

function* fails(): IActionGenerator {
	throw new Error("planted");
}

it("${PLANTED_REPORT_TITLE}", async () => {
	const runtime = createTestRuntime({ $Id: "Planted" });
	void runtime.dispatch(fails, "Planted");
	await settled();
});
`;
const PLANTED_REPORT_MESSAGE = '[treflex] createTestRuntime: action "fails" on "Planted" failed.';
// The workspace has no typescript-eslint, only its parser, which moves in step with it.
const TEMPLATE_PINS = {
	typescript: "typescript6",
	"typescript-eslint": "@typescript-eslint/parser"
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const rootManifest = readJson(join(ROOT, "package.json"));
const reactManifest = readJson(join(ROOT, "packages/react/package.json"));
const reactDemoManifest = readJson(join(ROOT, "demos/react-todo/package.json"));
const eslintManifest = readJson(join(ROOT, "packages/eslint/package.json"));
const react18Pins = readJson(join(ROOT, "scripts/react18/package.json")).dependencies;

// docs/requirements.md's TypeScript section names this floor.
const TYPESCRIPT_FLOOR = "5.4.5";

const COMPILERS = [
	{
		alias: "typescript",
		range: eslintManifest.devDependencies.typescript,
		flags: []
	},
	{
		alias: "typescript7",
		range: rootManifest.devDependencies.typescript,
		flags: []
	},
	{
		alias: "typescript5.4",
		range: TYPESCRIPT_FLOOR,
		flags: [
			"--moduleResolution",
			"bundler"
		],
		// solid-js's own types name ContentVisibilityAutoStateChangeEvent, which TypeScript 5.4's DOM lib lacks.
		skipLibCheck: [
			"solid"
		]
	}
];

const versionOf = (name) => {
	for (const manifest of [
		rootManifest,
		reactManifest,
		reactDemoManifest,
		eslintManifest
	]) {
		const version = manifest.devDependencies?.[name] ?? manifest.dependencies?.[name];
		if (version) {
			return version;
		}
	}
	throw new Error(`test:pack: no workspace manifest pins ${name}`);
};

class StepFailed extends Error {}

function run(label, command, args, options = {}) {
	console.log(`\n> ${label}`);
	const npm = command === "npm";
	const npmCli = process.env.npm_execpath;
	const [file, argv] =
		npm && npmCli
			? [
					process.execPath,
					[
						npmCli,
						...args
					]
				]
			: [
					command,
					args
				];
	const env = {
		...process.env,
		...options.env
	};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete env[key];
		}
	}
	const spawnOptions = {
		cwd: options.cwd ?? ROOT,
		env,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024
	};
	// Outside `npm run`, Windows reaches npm only through its .cmd shim, which needs a shell.
	const result =
		npm && !npmCli && process.platform === "win32"
			? spawnSync(
					[
						file,
						...argv.map((arg) => (/[\s"]/.test(arg) ? `"${arg}"` : arg))
					].join(" "),
					{
						...spawnOptions,
						shell: true
					}
				)
			: spawnSync(file, argv, spawnOptions);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.error || (result.status !== 0 && !options.allowFailure)) {
		console.error(output || result.error?.message);
		throw new StepFailed(`${label} exited ${result.status}`);
	}
	if (options.echo !== false && output) {
		console.log(output);
	}
	return result;
}

const node = (label, script, args, options) =>
	run(
		label,
		process.execPath,
		[
			script,
			...args
		],
		options
	);

function checkLockstep() {
	const manifests = readdirSync(join(ROOT, "packages"))
		.map((dir) => join(ROOT, "packages", dir, "package.json"))
		.filter((path) => existsSync(path))
		.map(readJson);
	const { version } = manifests.find((manifest) => manifest.name === "treflex");
	for (const { name, version: own, peerDependencies } of manifests) {
		if (own !== version) {
			throw new StepFailed(`${name} is at ${own} and treflex at ${version}: every package moves in lockstep`);
		}
		if (peerDependencies?.treflex !== undefined && peerDependencies.treflex !== version) {
			throw new StepFailed(`${name} peers on treflex ${peerDependencies.treflex}, not ${version}`);
		}
	}
	console.log(`every package is at ${version}`);
	return version;
}

// Untracked files count, because the export's gates run on a fresh `git init` with nothing staged.
function checkTemplateFiles(filename, paths) {
	const prefix = "packages/create-treflex/";
	const listed = run(
		"git ls-files packages/create-treflex/templates",
		"git",
		[
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			`${prefix}templates`
		],
		{
			echo: false
		}
	)
		.stdout.split(/\r?\n/)
		.filter(Boolean)
		.map((path) => path.slice(prefix.length));
	const shipped = paths.filter((path) => path.startsWith("templates/"));
	const missing = listed.filter((path) => !shipped.includes(path));
	const extra = shipped.filter((path) => !listed.includes(path));
	if (missing.length > 0 || extra.length > 0) {
		throw new StepFailed(
			`${filename}'s templates differ from git's: ${[
				...missing.map((path) => `missing ${path}`),
				...extra.map((path) => `extra ${path}`)
			].join(", ")}`
		);
	}
	for (const template of Object.keys(TEMPLATES)) {
		for (const dotfile of [
			"_gitignore",
			"_gitattributes"
		]) {
			if (!shipped.includes(`templates/${template}/${dotfile}`)) {
				throw new StepFailed(`${filename} is missing templates/${template}/${dotfile}`);
			}
		}
	}
}

function pack(scratch) {
	const tarballs = join(scratch, "tarballs");
	mkdirSync(tarballs);
	const packed = {};
	for (const dir of readdirSync(join(ROOT, "packages"))) {
		const manifest = join(ROOT, "packages", dir, "package.json");
		if (!existsSync(manifest)) {
			continue;
		}
		const { name } = readJson(manifest);
		const readme = join(ROOT, "packages", dir, "README.md");
		const tracked = readFileSync(readme, "utf8");
		const result = run(
			`npm pack ${name}`,
			"npm",
			[
				"pack",
				"--json",
				"--pack-destination",
				tarballs
			],
			{
				cwd: join(ROOT, "packages", dir),
				echo: false
			}
		);
		if (readFileSync(readme, "utf8") !== tracked) {
			throw new StepFailed(`npm pack ${name} left packages/${dir}/README.md swapped`);
		}
		// The prepack and postpack scripts print to stdout ahead of npm's JSON.
		const [{ filename, files }] = JSON.parse(result.stdout.slice(result.stdout.indexOf("[\n")));
		const paths = files.map((f) => f.path);
		for (const required of [
			"LICENSE",
			"README.md",
			"package.json"
		]) {
			if (!paths.includes(required)) {
				throw new StepFailed(`${filename} is missing ${required}`);
			}
		}
		const allowed = [
			"LICENSE",
			"README.md",
			"package.json",
			...(SHIPS[dir] ?? [
				"dist/"
			])
		];
		const stray = [
			...new Set(paths.map((p) => (p.includes("/") ? `${p.split("/")[0]}/` : p)))
		].filter((entry) => !allowed.includes(entry));
		if (stray.length > 0) {
			throw new StepFailed(`${filename} ships ${stray.join(", ")}`);
		}
		const { bin } = JSON.parse(tarEntry(join(tarballs, filename), "package/package.json"));
		for (const target of typeof bin === "string"
			? [
					bin
				]
			: Object.values(bin ?? {})) {
			if (!paths.includes(target.replace(/^\.\//, ""))) {
				throw new StepFailed(`${filename}'s bin names ${target}, which it doesn't ship`);
			}
		}
		if (name === "create-treflex") {
			checkTemplateFiles(filename, paths);
		}
		checkPackedReadme(join(tarballs, filename));
		console.log(`${filename}: ${files.length} files`);
		packed[name] = `file:../tarballs/${filename}`;
	}
	return packed;
}

function keepTarballs(scratch) {
	mkdirSync(RELEASE);
	for (const file of readdirSync(join(scratch, "tarballs"))) {
		copyFileSync(join(scratch, "tarballs", file), join(RELEASE, file));
		console.log(`release/${file}`);
	}
}

function scaffold(scratch, name, { packed, tarballs, workspace, pinned = {}, compilers = false, fixtures }) {
	const dir = join(scratch, name);
	mkdirSync(dir);
	for (const entry of [
		"run-built.mjs",
		"shared",
		...fixtures
	]) {
		cpSync(join(FIXTURE, entry), join(dir, entry), {
			recursive: true
		});
	}
	const dependencies = {
		...pinned
	};
	for (const tarball of tarballs) {
		dependencies[tarball] = packed[tarball];
	}
	for (const dep of workspace) {
		dependencies[dep] = dep === "typescript-eslint" ? versionOf("@typescript-eslint/parser") : versionOf(dep);
	}
	if (compilers) {
		for (const { alias, range } of COMPILERS) {
			dependencies[alias] = alias === "typescript" ? range : `npm:typescript@${range}`;
		}
	}
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: `treflex-pack-${name}`,
				private: true,
				type: "module",
				dependencies
			},
			null,
			"\t"
		)}\n`
	);
	return dir;
}

const npmInstall = (dir, label, flags = [], options = {}) =>
	run(
		`${label}: npm install ${flags.join(" ")}`.trimEnd(),
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			...flags
		],
		{
			cwd: dir,
			...options
		}
	);

function solidCopies(dir) {
	const found = [];
	const visit = (pkg) => {
		if (pkg.endsWith(`${sep}solid-js`) && existsSync(join(pkg, "package.json"))) {
			found.push(pkg);
		}
		walk(join(pkg, "node_modules"));
	};
	const walk = (modules) => {
		if (!existsSync(modules)) {
			return;
		}
		for (const entry of readdirSync(modules, {
			withFileTypes: true
		})) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) {
				continue;
			}
			if (entry.name.startsWith("@")) {
				for (const scoped of readdirSync(join(modules, entry.name))) {
					visit(join(modules, entry.name, scoped));
				}
			} else {
				visit(join(modules, entry.name));
			}
		}
	};
	walk(join(dir, "node_modules"));
	return found;
}

const resolveSolidFrom = (manifest) => realpathSync(createRequire(manifest).resolve("solid-js/package.json"));

function tarEntry(tarball, wanted) {
	const tar = gunzipSync(readFileSync(tarball));
	const field = (block, start, length) =>
		block
			.subarray(start, start + length)
			.toString("utf8")
			.replace(/\0.*$/s, "");
	for (let at = 0; at + 512 <= tar.length; ) {
		const header = tar.subarray(at, at + 512);
		const name = field(header, 0, 100);
		if (!name) {
			break;
		}
		const prefix = field(header, 345, 155);
		const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
		if ((prefix ? `${prefix}/${name}` : name) === wanted) {
			return tar.subarray(at + 512, at + 512 + size).toString("utf8");
		}
		at += 512 + Math.ceil(size / 512) * 512;
	}
	throw new StepFailed(`${tarball} holds no ${wanted}`);
}

function checkPackedReadme(tarball) {
	const relative = [
		...tarEntry(tarball, "package/README.md").matchAll(/\]\((\.{1,2}\/[^)\s]*)\)/g)
	].map((m) => m[1]);
	if (relative.length > 0) {
		throw new StepFailed(`${tarball}'s package/README.md has relative links: ${relative.join(", ")}`);
	}
}

function buildAndRun(appDir, name, label = name) {
	const dir = join(appDir, name);
	node(
		`${label}: vite build`,
		join(appDir, "node_modules/vite/bin/vite.js"),
		[
			"build",
			"--logLevel",
			"warn"
		],
		{
			cwd: dir
		}
	);
	const { stdout } = node(`${label}: run the build`, join(appDir, "run-built.mjs"), [
		dir
	]);
	return JSON.parse(stdout.trim().split(/\r?\n/).pop());
}

const tsc = (appDir, alias) => join(appDir, "node_modules", alias, "bin/tsc");

function compilerVersions(appDir, label) {
	const versions = new Map();
	for (const { alias, range } of COMPILERS) {
		const reported = node(`${label}: ${alias}: tsc -v`, tsc(appDir, alias), [
			"-v"
		]).stdout.trim();
		const expected = `Version ${/^\d/.test(range) ? range : `${/\d+/.exec(range)[0]}.`}`;
		if (!reported.startsWith(expected)) {
			throw new StepFailed(`${label}: ${alias}'s tsc reports "${reported}", expected ${expected}`);
		}
		versions.set(alias, reported.slice("Version ".length));
	}
	return versions;
}

function typecheck(appDir, name, versions, label) {
	for (const { alias, flags, skipLibCheck = [] } of COMPILERS) {
		const libCheck = skipLibCheck.includes(name)
			? [
					"--skipLibCheck"
				]
			: [];
		for (const [config, args] of [
			[
				name,
				[
					...flags,
					...libCheck
				]
			],
			[
				`${name}/tsconfig.nodenext.json`,
				libCheck
			]
		]) {
			node(`${label}: tsc ${versions.get(alias)} -p ${config} ${args.join(" ")}`.trimEnd(), tsc(appDir, alias), [
				"-p",
				join(appDir, config),
				...args
			]);
		}
	}
}

function app(appDir, name, versions, label = name) {
	typecheck(appDir, name, versions, label);
	const result = buildAndRun(appDir, name, label);
	if (!result.ok) {
		throw new StepFailed(`${label}: ${result.error}`);
	}
	if (result.dev !== false) {
		throw new StepFailed(`${label}: DEV reads ${result.dev} in a production build`);
	}
	return result;
}

function checkReact(label, result, expected) {
	if (result.react !== expected) {
		throw new StepFailed(`${label}: the bundle ran react ${result.react}, expected ${expected}`);
	}
	console.log(`${label}: ran react ${result.react}`);
}

function coreInNode(appDir) {
	const dir = join(appDir, "core");
	for (const [nodeEnv, expected] of [
		[
			undefined,
			true
		],
		[
			"production",
			false
		]
	]) {
		const { dev } = JSON.parse(
			node(`core: plain Node, NODE_ENV=${nodeEnv ?? "(unset)"}`, join(dir, "node-check.mjs"), [], {
				cwd: dir,
				env: {
					NODE_ENV: nodeEnv
				}
			}).stdout
		);
		if (dev !== expected) {
			throw new StepFailed(`core: DEV reads ${dev} in Node with NODE_ENV=${nodeEnv ?? "(unset)"}`);
		}
	}
}

function eslint(appDir) {
	const dir = join(appDir, "eslint");
	const result = node(
		"eslint: lint src with the recommended config",
		join(appDir, "node_modules/eslint/bin/eslint.js"),
		[
			"--format",
			"json",
			"src"
		],
		{
			cwd: dir,
			allowFailure: true,
			echo: false
		}
	);
	if (result.status !== 0 && result.status !== 1) {
		console.error(result.stderr);
		throw new StepFailed(`eslint exited ${result.status}`);
	}
	const reported = JSON.parse(result.stdout)
		.flatMap((file) => file.messages.map((m) => m.ruleId ?? m.message))
		.sort();
	const expected = [
		"treflex/no-discarded-generator",
		"treflex/no-edit-after-write",
		"treflex/no-yield-in-finally"
	];
	console.log(reported.join("\n"));
	if (JSON.stringify(reported) !== JSON.stringify(expected)) {
		throw new StepFailed(`eslint reported ${JSON.stringify(reported)}, expected ${JSON.stringify(expected)}`);
	}
}

function noSolidApp(scratch, packed) {
	const dir = scaffold(scratch, "no-solid", {
		packed,
		tarballs: [
			"treflex",
			"treflex-react"
		],
		workspace: [
			"@types/react",
			"@types/react-dom",
			"@vitejs/plugin-react",
			"jsdom",
			"react",
			"react-dom",
			"vite"
		],
		compilers: true,
		fixtures: [
			"core",
			"react"
		]
	});
	npmInstall(dir, "no-solid");
	const versions = compilerVersions(dir, "no-solid");
	const nodes = JSON.parse(
		run(
			"no-solid: npm explain solid-js",
			"npm",
			[
				"explain",
				"solid-js",
				"--json"
			],
			{
				cwd: dir,
				echo: false
			}
		).stdout
	);
	const dependents = nodes.flatMap((n) => n.dependents.map((d) => `${d.from?.name ?? "the app"} (${d.type})`));
	console.log(`solid-js ${nodes.map((n) => n.version).join(", ")}, required by ${dependents.join(", ")}`);
	if (nodes.length === 0 || dependents.some((d) => d !== "treflex (prod)")) {
		throw new StepFailed("no-solid: solid-js should reach the app only through treflex's dependency");
	}
	app(dir, "core", versions);
	checkReact("react", app(dir, "react", versions), versionOf("react"));
	coreInNode(dir);
}

function react18App(scratch, packed) {
	const dir = scaffold(scratch, "react18", {
		packed,
		tarballs: [
			"treflex",
			"treflex-react"
		],
		workspace: [
			"@vitejs/plugin-react",
			"jsdom",
			"vite"
		],
		pinned: Object.fromEntries(
			[
				"@types/react",
				"@types/react-dom",
				"react",
				"react-dom"
			].map((name) => [
				name,
				react18Pins[name]
			])
		),
		compilers: true,
		fixtures: [
			"react"
		]
	});
	npmInstall(dir, "react18", [
		"--legacy-peer-deps=false",
		"--force=false"
	]);
	const versions = compilerVersions(dir, "react18");
	checkReact("react18/react", app(dir, "react", versions, "react18/react"), react18Pins.react);
}

function solidApp(scratch, packed) {
	const dir = scaffold(scratch, "solid", {
		packed,
		tarballs: [
			"treflex",
			"treflex-solid",
			"treflex-eslint"
		],
		workspace: [
			"eslint",
			"jsdom",
			"solid-js",
			"typescript-eslint",
			"vite",
			"vite-plugin-solid"
		],
		compilers: true,
		fixtures: [
			"solid",
			"eslint"
		]
	});
	npmInstall(dir, "solid");
	const versions = compilerVersions(dir, "solid");
	const copies = solidCopies(dir);
	if (copies.length !== 1) {
		throw new StepFailed(`solid: ${copies.length} copies of solid-js on disk: ${copies.join(", ")}`);
	}
	const fromTreflex = resolveSolidFrom(join(dir, "node_modules/treflex/package.json"));
	const fromApp = resolveSolidFrom(join(dir, "package.json"));
	if (fromTreflex !== fromApp) {
		throw new StepFailed(`solid: treflex resolves solid-js to ${fromTreflex}, the app to ${fromApp}`);
	}
	console.log(`one solid-js on disk, resolved from treflex and the app alike: ${fromApp}`);
	const result = app(dir, "solid", versions);
	if (result.oneSolid !== true) {
		throw new StepFailed(`solid: the bundle's solid-js is not treflex's (oneSolid reads ${result.oneSolid})`);
	}
	eslint(dir);
}

function mismatchApp(scratch, packed) {
	const dir = scaffold(scratch, "mismatch", {
		packed,
		tarballs: [
			"treflex",
			"treflex-solid"
		],
		workspace: [
			"jsdom",
			"vite"
		],
		pinned: {
			"solid-js": MISMATCHED_SOLID,
			"babel-preset-solid": MISMATCHED_SOLID_COMPILER,
			"vite-plugin-solid": UNDEDUPED_VITE_PLUGIN_SOLID
		},
		fixtures: [
			"solid"
		]
	});
	const refused = npmInstall(
		dir,
		"mismatch",
		[
			"--legacy-peer-deps=false",
			"--force=false"
		],
		{
			allowFailure: true,
			echo: false
		}
	);
	const refusal = `${refused.stdout}${refused.stderr}`.trim();
	console.log(refusal);
	if (refused.status === 0 || !refusal.includes("ERESOLVE") || !refusal.includes("solid-js")) {
		throw new StepFailed(`mismatch: npm install exited ${refused.status} without an ERESOLVE over solid-js`);
	}
	npmInstall(dir, "mismatch", [
		"--legacy-peer-deps"
	]);
	const copies = solidCopies(dir);
	console.log(copies.join("\n"));
	if (copies.length !== 2) {
		throw new StepFailed(`mismatch: expected two copies of solid-js on disk, found ${copies.length}`);
	}
	const result = buildAndRun(dir, "solid", "mismatch/solid");
	if (result.ok) {
		throw new StepFailed("mismatch: the Solid fixture ran on two copies of solid-js without the two-copies error");
	}
	if (!String(result.error).includes(TWO_SOLIDS)) {
		throw new StepFailed(`mismatch: the Solid fixture failed with something other than the two-copies error: ${result.error}`);
	}
	console.log(String(result.error).split("\n")[0]);
}

const range = (spec) => spec.replace(/^npm:(@[^/]+\/)?[^@]+@/, "").replace(/^[\^~=]+/, "");

function templateApp(scratch, packed, version, template) {
	const label = `${template} template`;
	const name = `${template}-app`;
	const dir = join(scratch, name);
	const binding = TEMPLATES[template];
	// A `file:` spec: npm exec runs a bare absolute path as the command itself, and resolves a
	// relative one against its local prefix, an ancestor holding package.json, not the cwd.
	const tarball = `file:${join(scratch, "tarballs", packed["create-treflex"].slice("file:../tarballs/".length)).split(sep).join("/")}`;
	run(
		`${label}: npm exec <the create-treflex tarball>`,
		"npm",
		[
			"exec",
			"--yes",
			"--",
			tarball,
			name,
			"--template",
			template
		],
		{
			cwd: scratch
		}
	);
	for (const dotfile of [
		"gitignore",
		"gitattributes"
	]) {
		if (!existsSync(join(dir, `.${dotfile}`)) || existsSync(join(dir, `_${dotfile}`))) {
			throw new StepFailed(`${label}: the scaffold has no .${dotfile}, or kept _${dotfile}`);
		}
	}
	const manifestPath = join(dir, "package.json");
	const manifest = readJson(manifestPath);
	const expected = {
		name,
		treflex: `^${version}`,
		[binding]: `^${version}`,
		"treflex-eslint": `^${version}`
	};
	const written = {
		name: manifest.name,
		treflex: manifest.dependencies.treflex,
		[binding]: manifest.dependencies[binding],
		"treflex-eslint": manifest.devDependencies["treflex-eslint"]
	};
	if (JSON.stringify(written) !== JSON.stringify(expected)) {
		throw new StepFailed(`${label}: the scaffold wrote ${JSON.stringify(written)}, expected ${JSON.stringify(expected)}`);
	}
	for (const [dep, spec] of Object.entries({
		...manifest.dependencies,
		...manifest.devDependencies
	})) {
		if (Object.hasOwn(expected, dep)) {
			continue;
		}
		const pinned = versionOf(TEMPLATE_PINS[dep] ?? dep);
		if (range(spec) !== range(pinned)) {
			throw new StepFailed(`${label}: names ${dep} ${spec}, where the workspace has ${pinned}`);
		}
	}
	manifest.dependencies.treflex = packed.treflex;
	manifest.dependencies[binding] = packed[binding];
	manifest.devDependencies["treflex-eslint"] = packed["treflex-eslint"];
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	npmInstall(dir, label);
	const npmRun = (script) =>
		run(
			`${label}: npm run ${script}`,
			"npm",
			[
				"run",
				script
			],
			{
				cwd: dir
			}
		);
	const biome = join(dir, "node_modules/@biomejs/biome/bin/biome");
	const eslintBin = join(dir, "node_modules/eslint/bin/eslint.js");
	node(
		`${label}: biome check --error-on-warnings`,
		biome,
		[
			"check",
			"--error-on-warnings"
		],
		{
			cwd: dir
		}
	);
	node(
		`${label}: eslint --max-warnings 0`,
		eslintBin,
		[
			"--max-warnings",
			"0",
			"."
		],
		{
			cwd: dir
		}
	);
	run(
		`${label}: treflex-eslint name --check`,
		"npm",
		[
			"exec",
			"--",
			"treflex-eslint",
			"name",
			"--check"
		],
		{
			cwd: dir
		}
	);
	const todo = join(dir, "src/todo");
	mkdirSync(todo);
	writeFileSync(join(todo, "actions.ts"), PLANTED_TODO_ACTIONS);
	writeFileSync(join(todo, "todo.ts"), plantedTodo(binding));
	run(
		`${label}: treflex-eslint name on a planted feature`,
		"npm",
		[
			"exec",
			"--",
			"treflex-eslint",
			"name"
		],
		{
			cwd: dir
		}
	);
	const marked = readFileSync(join(todo, "actions.ts"), "utf8");
	const unmarked = PLANTED_TODO_MARKS.filter((mark) => !marked.includes(mark));
	if (unmarked.length > 0) {
		throw new StepFailed(`${label}: treflex-eslint name didn't write ${unmarked.join(" and ")}`);
	}
	npmRun("check");
	rmSync(todo, {
		recursive: true
	});
	const planted = join(dir, "src/planted.ts");
	writeFileSync(planted, PLANTED);
	const lint = node(
		`${label}: biome lint on a file breaking both plugins`,
		biome,
		[
			"lint",
			"src/planted.ts"
		],
		{
			cwd: dir,
			allowFailure: true,
			echo: false
		}
	);
	rmSync(planted);
	const reported = `${lint.stdout}${lint.stderr}`;
	const missing = PLUGIN_MESSAGES.filter((message) => !reported.includes(message));
	if (lint.status === 0 || missing.length > 0) {
		console.error(reported);
		throw new StepFailed(`${label}: biome lint exited ${lint.status} without reporting ${missing.join(" and ") || "an error"}`);
	}
	console.log(`both plugins reported: ${PLUGIN_MESSAGES.join(", ")}`);
	const plantedDrop = join(dir, "src/plantedDrop.ts");
	writeFileSync(plantedDrop, PLANTED_DROP);
	const dropped = node(
		`${label}: eslint on a file dropping the app's own effect`,
		eslintBin,
		[
			"src/plantedDrop.ts"
		],
		{
			cwd: dir,
			allowFailure: true,
			echo: false
		}
	);
	rmSync(plantedDrop);
	const droppedReport = `${dropped.stdout}${dropped.stderr}`;
	if (dropped.status !== 1 || !droppedReport.includes(DISCARD_RULE)) {
		console.error(droppedReport);
		throw new StepFailed(`${label}: eslint exited ${dropped.status} without reporting ${DISCARD_RULE}`);
	}
	console.log(`eslint reported ${DISCARD_RULE}`);
	const plantedReport = join(dir, "src/plantedReport.test.ts");
	const reportJson = join(dir, "planted-report.json");
	writeFileSync(plantedReport, PLANTED_REPORT);
	const vitestRun = node(
		`${label}: vitest run with a test whose failure nothing awaits`,
		join(dir, "node_modules/vitest/vitest.mjs"),
		[
			"run",
			"--reporter=json",
			`--outputFile=${reportJson}`
		],
		{
			cwd: dir,
			allowFailure: true,
			echo: false
		}
	);
	rmSync(plantedReport);
	if (!existsSync(reportJson)) {
		console.error(`${vitestRun.stdout}${vitestRun.stderr}`);
		throw new StepFailed(`${label}: vitest run exited ${vitestRun.status} and wrote no JSON report`);
	}
	const results = readJson(reportJson).testResults.flatMap((file) => file.assertionResults);
	rmSync(reportJson);
	const wrong = results.filter((test) => (test.title === PLANTED_REPORT_TITLE) !== (test.status === "failed"));
	const plantedResult = results.find((test) => test.title === PLANTED_REPORT_TITLE);
	if (wrong.length > 0 || !plantedResult?.failureMessages.some((message) => message.includes(PLANTED_REPORT_MESSAGE))) {
		console.error(JSON.stringify(results, null, "\t"));
		throw new StepFailed(`${label}: treflex/vitest failed other tests than the planted one, or the planted one without its report`);
	}
	console.log(`treflex/vitest failed only "${PLANTED_REPORT_TITLE}"`);
	npmRun("check");
	npmRun("build");
}

if (RELEASE) {
	rmSync(RELEASE, {
		recursive: true,
		force: true
	});
}
const scratch = mkdtempSync(join(tmpdir(), "treflex-pack-"));
let failed = false;
try {
	const version = checkLockstep();
	const packed = pack(scratch);
	noSolidApp(scratch, packed);
	react18App(scratch, packed);
	solidApp(scratch, packed);
	mismatchApp(scratch, packed);
	for (const template of Object.keys(TEMPLATES)) {
		templateApp(scratch, packed, version, template);
	}
	console.log("\ntest:pack passed");
	if (RELEASE) {
		keepTarballs(scratch);
	}
} catch (error) {
	failed = true;
	console.error(`\ntest:pack failed: ${error.message}`);
	if (!(error instanceof StepFailed)) {
		console.error(error.stack);
	}
} finally {
	if (KEEP || failed) {
		console.log(`the apps are at ${scratch}`);
	} else {
		rmSync(scratch, {
			recursive: true,
			force: true
		});
	}
}
process.exit(failed ? 1 : 0);
