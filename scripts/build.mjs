#!/usr/bin/env node
//   node scripts/build.mjs            every package
//   node scripts/build.mjs core solid   the named package folders
//   npm pack, npm publish               the package in the current folder,
//                                       through prepack (--pack) and postpack
//                                       (--unpack) in its package.json
//
// A package is built after the workspace packages it peers on, because its
// .d.ts imports theirs from dist.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import solidPreset from "babel-preset-solid";
import ts from "typescript6";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");

const manifests = new Map(
	readdirSync(PACKAGES)
		.filter((dir) => existsSync(join(PACKAGES, dir, "package.json")))
		.map((dir) => [
			dir,
			JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8"))
		])
);
const dirOfName = new Map(
	[
		...manifests
	].map(([dir, manifest]) => [
		manifest.name,
		dir
	])
);

function workspaceDeps(dir) {
	const { dependencies = {}, peerDependencies = {} } = manifests.get(dir);
	return Object.keys({
		...dependencies,
		...peerDependencies
	})
		.filter((name) => dirOfName.has(name))
		.map((name) => dirOfName.get(name));
}

function inBuildOrder(requested) {
	const ordered = [];
	const visit = (dir) => {
		if (ordered.includes(dir)) {
			return;
		}
		if (!manifests.has(dir)) {
			throw new Error(`build: no package folder packages/${dir}`);
		}
		for (const dep of workspaceDeps(dir)) {
			visit(dep);
		}
		ordered.push(dir);
	};
	for (const dir of requested) {
		visit(dir);
	}
	return ordered;
}

function* walk(dir) {
	for (const entry of readdirSync(dir, {
		withFileTypes: true
	})) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(path);
		} else {
			yield path;
		}
	}
}

function compile(pkgDir) {
	const src = join(pkgDir, "src");
	const dist = join(pkgDir, "dist");
	const parsed = ts.getParsedCommandLineOfConfigFile(
		join(pkgDir, "tsconfig.json"),
		{
			rootDir: src,
			outDir: dist,
			noEmit: false,
			declaration: true,
			incremental: false,
			// The workspace resolves the treflex-source condition to src; a build
			// resolves sibling packages to their dist .d.ts, so their source
			// isn't pulled under this package's rootDir.
			customConditions: [],
			types: []
		},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (d) => {
				throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
			}
		}
	);
	const rootNames = parsed.fileNames.filter((file) => !relative(src, file).startsWith(".."));
	const program = ts.createProgram({
		rootNames,
		options: parsed.options
	});
	const emitted = program.emit();
	const diagnostics = [
		...ts.getPreEmitDiagnostics(program),
		...emitted.diagnostics
	];
	if (diagnostics.length > 0) {
		throw new Error(
			ts.formatDiagnosticsWithColorAndContext(diagnostics, {
				getCanonicalFileName: (f) => f,
				getCurrentDirectory: () => ROOT,
				getNewLine: () => "\n"
			})
		);
	}
}

async function compileSolidJsx(dist) {
	for (const file of walk(dist)) {
		if (!file.endsWith(".jsx")) {
			continue;
		}
		const result = await transformAsync(readFileSync(file, "utf8"), {
			filename: file,
			babelrc: false,
			configFile: false,
			presets: [
				[
					solidPreset,
					{
						generate: "dom"
					}
				]
			]
		});
		writeFileSync(file.replace(/\.jsx$/, ".js"), result.code);
		rmSync(file);
	}
}

