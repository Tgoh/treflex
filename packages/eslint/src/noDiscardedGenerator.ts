import { AST_NODE_TYPES, ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

export type INoDiscardedGeneratorMessageId = "discarded" | "discardedAsync" | "delegate";

type IKind = "sync" | "async";

const KINDS: ReadonlyMap<string, IKind> = new Map([
	[
		"Generator",
		"sync"
	],
	[
		"AsyncGenerator",
		"async"
	]
]);

const NULLISH = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;

interface IDiscard {
	call: TSESTree.CallExpression;
	position: TSESTree.Expression;
}

function unwrap(node: TSESTree.Expression): TSESTree.Expression {
	let at = node;
	while (
		at.type === AST_NODE_TYPES.TSAsExpression ||
		at.type === AST_NODE_TYPES.TSSatisfiesExpression ||
		at.type === AST_NODE_TYPES.TSNonNullExpression ||
		at.type === AST_NODE_TYPES.TSTypeAssertion ||
		at.type === AST_NODE_TYPES.ChainExpression
	) {
		at = at.expression;
	}
	return at;
}

function collect(node: TSESTree.Expression, position: TSESTree.Expression, out: IDiscard[]): void {
	switch (node.type) {
		case AST_NODE_TYPES.UnaryExpression:
			if (node.operator === "void") {
				collect(node.argument, position, out);
			}
			return;
		case AST_NODE_TYPES.AwaitExpression:
			collect(node.argument, position, out);
			return;
		case AST_NODE_TYPES.SequenceExpression:
			for (const element of node.expressions) {
				collect(element, element, out);
			}
			return;
		case AST_NODE_TYPES.ConditionalExpression:
			collect(node.consequent, node.consequent, out);
			collect(node.alternate, node.alternate, out);
			return;
		case AST_NODE_TYPES.LogicalExpression:
			collect(node.right, node.right, out);
			return;
		default: {
			const call = unwrap(node);
			if (call.type === AST_NODE_TYPES.CallExpression) {
				out.push({
					call,
					position
				});
			}
		}
	}
}

function partsOf(type: ts.Type): readonly ts.Type[] {
	return type.isUnion()
		? type.types
		: [
				type
			];
}

function delegatingGenerator(node: TSESTree.Node): TSESTree.FunctionLike | undefined {
	let child: TSESTree.Node = node;
	for (let at = node.parent; at; child = at, at = at.parent) {
		switch (at.type) {
			case AST_NODE_TYPES.FunctionDeclaration:
			case AST_NODE_TYPES.FunctionExpression:
			case AST_NODE_TYPES.ArrowFunctionExpression:
				return at.generator ? at : undefined;
			case AST_NODE_TYPES.StaticBlock:
				return undefined;
			case AST_NODE_TYPES.TryStatement:
				// treflex/no-yield-in-finally reports a yield* the suggestion would add here.
				if (at.finalizer === child) {
					return undefined;
				}
		}
	}
	return undefined;
}

export const noDiscardedGenerator = ESLintUtils.RuleCreator.withoutDocs<[], INoDiscardedGeneratorMessageId>({
	meta: {
		type: "problem",
		docs: {
			description: "Report a call that creates a generator and drops it, so its body never runs"
		},
		hasSuggestions: true,
		schema: [],
		messages: {
			discarded:
				"This call creates a generator and nothing runs it, so none of its body runs: an effect in it never dispatches, and nothing reports it. Call it with yield*, from inside an action or selector.",
			discardedAsync:
				"This call creates an async generator and nothing runs it, so none of its body runs. Iterate it with for await, or call it with yield* from inside an async generator.",
			delegate: "Call it with yield*."
		}
	},
	defaultOptions: [],
	create(context) {
		const services = ESLintUtils.getParserServices(context);
		const program = services.program;
		const checker = program.getTypeChecker();

		const fromLib = (symbol: ts.Symbol) => {
			const declarations = symbol.declarations ?? [];
			return declarations.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
		};

		const kindOfPart = (type: ts.Type, path: Set<ts.Type>): IKind | undefined => {
			if (path.has(type) || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
				return undefined;
			}
			path.add(type);
			try {
				return kindOfNewPart(type, path);
			} finally {
				path.delete(type);
			}
		};

		const kindOfNewPart = (type: ts.Type, path: Set<ts.Type>): IKind | undefined => {
			if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
				const constraint = checker.getBaseConstraintOfType(type);
				return constraint ? kindOfType(constraint, path) : undefined;
			}
			if (type.isIntersection()) {
				for (const part of type.types) {
					const kind = kindOfPart(part, path);
					if (kind) {
						return kind;
					}
				}
				return undefined;
			}
			const symbol = type.getSymbol();
			const kind = symbol ? KINDS.get(symbol.getName()) : undefined;
			if (symbol && kind && fromLib(symbol)) {
				return kind;
			}
			const target = (type as ts.TypeReference).target ?? type;
			if (target.isClassOrInterface()) {
				for (const base of checker.getBaseTypes(target)) {
					const kind = kindOfPart(base, path);
					if (kind) {
						return kind;
					}
				}
			}
			return undefined;
		};

		const kindOfType = (type: ts.Type, path: Set<ts.Type>): IKind | undefined => {
			let result: IKind | undefined;
			for (const part of partsOf(type)) {
				if ((part.flags & NULLISH) !== 0) {
					continue;
				}
				const kind = kindOfPart(part, path);
				if (!kind) {
					return undefined;
				}
				result = result === "async" ? result : kind;
			}
			return result;
		};

		const report = (discards: readonly IDiscard[], suggest: boolean) => {
			for (const { call, position } of discards) {
				const type = services.getTypeAtLocation(call);
				const kind = kindOfType(type, new Set());
				if (!kind) {
					continue;
				}
				const host = delegatingGenerator(call);
				// `yield* undefined` throws where the dropped call did nothing.
				const canDelegate =
					suggest && host !== undefined && (kind === "sync" || host.async) && partsOf(type).every((part) => (part.flags & NULLISH) === 0);
				const suggestions: TSESLint.SuggestionReportDescriptor<INoDiscardedGeneratorMessageId>[] = canDelegate
					? [
							{
								messageId: "delegate",
								fix: (fixer) => {
									const delegated = `yield* ${context.sourceCode.getText(call)}`;
									return fixer.replaceText(
										position,
										position.parent.type === AST_NODE_TYPES.ExpressionStatement ? delegated : `(${delegated})`
									);
								}
							}
						]
					: [];
				context.report({
					node: call,
					messageId: kind === "sync" ? "discarded" : "discardedAsync",
					suggest: suggestions
				});
			}
		};

		return {
			ExpressionStatement(node) {
				const discards: IDiscard[] = [];
				collect(node.expression, node.expression, discards);
				report(discards, true);
			},
			VariableDeclarator(node) {
				const declaration = node.parent;
				if (
					node.id.type !== AST_NODE_TYPES.Identifier ||
					!node.init ||
					declaration.declare ||
					(declaration.kind !== "const" && declaration.kind !== "let" && declaration.kind !== "var") ||
					declaration.parent.type === AST_NODE_TYPES.ExportNamedDeclaration
				) {
					return;
				}
				const [variable] = context.sourceCode.getDeclaredVariables(node);
				if (!variable || variable.scope.type === "global" || variable.references.some((reference) => reference.isRead())) {
					return;
				}
				const discards: IDiscard[] = [];
				collect(node.init, node.init, discards);
				report(discards, false);
			}
		};
	}
});
