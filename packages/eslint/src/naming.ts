import ts from "typescript";

// By name: an application's program may hold more than one copy of treflex.
const WORK_TAG = "IWorkTag";
const FEATURES = [
	"createEntityFeature",
	"createComponentFeature"
];
const MARKS = [
	"start",
	"leading",
	"latest"
];

/** Text to insert at an offset into a source file's text. */
export interface IInsertion {
	at: number;
	text: string;
}

/** An action passed to one of the calls `treflex/require-name` checks, or a generator function written there inline. */
export type IActionUse =
	| {
			node: ts.Node;
			symbol: ts.Symbol;
	  }
	| {
			node: ts.Node;
			symbol: undefined;
			label: string;
			/** A generator method written in a feature's actions object, rather than a function expression. */
			method: boolean;
	  };

export interface INamesIn {
	symbols: Set<ts.Symbol>;
	names: Set<string>;
	/** The `named` calls whose action or name can't be read, so what they name is unknown. */
	unreadable: {
		call: ts.CallExpression;
		reason: string;
	}[];
}

export interface IUnnamedAction {
	symbol: ts.Symbol;
	declaration: ts.Declaration;
	file: ts.SourceFile;
	/** The generator's own name, or `(anonymous)`. */
	label: string;
	name: string | undefined;
	typed: boolean;
}

/** Why an action in its declaring module can't be given a name there. */
export type IRefusal =
	| {
			reason: "anonymous" | "typed" | "notTopLevel" | "noPrefix" | "noImports" | "foreignNamed";
	  }
	| {
			reason: "clash";
			name: string;
	  };

export interface IPlan {
	name: string;
	mark: IInsertion;
	import: IInsertion | null;
}

export interface INamer {
	namesIn(file: ts.SourceFile): INamesIn;
	/** The action a symbol resolves to, when it is a generator its declaring module doesn't name; otherwise null. */
	unnamed(symbol: ts.Symbol): IUnnamedAction | null;
	/** The mark, and the import it needs, that name `action` in its declaring module. A planned name is claimed for the namer's life. */
	plan(action: IUnnamedAction, taken: (name: string) => boolean): IPlan | IRefusal;
}

export function pascal(text: string): string {
	return text
		.split(/[^A-Za-z0-9]+/)
		.filter((part) => part !== "")
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("");
}

