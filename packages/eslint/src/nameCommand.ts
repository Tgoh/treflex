import { readFileSync } from "node:fs";
import ts from "typescript";
import { actionUses, createNamer, declarationOf, type IInsertion, type INamer, type IRefusal } from "./naming";

const USAGE = `Usage: treflex-eslint name [--check] [-p <tsconfig.json or its folder>]

Gives every action treflex/require-name finds a durable name, with named(action, "Feature/Action")
after its declaration, and prints each name it gave. --check writes nothing and exits 1 when any
action it finds is unnamed.`;

const OUTSIDE = "it is declared outside the project";

function reasonOf(refusal: IRefusal): string {
	switch (refusal.reason) {
		case "anonymous":
			return "it is an anonymous function";
		case "typed":
			return "it is a variable with a type annotation";
		case "notTopLevel":
			return "it is not declared at the top level of its module, and an action a factory makes is a new one on each call";
		case "noPrefix":
			return "its module has no feature id or folder name to prefix the name with";
		case "clash":
			return `"${refusal.name}" already names another action`;
		case "noImports":
			return "its module has no imports to add named to";
		case "foreignNamed":
			return "its module has another binding called named";
	}
}

interface IOptions {
	check: boolean;
	project: string | undefined;
}

interface IUnnameable {
	file: string;
	line: number;
	label: string;
	reason: string;
}

interface IProgram {
	program: ts.Program;
	namer: INamer;
	files: ts.SourceFile[];
}

interface IEdit {
	fileName: string;
	text: string;
	insertions: IInsertion[];
	names: {
		at: number;
		name: string;
	}[];
}

function parse(args: readonly string[]): IOptions | string {
	const [command, ...rest] = args;
	if (command !== "name") {
		return command === "-h" || command === "--help" ? "" : command === undefined ? "No command given." : `Unknown command: ${command}`;
	}
	const options: IOptions = {
		check: false,
		project: undefined
	};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === "--check") {
			options.check = true;
		} else if (arg === "-p" || arg === "--project") {
			const project = rest[++i];
			if (project === undefined) {
				return `${arg} needs a path`;
			}
			options.project = project;
		} else if (arg === "-h" || arg === "--help") {
			return "";
		} else {
			return `Unknown option: ${arg}`;
		}
	}
	return options;
}

function slashed(path: string): string {
	return path.replace(/\\/g, "/");
}

function relativeTo(sys: ts.System, dir: string, file: string): string {
	const same = (a: string, b: string) => (sys.useCaseSensitiveFileNames ? a === b : a.toLowerCase() === b.toLowerCase());
	const from = dir.split("/").filter((part) => part !== "");
	const to = file.split("/").filter((part) => part !== "");
	let shared = 0;
	while (shared < from.length && shared < to.length && same(from[shared]!, to[shared]!)) {
		shared++;
	}
	return [
		...from.slice(shared).map(() => ".."),
		...to.slice(shared)
	].join("/");
}

