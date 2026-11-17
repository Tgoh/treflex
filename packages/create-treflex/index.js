#!/usr/bin/env node
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

/** @type {Record<string, string>} */
const BINDINGS = {
	react: "treflex-react",
	solid: "treflex-solid"
};
const DOTFILES = [
	"_gitignore",
	"_gitattributes"
];
const DEFAULT_FOLDER = "treflex-app";
const USAGE = "Usage: npm create treflex@latest <folder> -- --template react|solid";
const HERE = fileURLToPath(new URL(".", import.meta.url));

class Refusal extends Error {
	/**
	 * @param {string} message
	 * @param {boolean} [usage]
	 */
	constructor(message, usage = false) {
		super(message);
		this.usage = usage;
	}
}

/**
 * @param {string} template
 * @returns {string}
 */
function checkTemplate(template) {
	if (!Object.hasOwn(BINDINGS, template)) {
		throw new Refusal(`Unknown template "${template}": use react or solid.`, true);
	}
	return template;
}

/**
 * @param {string[]} argv
 * @param {string | undefined} npmTemplate
 * @returns {{ folder?: string, template?: string }}
 */
function parse(argv, npmTemplate) {
	/** @type {string | undefined} */
	let template;
	/** @type {string[]} */
	const folders = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			continue;
		}
		if (arg === "--template") {
			const value = argv[++i];
			if (value === undefined) {
				throw new Refusal("--template needs react or solid.", true);
			}
			template = checkTemplate(value);
		} else if (arg.startsWith("--template=")) {
			template = checkTemplate(arg.slice("--template=".length));
		} else if (arg.startsWith("-")) {
			throw new Refusal(`Unknown option ${arg}.`, true);
		} else {
			folders.push(arg);
		}
	}
	// npm keeps a --template given before `--` as its own config: `--template=solid` arrives as
	// npm_config_template=solid, and `--template solid` as npm_config_template=true with `solid`
	// left among the plain arguments, in the order they were typed.
	if (template === undefined && npmTemplate) {
		if (npmTemplate !== "true") {
			template = checkTemplate(npmTemplate);
		} else {
			const at = [
				1,
				0
			].find((i) => folders.length <= 2 && i < folders.length && Object.hasOwn(BINDINGS, folders[i]));
			if (at !== undefined) {
				template = folders.splice(at, 1)[0];
			}
		}
	}
	if (folders.length > 1) {
		throw new Refusal(`One folder only: given ${folders.join(" and ")}.`, true);
	}
	return {
		folder: folders[0],
		template
	};
}

/**
 * @param {string} folder
 * @returns {string | undefined}
 */
function targetProblem(folder) {
	const target = resolve(folder);
	if (!existsSync(target)) {
		return undefined;
	}
	if (!statSync(target).isDirectory()) {
		return `${target} is a file.`;
	}
	if (readdirSync(target).some((entry) => entry !== ".git")) {
		return `${target} isn't empty. Choose a new folder or an empty one.`;
	}
	return undefined;
}

/** @param {string} folder */
function checkTarget(folder) {
	const problem = targetProblem(folder);
	if (problem) {
		throw new Refusal(`${problem} Nothing was written.`);
	}
}

/**
 * @param {{ folder?: string, template?: string }} given
 * @returns {Promise<{ folder: string, template: string }>}
 */
async function complete({ folder, template }) {
	if (folder !== undefined) {
		checkTarget(folder);
	}
	if (folder !== undefined && template !== undefined) {
		return {
			folder,
			template
		};
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		const missing = [
			folder === undefined ? "a folder" : "",
			template === undefined ? "a template" : ""
		]
			.filter(Boolean)
			.join(" and ");
		throw new Refusal(`Give ${missing}, or run it in a terminal to be asked.`, true);
	}
	const prompt = createInterface({
		input: process.stdin,
		output: process.stdout
	});
	// A pending question() never settles when the interface closes, at Ctrl+D say.
	const closed = new AbortController();
	const { signal } = closed;
	prompt.on("close", () => closed.abort());
	prompt.on("SIGINT", () => {
		prompt.close();
		process.exit(130);
	});
	try {
		while (folder === undefined) {
			const answer =
				(
					await prompt.question(`Folder (${DEFAULT_FOLDER}): `, {
						signal
					})
				).trim() || DEFAULT_FOLDER;
			const problem = targetProblem(answer);
			if (problem) {
				console.log(problem);
			} else {
				folder = answer;
			}
		}
		while (template === undefined) {
			const answer =
				(
					await prompt.question("React or Solid? (react): ", {
						signal
					})
				)
					.trim()
					.toLowerCase() || "react";
			if (Object.hasOwn(BINDINGS, answer)) {
				template = answer;
			} else {
				console.log("Answer react or solid.");
			}
		}
	} catch (error) {
		if (signal.aborted && error instanceof Error && error.name === "AbortError") {
			throw new Refusal("Stopped before the questions were answered. Nothing was written.");
		}
		throw error;
	} finally {
		prompt.close();
	}
	return {
		folder,
		template
	};
}

/**
 * @param {string} target
 * @returns {string}
 */
function packageName(target) {
	const name = basename(target)
		.toLowerCase()
		.replace(/[^a-z0-9._~-]+/g, "-")
		.replace(/^[._-]+/, "");
	return name || DEFAULT_FOLDER;
}

/**
 * @param {string} target
 * @param {string} template
 */
function scaffold(target, template) {
	cpSync(join(HERE, "templates", template), target, {
		recursive: true
	});
	for (const file of DOTFILES) {
		renameSync(join(target, file), join(target, `.${file.slice(1)}`));
	}
	const manifestPath = join(target, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const { version } = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
	manifest.name = packageName(target);
	for (const name of [
		"treflex",
		BINDINGS[template]
	]) {
		manifest.dependencies[name] = `^${version}`;
	}
	manifest.devDependencies["treflex-eslint"] = `^${version}`;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
}

function packageManager() {
	const agent = (process.env.npm_config_user_agent ?? "").split("/")[0];
	return [
		"pnpm",
		"yarn",
		"bun"
	].includes(agent)
		? agent
		: "npm";
}

try {
	const { folder, template } = await complete(parse(process.argv.slice(2), process.env.npm_config_template));
	const target = resolve(folder);
	scaffold(target, template);
	const pm = packageManager();
	const where = relative(process.cwd(), target);
	console.log(`\nCreated a treflex app from the ${template} template in ${target}.\n\nNext:\n`);
	if (where) {
		console.log(`  cd ${/\s/.test(where) ? `"${where}"` : where}`);
	}
	console.log(`  ${pm} install`);
	console.log(`  ${pm} run dev\n`);
} catch (error) {
	if (!(error instanceof Refusal)) {
		throw error;
	}
	console.error(error.message);
	if (error.usage) {
		console.error(USAGE);
	}
	process.exitCode = 1;
}