function resolved(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
	return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function unparenthesized(node: ts.Expression): ts.Expression {
	let inner = node;
	while (ts.isParenthesizedExpression(inner)) {
		inner = inner.expression;
	}
	return inner;
}

function isLiteral(node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
	return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

// Read off the import, so a callee from a module that doesn't resolve still answers.
function calleeName(checker: ts.TypeChecker, callee: ts.Expression): string | undefined {
	if (ts.isPropertyAccessExpression(callee)) {
		const namespace = ts.isIdentifier(callee.expression) ? checker.getSymbolAtLocation(callee.expression)?.declarations?.[0] : undefined;
		return namespace !== undefined && ts.isNamespaceImport(namespace) ? callee.name.text : undefined;
	}
	if (!ts.isIdentifier(callee)) {
		return undefined;
	}
	const symbol = checker.getSymbolAtLocation(callee);
	const declaration = symbol?.declarations?.[0];
	if (declaration !== undefined && ts.isImportSpecifier(declaration)) {
		return (declaration.propertyName ?? declaration.name).text;
	}
	return symbol?.getName() ?? callee.text;
}

// A declaration in a `declare global` block, or in another file, is a global the module itself doesn't declare.
function declarationIn(symbol: ts.Symbol, file: ts.SourceFile): ts.Declaration | undefined {
	return symbol.declarations?.find((declaration) => {
		if (declaration.getSourceFile() !== file) {
			return false;
		}
		for (let parent = declaration.parent; parent !== undefined; parent = parent.parent) {
			if (ts.isModuleDeclaration(parent) && (parent.flags & ts.NodeFlags.GlobalAugmentation) !== 0) {
				return false;
			}
		}
		return true;
	});
}

// A global declared only ambiently, by `declare`, `declare global` or a `.d.ts`, may stand for treflex's
// own function, so it matches by name; a global with a body is the app's own.
function isAmbient(declaration: ts.Declaration): boolean {
	if (declaration.getSourceFile().isDeclarationFile) {
		return true;
	}
	for (let node: ts.Node | undefined = declaration; node !== undefined; node = node.parent) {
		if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether `callee` is `name`, imported from any source under any alias, read off a namespace import
 * of any source, or an unresolved or ambient global.
 */
function isImportedAs(checker: ts.TypeChecker, callee: ts.Expression, name: string): boolean {
	if (ts.isPropertyAccessExpression(callee)) {
		if (callee.name.text !== name || !ts.isIdentifier(callee.expression)) {
			return false;
		}
		const declaration = checker.getSymbolAtLocation(callee.expression)?.declarations?.[0];
		return declaration !== undefined && ts.isNamespaceImport(declaration);
	}
	if (!ts.isIdentifier(callee)) {
		return false;
	}
	const declarations = checker.getSymbolAtLocation(callee)?.declarations ?? [];
	if (declarations.every(isAmbient)) {
		return callee.text === name;
	}
	const declaration = declarations[0]!;
	if (!ts.isImportSpecifier(declaration)) {
		return false;
	}
	const imported = declaration.propertyName ?? declaration.name;
	return ts.isIdentifier(imported) && imported.text === name;
}

function referenced(checker: ts.TypeChecker, node: ts.Expression): ts.Symbol | undefined {
	if (ts.isIdentifier(node)) {
		return resolved(
			checker,
			ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
				? checker.getShorthandAssignmentValueSymbol(node.parent)
				: checker.getSymbolAtLocation(node)
		);
	}
	if (!ts.isPropertyAccessExpression(node)) {
		return undefined;
	}
	const symbol = resolved(checker, checker.getSymbolAtLocation(node.name));
	const property = symbol?.valueDeclaration;
	if (property !== undefined && ts.isShorthandPropertyAssignment(property)) {
		return resolved(checker, checker.getShorthandAssignmentValueSymbol(property));
	}
	if (property !== undefined && ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
		return resolved(checker, checker.getSymbolAtLocation(property.initializer));
	}
	return symbol;
}

function argumentUses(checker: ts.TypeChecker, argument: ts.Expression | undefined): IActionUse[] {
	if (argument === undefined) {
		return [];
	}
	const node = unparenthesized(argument);
	if (ts.isFunctionExpression(node) && node.asteriskToken !== undefined) {
		return [
			{
				node,
				symbol: undefined,
				label: node.name?.text ?? "(anonymous)",
				method: false
			}
		];
	}
	const symbol = referenced(checker, node);
	return symbol === undefined
		? []
		: [
				{
					node,
					symbol
				}
			];
}

function actionsObjectUses(checker: ts.TypeChecker, reference: ts.Expression): IActionUse[] {
	const declaration = referenced(checker, reference)?.valueDeclaration;
	if (
		declaration === undefined ||
		!ts.isVariableDeclaration(declaration) ||
		declaration.initializer === undefined ||
		!ts.isObjectLiteralExpression(declaration.initializer)
	) {
		return [];
	}
	return declaration.initializer.properties.flatMap((property): IActionUse[] => {
		const symbol = ts.isShorthandPropertyAssignment(property)
			? checker.getShorthandAssignmentValueSymbol(property)
			: ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
				? checker.getSymbolAtLocation(property.initializer)
				: undefined;
		const action = resolved(checker, symbol);
		return action === undefined
			? []
			: [
					{
						node: reference,
						symbol: action
					}
				];
	});
}

/** The actions a call passes to `start`, `dispatch`, `leading`, `latest`, a work tag's `mark`, or a feature. */
export function actionUses(checker: ts.TypeChecker, call: ts.CallExpression): IActionUse[] {
	const callee = unparenthesized(call.expression);
	if (
		MARKS.some((name) => isImportedAs(checker, callee, name)) ||
		(ts.isIdentifier(callee) && callee.text === "dispatch") ||
		(ts.isPropertyAccessExpression(callee) && callee.name.text === "dispatch")
	) {
		return argumentUses(checker, call.arguments[0]);
	}
	if (ts.isPropertyAccessExpression(callee) && callee.name.text === "mark") {
		const tag = checker.getTypeAtLocation(callee.expression);
		return (tag.getSymbol()?.getName() ?? tag.aliasSymbol?.getName()) === WORK_TAG
			? call.arguments.flatMap((argument) => argumentUses(checker, argument))
			: [];
	}
	const actions = call.arguments[0];
	if (
		actions === undefined ||
		!ts.isCallExpression(callee) ||
		!FEATURES.some((name) => isImportedAs(checker, unparenthesized(callee.expression), name))
	) {
		return [];
	}
	const object = unparenthesized(actions);
	if (!ts.isObjectLiteralExpression(object)) {
		return actionsObjectUses(checker, object);
	}
	return object.properties.flatMap((property): IActionUse[] => {
		if (ts.isPropertyAssignment(property)) {
			return argumentUses(checker, property.initializer);
		}
		if (ts.isShorthandPropertyAssignment(property)) {
			return argumentUses(checker, property.name);
		}
		return ts.isMethodDeclaration(property) && property.asteriskToken !== undefined
			? [
					{
						node: property,
						symbol: undefined,
						label: ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "(anonymous)",
						method: true
					}
				]
			: [];
	});
}

function generatorOf(declaration: ts.Declaration | undefined): {
	name: string | undefined;
	typed: boolean;
} | null {
	if (declaration === undefined) {
		return null;
	}
	if (ts.isFunctionDeclaration(declaration) && declaration.asteriskToken !== undefined) {
		return {
			name: declaration.name?.text,
			typed: false
		};
	}
	if (
		ts.isVariableDeclaration(declaration) &&
		declaration.initializer !== undefined &&
		ts.isFunctionExpression(declaration.initializer) &&
		declaration.initializer.asteriskToken !== undefined &&
		ts.isIdentifier(declaration.name)
	) {
		return {
			name: declaration.name.text,
			typed: declaration.type !== undefined
		};
	}
	return null;
}

function topLevelStatement(declaration: ts.Declaration): ts.Statement | null {
	let statement: ts.Node = declaration;
	if (ts.isVariableDeclaration(statement)) {
		statement = statement.parent.parent;
		if (!ts.isVariableStatement(statement)) {
			return null;
		}
	}
	return ts.isSourceFile(statement.parent) ? (statement as ts.Statement) : null;
}

function featureId(checker: ts.TypeChecker, file: ts.SourceFile): string | undefined {
	let id: string | undefined;
	const visit = (node: ts.Node): void => {
		if (id !== undefined) {
			return;
		}
		if (ts.isCallExpression(node)) {
			const [first] = node.arguments;
			if (FEATURES.includes(calleeName(checker, node.expression) ?? "") && isLiteral(first)) {
				id = first.text;
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return id;
}

function isFunction(declaration: ts.Declaration): boolean {
	if (ts.isFunctionDeclaration(declaration)) {
		return true;
	}
	if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
		return false;
	}
	const initializer = unparenthesized(declaration.initializer);
	return ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer);
}

function namesIn(checker: ts.TypeChecker, file: ts.SourceFile): INamesIn {
	const found: INamesIn = {
		symbols: new Set(),
		names: new Set(),
		unreadable: []
	};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && isImportedAs(checker, unparenthesized(node.expression), "named")) {
			const [action, name] = node.arguments;
			if (action !== undefined) {
				let target = action;
				while (
					ts.isParenthesizedExpression(target) ||
					ts.isAsExpression(target) ||
					ts.isSatisfiesExpression(target) ||
					ts.isNonNullExpression(target) ||
					ts.isTypeAssertionExpression(target)
				) {
					target = target.expression;
				}
				const symbol = referenced(checker, target);
				const declaration = symbol === undefined ? undefined : declarationOf(symbol);
				if (symbol !== undefined && declaration !== undefined && isFunction(declaration)) {
					found.symbols.add(symbol);
				} else {
					found.unreadable.push({
						call: node,
						reason: "its action doesn't resolve to a function declaration"
					});
				}
			}
			const type = name === undefined ? undefined : checker.getTypeAtLocation(name);
			if (type?.isStringLiteral()) {
				found.names.add(type.value);
			} else {
				found.unreadable.push({
					call: node,
					reason: "its name isn't a known string"
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

function lineBreakOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Where a line inserted after the code ending at `end` goes: the end of that line when only comments that
 * close on it follow, and otherwise `end` itself. `eol` is the line break to start the insertion with.
 */
export function lineAfter(
	text: string,
	end: number
): {
	at: number;
	eol: string;
} {
	const newline = text.indexOf("\n", end);
	const line =
		newline === -1
			? {
					at: text.length,
					eol: lineBreakOf(text)
				}
			: text[newline - 1] === "\r"
				? {
						at: newline - 1,
						eol: "\r\n"
					}
				: {
						at: newline,
						eol: "\n"
					};
	const here = {
		at: end,
		eol: lineBreakOf(text)
	};
	let at = end;
	while (at < line.at) {
		if (/\s/.test(text[at]!)) {
			at++;
		} else if (text.startsWith("//", at)) {
			return line;
		} else if (text.startsWith("/*", at)) {
			const close = text.indexOf("*/", at + 2);
			if (close === -1 || close + 2 > line.at) {
				return here;
			}
			at = close + 2;
		} else {
			return here;
		}
	}
	return line;
}

// A directive such as `// @ts-expect-error` on the lines straight above an import must stay with that import.
function commentsAbove(text: string, node: ts.Node): number {
	let start = node.getStart();
	for (const range of [
		...(ts.getLeadingCommentRanges(text, node.pos) ?? [])
	].reverse()) {
		const between = text.slice(range.end, start);
		const lineStart = text.lastIndexOf("\n", range.pos - 1) + 1;
		if (
			range.end > start ||
			!/^\s*$/.test(between) ||
			/\n[ \t]*\r?\n/.test(between) ||
			!/^[ \t]*$/.test(text.slice(lineStart, range.pos))
		) {
			break;
		}
		start = range.pos;
	}
	return start;
}

/** How `file` reaches treflex's `named`, and the insertion that imports it when it doesn't yet. */
export function importOf(
	checker: ts.TypeChecker,
	file: ts.SourceFile
):
	| {
			local: string;
			insertion: IInsertion | null;
	  }
	| "noImports"
	| "foreignNamed" {
	const imports = file.statements.filter(ts.isImportDeclaration);
	const fromTreflex = imports.filter(
		(statement) =>
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === "treflex" &&
			statement.importClause?.isTypeOnly !== true
	);
	const bindings = fromTreflex.map((statement) => statement.importClause?.namedBindings);
	for (const named of bindings) {
		if (named !== undefined && ts.isNamedImports(named)) {
			for (const specifier of named.elements) {
				const imported = specifier.propertyName ?? specifier.name;
				if (!specifier.isTypeOnly && ts.isIdentifier(imported) && imported.text === "named") {
					return {
						local: specifier.name.text,
						insertion: null
					};
				}
			}
		}
	}
	const namespace = bindings.find((named) => named !== undefined && ts.isNamespaceImport(named));
	if (namespace !== undefined) {
		return {
			local: `${namespace.name.text}.named`,
			insertion: null
		};
	}
	if (
		checker
			.getSymbolsInScope(file, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias)
			.some((symbol) => symbol.name === "named" && declarationIn(symbol, file) !== undefined)
	) {
		return "foreignNamed";
	}
	const specifiers = bindings.find(
		(named): named is ts.NamedImports => named !== undefined && ts.isNamedImports(named) && named.elements.length > 0
	)?.elements;
	if (specifiers === undefined) {
		const sourceOf = (statement: ts.ImportDeclaration) =>
			ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
		// Where Biome's organizeImports keeps it: after a treflex import, type-only ones included, and
		// otherwise ahead of the first package that sorts after "treflex" or the first relative import.
		const after = imports.filter((statement) => sourceOf(statement) === "treflex").at(-1);
		const before =
			after === undefined ? imports.find((statement) => sourceOf(statement).startsWith(".") || sourceOf(statement) > "treflex") : undefined;
		if (before !== undefined) {
			return {
				local: "named",
				insertion: {
					at: commentsAbove(file.text, before),
					text: `import { named } from "treflex";${lineBreakOf(file.text)}`
				}
			};
		}
		const last = after ?? imports.at(-1);
		if (last === undefined) {
			return "noImports";
		}
		const end = lineAfter(file.text, last.end);
		return {
			local: "named",
			insertion: {
				at: end.at,
				text: `${end.eol}import { named } from "treflex";`
			}
		};
	}
	const nameOf = (specifier: ts.ImportSpecifier) => (specifier.propertyName ?? specifier.name).text.toLowerCase();
	// Copied from the import, so a fix to a multi-line import stays one specifier a line.
	const between = specifiers.length > 1 ? file.text.slice(specifiers[0]!.end, specifiers[1]!.getStart(file)) : ", ";
	const at = specifiers.findIndex((specifier) => nameOf(specifier) > "named");
	return {
		local: "named",
		insertion:
			at === -1
				? {
						at: specifiers.at(-1)!.end,
						text: `${between}named`
					}
				: {
						at: specifiers[at]!.getStart(file),
						text: `named${between}`
					}
	};
}

/** The declaration that stands for an action's symbol: an overloaded function's implementation, else its value declaration. */
export function declarationOf(symbol: ts.Symbol): ts.Declaration | undefined {
	return (
		symbol.declarations?.find((each) => ts.isFunctionDeclaration(each) && each.body !== undefined) ??
		symbol.valueDeclaration ??
		symbol.declarations?.[0]
	);
}

export function createNamer(checker: ts.TypeChecker): INamer {
	const names = new Map<ts.SourceFile, INamesIn>();
	const prefixes = new Map<ts.SourceFile, string>();
	const given = new Map<string, ts.Symbol>();
	const namesOf = (file: ts.SourceFile): INamesIn => {
		let found = names.get(file);
		if (!found) {
			found = namesIn(checker, file);
			names.set(file, found);
		}
		return found;
	};
	const prefixOf = (file: ts.SourceFile): string => {
		let prefix = prefixes.get(file);
		if (prefix === undefined) {
			prefix = pascal(featureId(checker, file)?.split("/").at(-1) ?? file.fileName.split(/[\\/]/).at(-2) ?? "");
			prefixes.set(file, prefix);
		}
		return prefix;
	};
	return {
		namesIn: namesOf,
		unnamed(symbol) {
			const declaration = declarationOf(symbol);
			const generator = generatorOf(declaration);
			if (declaration === undefined || generator === null) {
				return null;
			}
			const file = declaration.getSourceFile();
			if (namesOf(file).symbols.has(symbol)) {
				return null;
			}
			return {
				symbol,
				declaration,
				file,
				label: generator.name ?? "(anonymous)",
				name: generator.name,
				typed: generator.typed
			};
		},
		plan(action, taken) {
			if (action.name === undefined) {
				return {
					reason: "anonymous"
				};
			}
			if (action.typed) {
				return {
					reason: "typed"
				};
			}
			const statement = topLevelStatement(action.declaration);
			if (statement === null) {
				return {
					reason: "notTopLevel"
				};
			}
			const prefix = prefixOf(action.file);
			if (prefix === "") {
				return {
					reason: "noPrefix"
				};
			}
			const name = `${prefix}/${pascal(action.name)}`;
			if (taken(name) || (given.get(name) ?? action.symbol) !== action.symbol) {
				return {
					reason: "clash",
					name
				};
			}
			const imported = importOf(checker, action.file);
			if (typeof imported === "string") {
				return {
					reason: imported
				};
			}
			given.set(name, action.symbol);
			const end = lineAfter(action.file.text, statement.end);
			return {
				name,
				mark: {
					at: end.at,
					text: `${end.eol}${imported.local}(${action.name}, ${JSON.stringify(name)});`
				},
				import: imported.insertion
			};
		}
	};
}