function lineOf(node: ts.Node): number {
	const file = node.getSourceFile();
	return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

// Of two insertions at one offset, the later lands first, as the rule's fixes do over ESLint's passes.
function inserted(text: string, insertions: readonly IInsertion[]): string {
	let result = text;
	for (const { at, text: insertion } of [
		...insertions
	].sort((a, b) => b.at - a.at)) {
		result = result.slice(0, at) + insertion + result.slice(at);
	}
	return result;
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether the file at `path` starts with a UTF-8 byte order mark, which `ts.System.readFile` drops. */
export function hasByteOrderMark(path: string): boolean {
	const bytes = readFileSync(path);
	return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/**
 * Runs `treflex-eslint name` with `args`, reading, writing and printing through `sys`, and returns the exit code.
 * `byteOrderMark` says whether a file it writes keeps a byte order mark.
 */
export function main(args: readonly string[], sys: ts.System, byteOrderMark: (path: string) => boolean = hasByteOrderMark): number {
	const print = (line: string) => sys.write(`${line}${sys.newLine}`);
	const options = parse(args);
	if (typeof options === "string") {
		if (options !== "") {
			print(options);
		}
		print(USAGE);
		return options === "" ? 0 : 2;
	}
	let configPath = slashed(sys.resolvePath(options.project ?? "."));
	if (sys.directoryExists(configPath)) {
		configPath = `${configPath.replace(/\/$/, "")}/tsconfig.json`;
	}
	if (!sys.fileExists(configPath)) {
		print(`No tsconfig at ${configPath}. Name the project with -p.`);
		return 2;
	}
	const root = configPath.slice(0, configPath.lastIndexOf("/"));

	const configs: ts.ParsedCommandLine[] = [];
	const visited = new Set<string>();
	const read = (path: string): boolean => {
		if (visited.has(path)) {
			return true;
		}
		visited.add(path);
		const diagnostics: ts.Diagnostic[] = [];
		const parsed = ts.getParsedCommandLineOfConfigFile(path, undefined, {
			...sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
		});
		diagnostics.push(...(parsed?.errors ?? []));
		if (parsed === undefined || diagnostics.length > 0) {
			for (const diagnostic of diagnostics) {
				print(ts.flattenDiagnosticMessageText(diagnostic.messageText, sys.newLine));
			}
			return false;
		}
		if (parsed.fileNames.length > 0) {
			configs.push(parsed);
		}
		return (parsed.projectReferences ?? []).every((reference) => read(slashed(ts.resolveProjectReferencePath(reference))));
	};
	if (!read(configPath)) {
		return 2;
	}

	const programs: IProgram[] = configs.map((parsed) => {
		const host = ts.createCompilerHost(parsed.options, true);
		host.readFile = (file) => sys.readFile(file);
		host.fileExists = (file) => sys.fileExists(file);
		const program = ts.createProgram({
			rootNames: parsed.fileNames,
			options: parsed.options,
			host
		});
		return {
			program,
			namer: createNamer(program.getTypeChecker()),
			files: parsed.fileNames
				.map((name) => program.getSourceFile(name))
				.filter((file): file is ts.SourceFile => file !== undefined && !file.isDeclarationFile)
				.sort((a, b) => compare(a.fileName, b.fileName))
		};
	});
	const pathKey = (fileName: string) => (sys.useCaseSensitiveFileNames ? slashed(fileName) : slashed(fileName).toLowerCase());
	// Each program's checker makes its own symbols, so an action is known across programs by its declaration.
	const keyOf = (symbol: ts.Symbol): string | undefined => {
		const declaration = declarationOf(symbol);
		return declaration === undefined ? undefined : `${pathKey(declaration.getSourceFile().fileName)}:${declaration.pos}`;
	};
	const project = new Set(programs.flatMap(({ files }) => files.map((file) => pathKey(file.fileName))));
	if (project.size === 0) {
		print(`${configPath} includes no source files. Name the project with -p.`);
		return 2;
	}

	const taken = new Set<string>();
	const namedIn = new Map<string, string>();
	const unreadable = new Map<string, string>();
	for (const { program, namer } of programs) {
		for (const file of program.getSourceFiles()) {
			if (!file.isDeclarationFile) {
				const names = namer.namesIn(file);
				for (const name of names.names) {
					taken.add(name);
				}
				for (const symbol of names.symbols) {
					const key = keyOf(symbol);
					if (key !== undefined) {
						namedIn.set(key, file.fileName);
					}
				}
				for (const { call, reason } of names.unreadable) {
					const at = `${relativeTo(sys, root, file.fileName)}:${lineOf(call)}`;
					unreadable.set(`${at}:${reason}`, `${at}: ${call.getText(file).replace(/\s+/g, " ")} can't be read: ${reason}`);
				}
			}
		}
	}
	if (unreadable.size > 0) {
		for (const line of [
			...unreadable.values()
		].sort(compare)) {
			print(line);
		}
		print("Nothing was written: a mark that can't be read leaves its name or its action unknown, so a new name could clash.");
		return 1;
	}

	const seen = new Set<string>();
	const edits = new Map<string, IEdit>();
	const unnameable = new Map<string, IUnnameable>();
	const refuse = (node: ts.Node, label: string, reason: string) => {
		const refusal = {
			file: relativeTo(sys, root, node.getSourceFile().fileName),
			line: lineOf(node),
			label,
			reason
		};
		unnameable.set(`${refusal.file}:${refusal.line}:${reason}`, refusal);
	};
	for (const { program, namer, files } of programs) {
		const checker = program.getTypeChecker();
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				for (const use of actionUses(checker, node)) {
					if (use.symbol === undefined) {
						refuse(
							use.node,
							use.label,
							use.method
								? "it is a method written inside the actions object; declare it as a top-level function to name it"
								: reasonOf({
										reason: "anonymous"
									})
						);
						continue;
					}
					const action = namer.unnamed(use.symbol);
					if (action === null) {
						continue;
					}
					const key = keyOf(action.symbol)!;
					if (seen.has(key)) {
						continue;
					}
					seen.add(key);
					if (!project.has(pathKey(action.file.fileName))) {
						refuse(use.node, action.label, OUTSIDE);
						continue;
					}
					const elsewhere = namedIn.get(key);
					if (elsewhere !== undefined) {
						refuse(
							action.declaration,
							action.label,
							`it is named in ${relativeTo(sys, root, elsewhere)}, and the mark belongs in the module that declares it`
						);
						continue;
					}
					const plan = namer.plan(action, (name) => taken.has(name));
					if (!("mark" in plan)) {
						refuse(action.declaration, action.label, reasonOf(plan));
						continue;
					}
					taken.add(plan.name);
					let edit = edits.get(pathKey(action.file.fileName));
					if (edit === undefined) {
						edit = {
							fileName: action.file.fileName,
							text: action.file.text,
							insertions:
								plan.import === null
									? []
									: [
											plan.import
										],
							names: []
						};
						edits.set(pathKey(action.file.fileName), edit);
					}
					edit.insertions.push(plan.mark);
					edit.names.push({
						at: plan.mark.at,
						name: plan.name
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		for (const file of files) {
			visit(file);
		}
	}

	const failed: {
		file: string;
		reason: string;
	}[] = [];
	const named: string[] = [];
	for (const [, edit] of [
		...edits
	].sort(([a], [b]) => compare(a, b))) {
		const fileName = edit.fileName;
		const file = relativeTo(sys, root, fileName);
		if (!options.check) {
			try {
				sys.writeFile(fileName, inserted(edit.text, edit.insertions), byteOrderMark(fileName));
			} catch (error) {
				failed.push({
					file,
					reason: error instanceof Error ? error.message : String(error)
				});
				continue;
			}
		}
		const order = edit.names.map((each, index) => ({
			...each,
			index
		}));
		for (const { name } of order.sort((a, b) => a.at - b.at || b.index - a.index)) {
			named.push(`${file}: ${name}`);
		}
	}

	for (const line of named) {
		print(line);
	}
	if (options.check && named.length > 0) {
		const flag =
			options.project === undefined ? "" : ` -p ${/[\s"']/.test(options.project) ? JSON.stringify(options.project) : options.project}`;
		print(`Run npx treflex-eslint name${flag} to name these.`);
	}
	const refusals = [
		...unnameable.values()
	].sort((a, b) => compare(a.file, b.file) || a.line - b.line);
	for (const { file, line, label, reason } of refusals) {
		print(`${file}:${line}: ${label} is not named: ${reason}`);
	}
	for (const { file, reason } of failed) {
		print(`${file}: not written: ${reason}`);
	}
	if (named.length === 0 && refusals.length === 0 && failed.length === 0) {
		print("Every action treflex/require-name finds is named.");
		return 0;
	}
	return refusals.length > 0 || failed.length > 0 || (options.check && named.length > 0) ? 1 : 0;
}
