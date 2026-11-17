import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE = resolve(import.meta.dirname, "..");
const CLI = join(PACKAGE, "index.js");
const { version } = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));

const scratches: string[] = [];

afterEach(() => {
	for (const dir of scratches.splice(0)) {
		rmSync(dir, {
			recursive: true,
			force: true
		});
	}
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "create-treflex-"));
	scratches.push(dir);
	return dir;
}

const USAGE = "Usage: npm create treflex@latest <folder> -- --template react|solid";

function childEnv(userAgent = "", npmTemplate = ""): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) =>
					![
						"npm_config_user_agent",
						"npm_config_template"
					].includes(key.toLowerCase())
			)
		),
		npm_config_user_agent: userAgent,
		npm_config_template: npmTemplate
	};
}

function create(cwd: string, args: readonly string[], { userAgent = "", npmTemplate = "" } = {}) {
	const result = spawnSync(
		process.execPath,
		[
			CLI,
			...args
		],
		{
			cwd,
			encoding: "utf8",
			env: childEnv(userAgent, npmTemplate)
		}
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr
	};
}

function converse(
	cwd: string,
	answers: string[]
): Promise<{
	status: number | null;
	stdout: string;
	stderr: string;
}> {
	const child = spawn(
		process.execPath,
		[
			"--import",
			pathToFileURL(join(import.meta.dirname, "terminal.mjs")).href,
			CLI
		],
		{
			cwd,
			env: childEnv()
		}
	);
	let stdout = "";
	let stderr = "";
	let answered = 0;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		const asked = stdout.match(/\((?:treflex-app|react)\): /g)?.length ?? 0;
		if (asked > answered) {
			if (answered < answers.length) {
				child.stdin.write(`${answers[answered]}\n`);
			} else {
				child.stdin.end();
			}
			answered = asked;
		}
	});
	// Under vitest's 5s test timeout, so a hang fails as a null status and leaves no process.
	const hung = setTimeout(() => child.kill(), 4_000);
	return new Promise((done) =>
		child.on("close", (status) => {
			clearTimeout(hung);
			done({
				status,
				stdout,
				stderr
			});
		})
	);
}

function files(dir: string): string[] {
	return readdirSync(dir, {
		recursive: true,
		withFileTypes: true
	})
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
		.sort();
}

const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

