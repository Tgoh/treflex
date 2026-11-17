#!/usr/bin/env node
// npm run test:pack [-- --keep]
// npm run release:pack

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts/test-pack");
const KEEP = process.argv.includes("--keep");
const RELEASE = process.argv.includes("--release") ? join(ROOT, "release") : undefined;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const rootManifest = readJson(join(ROOT, "package.json"));
const reactManifest = readJson(join(ROOT, "packages/react/package.json"));
const reactDemoManifest = readJson(join(ROOT, "demos/react-todo/package.json"));

const versionOf = (name) => {
	for (const manifest of [
		rootManifest,
		reactManifest,
		reactDemoManifest
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
			"dist/",
			"LICENSE",
			"README.md",
			"package.json",
			...(dir === "core"
				? [
						"biome/"
					]
				: [])
		];
		const stray = [
			...new Set(paths.map((p) => (p.includes("/") ? `${p.split("/")[0]}/` : p)))
		].filter((entry) => !allowed.includes(entry));
		if (stray.length > 0) {
			throw new StepFailed(`${filename} ships ${stray.join(", ")}`);
		}
		checkPackedReadme(join(tarballs, filename));
		console.log(`${filename}: ${files.length} files`);
		packed[name] = `file:tarballs/${filename}`;
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

function install(scratch, packed) {
	cpSync(FIXTURE, scratch, {
		recursive: true
	});
	const dependencies = {
		...packed
	};
	for (const name of [
		"@types/react",
		"@types/react-dom",
		"@vitejs/plugin-react",
		"eslint",
		"jsdom",
		"react",
		"react-dom",
		"solid-js",
		"typescript",
		"vite",
		"vite-plugin-solid"
	]) {
		dependencies[name] = versionOf(name);
	}
	dependencies["typescript-eslint"] = versionOf("@typescript-eslint/parser");
	writeFileSync(
		join(scratch, "package.json"),
		`${JSON.stringify(
			{
				name: "treflex-pack-test",
				private: true,
				type: "module",
				dependencies
			},
			null,
			"\t"
		)}\n`
	);
	run(
		"npm install",
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error"
		],
		{
			cwd: scratch
		}
	);
}

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

function parseResult(label, stdout) {
	const line = stdout.trim().split(/\r?\n/).pop();
	const result = JSON.parse(line);
	if (!result.ok) {
		throw new StepFailed(`${label}: ${result.error}`);
	}
	return result;
}

function app(scratch, name) {
	const dir = join(scratch, name);
	const bin = (pkg, path) => join(scratch, "node_modules", pkg, path);
	node(`${name}: tsc`, bin("typescript", "bin/tsc"), [
		"-p",
		dir
	]);
	node(
		`${name}: vite build`,
		bin("vite", "bin/vite.js"),
		[
			"build",
			"--logLevel",
			"warn"
		],
		{
			cwd: dir
		}
	);
	const result = parseResult(
		name,
		node(`${name}: run the build`, join(scratch, "run-built.mjs"), [
			dir
		]).stdout
	);
	if (result.dev !== false) {
		throw new StepFailed(`${name}: DEV reads ${result.dev} in a production build`);
	}
}

function nodenext(scratch, name) {
	node(`${name}: tsc under NodeNext resolution`, join(scratch, "node_modules/typescript/bin/tsc"), [
		"-p",
		join(scratch, name, "tsconfig.nodenext.json")
	]);
}

function coreInNode(scratch) {
	const dir = join(scratch, "core");
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

function eslint(scratch) {
	const dir = join(scratch, "eslint");
	const result = node(
		"eslint: lint src with the recommended config",
		join(scratch, "node_modules/eslint/bin/eslint.js"),
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
		"treflex/no-edit-after-write",
		"treflex/no-yield-in-finally"
	];
	console.log(reported.join("\n"));
	if (JSON.stringify(reported) !== JSON.stringify(expected)) {
		throw new StepFailed(`eslint reported ${JSON.stringify(reported)}, expected ${JSON.stringify(expected)}`);
	}
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
	install(scratch, pack(scratch));
	for (const name of [
		"core",
		"solid",
		"react"
	]) {
		app(scratch, name);
		nodenext(scratch, name);
	}
	coreInNode(scratch);
	eslint(scratch);
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
		console.log(`the app is at ${scratch}`);
	} else {
		rmSync(scratch, {
			recursive: true,
			force: true
		});
	}
}
process.exit(failed ? 1 : 0);
