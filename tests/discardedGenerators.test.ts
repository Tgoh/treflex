import ts from "typescript6";
import { describe, expect, it } from "vitest";

// OPTIONS below is a hand-maintained mirror of packages/solid/tsconfig.json — drift between the two shows up
// as TS2307 resolution failures unrelated to generators.

const globbed = import.meta.glob([
	"../packages/core/src/**/*.ts",
	"../packages/core/src/**/*.tsx",
	"../packages/core/tests/**/*.ts",
	"../packages/core/tests/**/*.tsx",
	"../packages/solid/src/**/*.ts",
	"../packages/solid/src/**/*.tsx",
	"../packages/solid/tests/**/*.ts",
	"../packages/solid/tests/**/*.tsx",
	"../packages/react/src/**/*.ts",
	"../packages/react/src/**/*.tsx",
	"../tests/**/*.ts",
	"../tests/**/*.tsx",
	"../demos/todo/src/**/*.ts",
	"../demos/todo/src/**/*.tsx",
	"../demos/portal/src/**/*.ts",
	"../demos/portal/src/**/*.tsx",
	"../demos/checkout/src/**/*.ts",
	"../demos/checkout/src/**/*.tsx"
]);
const cwd = (
	globalThis as {
		process?: {
			cwd(): string;
		};
	}
).process
	?.cwd()
	.replace(/\\/g, "/");
if (!cwd) {
	throw new Error("no process.cwd — this structural test needs the vitest node runtime");
}
// Glob keys are importer-relative: files under tests/ key as "./…", everything else as "../…".
const realFiles = Object.keys(globbed)
	.filter((key) => !key.endsWith(".d.ts"))
	.map((key) => (key.startsWith("./") ? `${cwd}/tests/${key.slice(2)}` : `${cwd}/${key.replace(/^\.\.\//, "")}`));

const SEED_NAME = `${cwd}/tests/__discardedGeneratorSeed__.ts`;
const SEED_SOURCE = `
function* edit(): Generator<void> { yield; }
async function* aedit(): AsyncGenerator<void> { yield; }
interface IMyGen extends Generator<void> {}
declare function makeMyGen(): IMyGen;
declare function makeIter(): IterableIterator<number>;
declare function optional(): Generator<void> | undefined;
declare function makeLabelled(): Generator<void> & { label: string };
function use(x: unknown): void { void x; }
declare const cond: boolean;

export function host(): void {
	edit();                          // BAD: bare statement
	void edit();                     // BAD: void-discarded
	edit()!;                         // BAD: non-null-asserted
	(edit() as unknown);             // BAD: as-cast
	(cond && edit());                // BAD: logical right operand
	(cond ? edit() : makeMyGen());   // BAD: both conditional branches (one line)
	(use(1), edit());                // BAD: comma right operand
	optional();                      // BAD: union with undefined
	makeLabelled();                  // BAD: intersection carrying a generator
	makeIter();                      // BAD: IterableIterator annotation
	const g = edit();                // ok: assigned
	use(edit());                     // ok: argument
	void use(1);                     // ok: void of a non-generator
	void g;
}
export async function ahost(): Promise<void> {
	await aedit();                   // BAD: awaited async-generator object
}
export function* outer(): Generator<void> {
	yield* edit();                   // ok: delegation
}
export function pass(): Generator<void> {
	return edit();                   // ok: returned
}
`;

// Placed under the portal so its import resolves through the node_modules link the demo builds with. If that
// resolution drifts, the import types as `any` and the walk goes blind for every demo file, and this seed fails.
const TREFLEX_SEED_NAME = `${cwd}/demos/portal/src/__discardedGeneratorTreflexSeed__.ts`;
const TREFLEX_SEED_SOURCE = `
import { generateGuid } from "treflex";
export function host(): void {
	generateGuid();                  // BAD: discarded call of an imported generator
}
`;

// In its own file, so its class doesn't shadow the lib Generator the first seed relies on.
const USER_TYPE_SEED_NAME = `${cwd}/tests/__discardedGeneratorUserTypeSeed__.ts`;
const USER_TYPE_SEED_SOURCE = `
class Generator {
	build(): Generator {
		return this;
	}
}
export function host(): void {
	new Generator().build();         // ok: user class merely named Generator
}
`;

