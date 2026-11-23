/// <reference types="node" />
import { resolve } from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const CORE = resolve(import.meta.dirname, "../..").replace(/\\/g, "/");
const OUT = `${CORE}/registry-keys-dts`;

/** The package's declarations as a build emits them, in memory, by path. */
function declarations(): Map<string, string> {
	const parsed = ts.getParsedCommandLineOfConfigFile(
		`${CORE}/tsconfig.json`,
		{
			rootDir: `${CORE}/src`,
			outDir: OUT,
			noEmit: false,
			declaration: true,
			emitDeclarationOnly: true,
			incremental: false,
			customConditions: [],
			types: []
		},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
			}
		}
	)!;
	const program = ts.createProgram({
		rootNames: parsed.fileNames.filter((file) => file.replace(/\\/g, "/").startsWith(`${CORE}/src/`)),
		options: parsed.options
	});
	const emitted = new Map<string, string>();
	program.emit(
		undefined,
		(file, text) => {
			emitted.set(file.replace(/\\/g, "/"), text);
		},
		undefined,
		true
	);
	return emitted;
}

/** The messages a consumer file gets when compiled against `emitted` alone. */
function compile(emitted: Map<string, string>, source: string): string[] {
	const consumer = `${OUT}/consumer.ts`;
	const options: ts.CompilerOptions = {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		lib: [
			"lib.es2022.d.ts",
			"lib.dom.d.ts"
		],
		types: []
	};
	const host = ts.createCompilerHost(options);
	const files = new Map(emitted).set(consumer, source);
	const fileExists = host.fileExists.bind(host);
	const readFile = host.readFile.bind(host);
	const getSourceFile = host.getSourceFile.bind(host);
	const key = (file: string) => file.replace(/\\/g, "/");
	const directoryExists = host.directoryExists?.bind(host);
	host.directoryExists = (dir) => key(dir) === OUT || key(dir).startsWith(`${OUT}/`) || directoryExists?.(dir) !== false;
	host.fileExists = (file) => files.has(key(file)) || (!key(file).startsWith(`${OUT}/`) && fileExists(file));
	host.readFile = (file) => files.get(key(file)) ?? (key(file).startsWith(`${OUT}/`) ? undefined : readFile(file));
	host.getSourceFile = (file, language, onError, fresh) => {
		const text = files.get(key(file));
		return text === undefined ? getSourceFile(file, language, onError, fresh) : ts.createSourceFile(file, text, language);
	};
	const program = ts.createProgram({
		rootNames: [
			consumer
		],
		options,
		host
	});
	return ts
		.getPreEmitDiagnostics(program)
		.filter((diagnostic) => diagnostic.file?.fileName !== undefined && key(diagnostic.file.fileName) === consumer)
		.map((diagnostic) => {
			const line = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!).line + 1;
			return `${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
		});
}

describe("resume's registry keys", () => {
	it("are not service keys to a consumer of any entry's declarations", () => {
		const emitted = declarations();
		expect(emitted.has(`${OUT}/index.d.ts`)).toBe(true);
		const messages = compile(
			emitted,
			[
				'import type { IRuntimeServiceKey } from "./index";',
				'import type {} from "./Snapshot/index";',
				'import type {} from "./internal";',
				'import type {} from "./Testing/vitest";',
				'export const listed: IRuntimeServiceKey = "runtime/inFlightActions";',
				'export const prefixes: IRuntimeServiceKey = "runtime/prefixes";',
				'export const resume: IRuntimeServiceKey = "runtime/resume";'
			].join("\n")
		);
		expect(messages.map((message) => message.split(":")[0])).toEqual([
			"6",
			"7"
		]);
	}, 120_000);
});