describe("create-treflex", () => {
	for (const [template, binding, other] of [
		[
			"react",
			"treflex-react",
			"treflex-solid"
		],
		[
			"solid",
			"treflex-solid",
			"treflex-react"
		]
	]) {
		it(`writes the ${template} template with this version of treflex`, () => {
			const cwd = scratch();
			const { status, stdout } = create(cwd, [
				"My App",
				"--template",
				template
			]);
			expect(status).toBe(0);
			const app = join(cwd, "My App");
			const source = join(PACKAGE, "templates", template);
			expect(files(app)).toEqual(
				files(source)
					.map((file) => (file.startsWith("_git") ? `.${file.slice(1)}` : file))
					.sort()
			);
			for (const dotfile of [
				"gitignore",
				"gitattributes"
			]) {
				expect(readFileSync(join(app, `.${dotfile}`), "utf8")).toBe(readFileSync(join(source, `_${dotfile}`), "utf8"));
			}
			const written = manifest(app);
			expect(written.name).toBe("my-app");
			expect(written.dependencies.treflex).toBe(`^${version}`);
			expect(written.dependencies[binding]).toBe(`^${version}`);
			expect(written.dependencies[other]).toBeUndefined();
			expect(written.devDependencies["treflex-eslint"]).toBe(`^${version}`);
			expect({
				...written,
				name: undefined,
				dependencies: {
					...written.dependencies,
					treflex: undefined,
					[binding]: undefined
				},
				devDependencies: {
					...written.devDependencies,
					"treflex-eslint": undefined
				}
			}).toEqual({
				...manifest(source),
				name: undefined,
				dependencies: {
					...manifest(source).dependencies,
					treflex: undefined,
					[binding]: undefined
				},
				devDependencies: {
					...manifest(source).devDependencies,
					"treflex-eslint": undefined
				}
			});
			expect(readFileSync(join(app, "package.json"), "utf8")).toBe(`${JSON.stringify(written, null, "\t")}\n`);
			expect(existsSync(join(app, "node_modules"))).toBe(false);
			expect(stdout).toContain('cd "My App"');
			expect(stdout).toContain("npm install");
			expect(stdout).toContain("npm run dev");
		});
	}

	it("takes --template=solid", () => {
		const cwd = scratch();
		expect(
			create(cwd, [
				"app",
				"--template=solid"
			]).status
		).toBe(0);
		expect(manifest(join(cwd, "app")).dependencies["treflex-solid"]).toBe(`^${version}`);
	});

	it("skips a bare --, which pnpm passes through", () => {
		const cwd = scratch();
		expect(
			create(cwd, [
				"app",
				"--",
				"--template",
				"solid"
			]).status
		).toBe(0);
		expect(manifest(join(cwd, "app")).dependencies["treflex-solid"]).toBe(`^${version}`);
	});

	it("takes the template npm kept from --template=solid as its own config", () => {
		const cwd = scratch();
		expect(
			create(
				cwd,
				[
					"app"
				],
				{
					npmTemplate: "solid"
				}
			).status
		).toBe(0);
		expect(manifest(join(cwd, "app")).dependencies["treflex-solid"]).toBe(`^${version}`);
	});

	it("takes the template npm left as a second folder from --template solid", () => {
		const cwd = scratch();
		expect(
			create(
				cwd,
				[
					"app",
					"solid"
				],
				{
					npmTemplate: "true"
				}
			).status
		).toBe(0);
		expect(manifest(join(cwd, "app")).dependencies["treflex-solid"]).toBe(`^${version}`);
	});

	for (const [args, folder, binding] of [
		[
			[
				"solid",
				"app"
			],
			"app",
			"treflex-solid"
		],
		[
			[
				"react",
				"solid"
			],
			"react",
			"treflex-solid"
		]
	] as const) {
		it(`takes the template npm left among ${JSON.stringify(args)} from --template, in either order`, () => {
			const cwd = scratch();
			expect(
				create(cwd, args, {
					npmTemplate: "true"
				}).status
			).toBe(0);
			expect(manifest(join(cwd, folder)).dependencies[binding]).toBe(`^${version}`);
		});
	}

	it("takes a lone template npm left from --template as the template, and asks for the folder", () => {
		const cwd = scratch();
		const { status, stderr } = create(
			cwd,
			[
				"solid"
			],
			{
				npmTemplate: "true"
			}
		);
		expect(status).toBe(1);
		expect(stderr).toContain("Give a folder, or run it in a terminal to be asked.");
		expect(readdirSync(cwd)).toEqual([]);
	});

	it("stops at Ctrl+D at the folder prompt, and writes nothing", async () => {
		const cwd = scratch();
		const { status, stdout, stderr } = await converse(cwd, []);
		expect(status).toBe(1);
		expect(stdout).toContain("Folder (treflex-app): ");
		expect(stderr).toContain("Stopped before the questions were answered. Nothing was written.");
		expect(readdirSync(cwd)).toEqual([]);
	});

	it("exits 130 at Ctrl+C, and writes nothing", async () => {
		const cwd = scratch();
		const { status } = await converse(cwd, [
			"app",
			"\x03"
		]);
		expect(status).toBe(130);
		expect(readdirSync(cwd)).toEqual([]);
	});

	it("stops at Ctrl+D at the template prompt, and writes nothing", async () => {
		const cwd = scratch();
		const { status, stdout, stderr } = await converse(cwd, [
			"app"
		]);
		expect(status).toBe(1);
		expect(stdout).toContain("React or Solid? (react): ");
		expect(stderr).toContain("Stopped before the questions were answered. Nothing was written.");
		expect(readdirSync(cwd)).toEqual([]);
	});

	it("asks again for a folder that isn't empty", async () => {
		const cwd = scratch();
		mkdirSync(join(cwd, "full"));
		writeFileSync(join(cwd, "full", "notes.txt"), "mine");
		const { status, stdout } = await converse(cwd, [
			"full",
			"app",
			"solid"
		]);
		expect(status).toBe(0);
		expect(stdout).toContain("isn't empty. Choose a new folder or an empty one.\n");
		expect(stdout).not.toContain("Nothing was written");
		expect(manifest(join(cwd, "app")).dependencies["treflex-solid"]).toBe(`^${version}`);
	});

	it("prefers a --template it was given over npm's config", () => {
		const cwd = scratch();
		expect(
			create(
				cwd,
				[
					"app",
					"--template",
					"react"
				],
				{
					npmTemplate: "solid"
				}
			).status
		).toBe(0);
		expect(manifest(join(cwd, "app")).dependencies["treflex-react"]).toBe(`^${version}`);
	});

	it("refuses a non-empty folder before asking for a missing template", () => {
		const cwd = scratch();
		mkdirSync(join(cwd, "app"));
		writeFileSync(join(cwd, "app", "notes.txt"), "mine");
		const { status, stderr } = create(cwd, [
			"app"
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("isn't empty");
	});

	it("writes into the current folder, named after it, with no cd", () => {
		const cwd = join(scratch(), "counter");
		mkdirSync(cwd);
		const { status, stdout } = create(cwd, [
			".",
			"--template",
			"react"
		]);
		expect(status).toBe(0);
		expect(manifest(cwd).name).toBe("counter");
		expect(stdout).not.toContain("cd ");
	});

	it("writes into a folder that holds only .git", () => {
		const cwd = scratch();
		mkdirSync(join(cwd, "app", ".git"), {
			recursive: true
		});
		expect(
			create(cwd, [
				"app",
				"--template",
				"react"
			]).status
		).toBe(0);
		expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
	});

	it("prints the commands for the package manager that ran it", () => {
		const { stdout } = create(
			scratch(),
			[
				"app",
				"--template",
				"solid"
			],
			{
				userAgent: "pnpm/10.0.0 npm/? node/v22.0.0 win32 x64"
			}
		);
		expect(stdout).toContain("pnpm install");
		expect(stdout).toContain("pnpm run dev");
	});

	it("refuses a folder that holds anything, and writes nothing", () => {
		const cwd = scratch();
		mkdirSync(join(cwd, "app"));
		writeFileSync(join(cwd, "app", "notes.txt"), "mine");
		const { status, stderr } = create(cwd, [
			"app",
			"--template",
			"react"
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("isn't empty");
		expect(files(join(cwd, "app"))).toEqual([
			"notes.txt"
		]);
	});

	it("refuses a file at the path", () => {
		const cwd = scratch();
		writeFileSync(join(cwd, "app"), "mine");
		const { status, stderr } = create(cwd, [
			"app",
			"--template",
			"react"
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("is a file");
	});

	for (const [args, message, npmTemplate] of [
		[
			[
				"app",
				"--template",
				"vue"
			],
			'Unknown template "vue": use react or solid.'
		],
		[
			[
				"app",
				"--template",
				"toString"
			],
			'Unknown template "toString": use react or solid.'
		],
		[
			[
				"app"
			],
			'Unknown template "vue": use react or solid.',
			"vue"
		],
		[
			[
				"app",
				"other"
			],
			"One folder only: given app and other.",
			"true"
		],
		[
			[
				"app"
			],
			"Give a template, or run it in a terminal to be asked."
		],
		[
			[
				"--template",
				"react"
			],
			"Give a folder, or run it in a terminal to be asked."
		],
		[
			[],
			"Give a folder and a template, or run it in a terminal to be asked."
		],
		[
			[
				"app",
				"--template"
			],
			"--template needs react or solid."
		],
		[
			[
				"app",
				"--force",
				"--template",
				"react"
			],
			"Unknown option --force."
		],
		[
			[
				"app",
				"other",
				"--template",
				"react"
			],
			"One folder only: given app and other."
		]
	] as const) {
		it(`refuses ${JSON.stringify(args)}${npmTemplate ? ` with npm's template ${npmTemplate}` : ""} without a terminal, showing the usage, and writes nothing`, () => {
			const cwd = scratch();
			const { status, stderr } = create(cwd, args, {
				npmTemplate
			});
			expect(status).toBe(1);
			expect(stderr).toContain(message);
			expect(stderr).toContain(USAGE);
			expect(readdirSync(cwd)).toEqual([]);
		});
	}
});