const SEEDS: Record<string, string> = {
	[SEED_NAME]: SEED_SOURCE,
	[TREFLEX_SEED_NAME]: TREFLEX_SEED_SOURCE,
	[USER_TYPE_SEED_NAME]: USER_TYPE_SEED_SOURCE
};

function expectedBadLines(seedName: string): string[] {
	return SEEDS[seedName]
		.split("\n")
		.map((text, index) => ({
			text,
			line: index + 1
		}))
		.filter(({ text }) => text.includes("// BAD"))
		.map(({ line }) => `${seedName}:${line}`);
}

const OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	customConditions: [
		"treflex-source"
	],
	jsx: ts.JsxEmit.Preserve,
	jsxImportSource: "@solidjs/web",
	strict: true,
	skipLibCheck: true,
	noEmit: true
};

function createProgram(): ts.Program {
	const host = ts.createCompilerHost(OPTIONS);
	const readFile = host.readFile.bind(host);
	const fileExists = host.fileExists.bind(host);
	const getSourceFile = host.getSourceFile.bind(host);
	host.readFile = (fileName) => SEEDS[fileName] ?? readFile(fileName);
	host.fileExists = (fileName) => fileName in SEEDS || fileExists(fileName);
	host.getSourceFile = (fileName, languageVersion, ...rest) =>
		fileName in SEEDS
			? ts.createSourceFile(fileName, SEEDS[fileName], languageVersion, true)
			: getSourceFile(fileName, languageVersion, ...rest);
	return ts.createProgram(
		[
			...realFiles,
			...Object.keys(SEEDS)
		],
		OPTIONS,
		host
	);
}

// Only the lib's declarations count, so a user class named Generator isn't flagged. A class implementing
// Generator isn't matched: getBaseTypes() returns only the extends clause.
const GENERATOR_NAMES = new Set([
	"Generator",
	"AsyncGenerator",
	"IterableIterator",
	"AsyncIterableIterator"
]);

function isGeneratorLike(type: ts.Type, seen: Set<ts.Type> = new Set()): boolean {
	if (seen.has(type)) {
		return false;
	}
	seen.add(type);
	if (type.isUnion() || type.isIntersection()) {
		return type.types.some((t) => isGeneratorLike(t, seen));
	}
	const name = type.getSymbol()?.getName();
	if (
		name !== undefined &&
		GENERATOR_NAMES.has(name) &&
		type.getSymbol()?.declarations?.some((declaration) => declaration.getSourceFile().fileName.includes("/lib."))
	) {
		return true;
	}
	const target = (type as ts.TypeReference).target ?? type;
	if ((target as ts.InterfaceType).isClassOrInterface?.()) {
		const bases = (target as ts.InterfaceType).getBaseTypes();
		if (bases?.some((base) => isGeneratorLike(base, seen))) {
			return true;
		}
	}
	return false;
}

// Statement positions only. A generator passed as a void callback, a concise arrow returning one into a void
// slot, and one consumed as a condition are not caught.
function collectDiscardedCalls(expr: ts.Expression, out: ts.CallExpression[]): void {
	if (
		ts.isParenthesizedExpression(expr) ||
		ts.isNonNullExpression(expr) ||
		ts.isAsExpression(expr) ||
		ts.isSatisfiesExpression(expr) ||
		ts.isTypeAssertionExpression(expr) ||
		ts.isVoidExpression(expr) ||
		ts.isAwaitExpression(expr)
	) {
		collectDiscardedCalls(expr.expression, out);
		return;
	}
	if (ts.isBinaryExpression(expr)) {
		const op = expr.operatorToken.kind;
		if (op === ts.SyntaxKind.CommaToken) {
			collectDiscardedCalls(expr.left, out);
			collectDiscardedCalls(expr.right, out);
			return;
		}
		if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
			collectDiscardedCalls(expr.right, out);
			return;
		}
		return;
	}
	if (ts.isConditionalExpression(expr)) {
		collectDiscardedCalls(expr.whenTrue, out);
		collectDiscardedCalls(expr.whenFalse, out);
		return;
	}
	if (ts.isCallExpression(expr)) {
		out.push(expr);
	}
}