// A `declare module` augmentation names its module by specifier too, and an
// unresolved one augments nothing.
const SPECIFIER = /((?:\bfrom|\bimport|\bdeclare\s+module)\s*\(?\s*)(["'])(\.{1,2}(?:\/[^"']*)?)\2/g;

// Node and TypeScript's node16 resolution need the extension a bundler infers.
function addExtensions(dist) {
	for (const file of walk(dist)) {
		const declaration = file.endsWith(".d.ts");
		if (!declaration && !file.endsWith(".js")) {
			continue;
		}
		const sibling = declaration ? ".d.ts" : ".js";
		const text = readFileSync(file, "utf8");
		const fixed = text.replace(SPECIFIER, (match, lead, quote, spec) => {
			const base = resolve(dirname(file), spec);
			const folder = spec === "." || spec === ".." || spec.endsWith("/");
			if (!folder && spec.endsWith(".js") && existsSync(base.replace(/\.js$/, sibling))) {
				return match;
			}
			if (!folder && existsSync(`${base}${sibling}`)) {
				return `${lead}${quote}${spec}.js${quote}`;
			}
			if (existsSync(join(base, `index${sibling}`))) {
				return `${lead}${quote}${spec.replace(/\/$/, "")}/index.js${quote}`;
			}
			throw new Error(`build: ${relative(ROOT, file)} imports "${spec}", which resolves to no ${sibling} file`);
		});
		if (fixed !== text) {
			writeFileSync(file, fixed);
		}
	}
}

function checkExports(dir, pkgDir) {
	const { exports } = manifests.get(dir);
	for (const [subpath, conditions] of Object.entries(exports)) {
		for (const condition of [
			"types",
			"import"
		]) {
			if (!existsSync(join(pkgDir, conditions[condition]))) {
				throw new Error(
					`build: ${manifests.get(dir).name} exports "${subpath}" ${condition} ${conditions[condition]}, which the build didn't write`
				);
			}
		}
	}
}

// packages/core/src/Utility/devMode.ts reads both at run time, so the
// consumer's bundler decides; a build that defines either inlines DEV.
function checkDevModeRead(pkgDir) {
	const devMode = join(pkgDir, "dist/Utility/devMode.js");
	if (!existsSync(devMode)) {
		return;
	}
	const text = readFileSync(devMode, "utf8");
	for (const read of [
		"import.meta",
		"process.env.NODE_ENV"
	]) {
		if (!text.includes(read)) {
			throw new Error(`build: ${relative(ROOT, devMode)} no longer reads ${read}`);
		}
	}
}

async function build(dir) {
	const pkgDir = join(PACKAGES, dir);
	if (manifests.get(dir).exports) {
		rmSync(join(pkgDir, "dist"), {
			recursive: true,
			force: true
		});
		compile(pkgDir);
		await compileSolidJsx(join(pkgDir, "dist"));
		addExtensions(join(pkgDir, "dist"));
		checkExports(dir, pkgDir);
		checkDevModeRead(pkgDir);
	}
	copyFileSync(join(ROOT, "LICENSE"), join(pkgDir, "LICENSE"));
	console.log(`built ${manifests.get(dir).name}`);
}

// Outside the package folder, or npm packs the saved copy too.
const savedReadme = (dir) => join(ROOT, "node_modules/.cache/treflex-readme", dir, "README.md");

function writeNpmReadme(dir) {
	const pkgDir = join(PACKAGES, dir);
	restoreReadme(dir);
	const url = manifests.get(dir).repository?.url ?? "";
	const repo = /^(?:git\+)?(https:\/\/github\.com\/[^/]+\/[^/.]+)(?:\.git)?$/.exec(url)?.[1];
	if (!repo) {
		throw new Error(`build: ${manifests.get(dir).name}'s repository.url, "${url}", names no GitHub repository`);
	}
	const readme = join(pkgDir, "README.md");
	const source = readFileSync(readme, "utf8");
	let fence = false;
	const absolute = source
		.split("\n")
		.map((line) => {
			if (/^\s*```/.test(line)) {
				fence = !fence;
			}
			if (fence) {
				return line;
			}
			return line.replace(/\]\(([^)\s]+)\)/g, (match, target) => {
				if (/^([a-z][a-z+.-]*:|#)/i.test(target)) {
					return match;
				}
				const [path, anchor] = target.split("#");
				const file = resolve(pkgDir, path);
				if (!existsSync(file)) {
					throw new Error(`build: ${relative(ROOT, readme)} links to ${target}, which doesn't exist`);
				}
				const kind = statSync(file).isDirectory() ? "tree" : "blob";
				const inRepo = relative(ROOT, file).split(sep).join("/");
				return `](${repo}/${kind}/HEAD/${inRepo}${anchor === undefined ? "" : `#${anchor}`})`;
			});
		})
		.join("\n");
	mkdirSync(dirname(savedReadme(dir)), {
		recursive: true
	});
	copyFileSync(readme, savedReadme(dir));
	writeFileSync(readme, absolute);
}

function restoreReadme(dir) {
	const saved = savedReadme(dir);
	if (existsSync(saved)) {
		copyFileSync(saved, join(PACKAGES, dir, "README.md"));
		rmSync(saved);
	}
}

function requested(args) {
	if (args.length > 0) {
		return args;
	}
	const inPackages = relative(PACKAGES, process.cwd());
	if (manifests.has(inPackages)) {
		return [
			inPackages
		];
	}
	return [
		...manifests.keys()
	];
}

try {
	const args = process.argv.slice(2);
	const dirs = requested(args.filter((arg) => !arg.startsWith("--")));
	for (const dir of dirs) {
		restoreReadme(dir);
	}
	if (!args.includes("--unpack")) {
		for (const dir of inBuildOrder(dirs)) {
			await build(dir);
		}
		if (args.includes("--pack")) {
			for (const dir of dirs) {
				writeNpmReadme(dir);
			}
		}
	}
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