function findDiscardedGeneratorCalls(program: ts.Program, files: readonly ts.SourceFile[]): string[] {
	const checker = program.getTypeChecker();
	const hits: string[] = [];
	const visit = (node: ts.Node, sourceFile: ts.SourceFile): void => {
		if (ts.isExpressionStatement(node)) {
			const calls: ts.CallExpression[] = [];
			collectDiscardedCalls(node.expression, calls);
			for (const call of calls) {
				if (isGeneratorLike(checker.getTypeAtLocation(call))) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
					hits.push(`${sourceFile.fileName}:${line + 1}`);
				}
			}
		}
		ts.forEachChild(node, (child) => visit(child, sourceFile));
	};
	for (const sourceFile of files) {
		visit(sourceFile, sourceFile);
	}
	return hits;
}

describe("discarded generator calls", () => {
	const program = createProgram();

	it("catches every seeded escape shape and none of the legitimate ones", () => {
		const seed = program.getSourceFile(SEED_NAME);
		expect(seed).toBeDefined();
		const hits = findDiscardedGeneratorCalls(program, [
			seed as ts.SourceFile
		]);
		// The conditional's two branches land on one line; dedupe to compare
		// against the per-line BAD markers.
		expect([
			...new Set(hits)
		]).toEqual(expectedBadLines(SEED_NAME));
	});

	it("catches a discarded call on a generator imported from treflex", () => {
		const seed = program.getSourceFile(TREFLEX_SEED_NAME);
		expect(seed).toBeDefined();
		const hits = findDiscardedGeneratorCalls(program, [
			seed as ts.SourceFile
		]);
		expect(hits).toEqual(expectedBadLines(TREFLEX_SEED_NAME));
	});

	it("does not flag a user type merely named Generator", () => {
		const seed = program.getSourceFile(USER_TYPE_SEED_NAME);
		expect(seed).toBeDefined();
		expect(
			findDiscardedGeneratorCalls(program, [
				seed as ts.SourceFile
			])
		).toEqual([]);
	});

	it("finds none in src/, tests/, or the demo sources", {
		timeout: 60_000
	}, () => {
		// Both sides of the length check below derive from the glob, so a renamed folder would empty both and pass.
		expect(realFiles).toContain(`${cwd}/packages/core/src/index.ts`);
		expect(realFiles).toContain(`${cwd}/packages/core/tests/testHelpers.ts`);
		expect(realFiles).toContain(`${cwd}/packages/solid/src/index.ts`);
		expect(realFiles).toContain(`${cwd}/packages/solid/src/Context/TreflexContext.tsx`);
		expect(realFiles).toContain(`${cwd}/packages/solid/tests/buildContextProxy.test.ts`);
		expect(realFiles).toContain(`${cwd}/packages/solid/tests/providerDispatch.test.tsx`);
		expect(realFiles).toContain(`${cwd}/packages/react/src/index.ts`);
		// Not this file's own path: import.meta.glob excludes the importer.
		expect(realFiles).toContain(`${cwd}/tests/importClosure.test.ts`);
		expect(realFiles).toContain(`${cwd}/demos/portal/src/trips/Planner.ts`);
		expect(realFiles).toContain(`${cwd}/demos/portal/src/trips/PlannerView.tsx`);
		expect(realFiles).toContain(`${cwd}/demos/todo/src/index.tsx`);
		expect(realFiles).toContain(`${cwd}/demos/checkout/src/shop/shop.ts`);
		expect(realFiles).toContain(`${cwd}/demos/checkout/src/views/ShopView.tsx`);
		expect(realFiles.length).toBeGreaterThan(350);

		const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && !(f.fileName in SEEDS) && realFiles.includes(f.fileName));
		expect(files).toHaveLength(realFiles.length);

		// An unresolved import types as `any`, which blinds the walk for that file.
		const resolutionFailures = program
			.getSemanticDiagnostics()
			.filter((d) => d.code === 2307 || d.code === 2792)
			.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
			.filter((message) => !message.includes(".css"));
		expect(resolutionFailures).toEqual([]);

		expect(findDiscardedGeneratorCalls(program, files)).toEqual([]);
	});
});
