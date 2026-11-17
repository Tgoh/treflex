import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

export type INoReturnedPromiseMessageId = "returnedPromise";

const UNCHECKED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

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

// A sync generator only: an async generator's `return` awaits its operand.
function inSyncGenerator(node: TSESTree.Node): boolean {
	for (let at = node.parent; at; at = at.parent) {
		if (
			at.type === AST_NODE_TYPES.FunctionDeclaration ||
			at.type === AST_NODE_TYPES.FunctionExpression ||
			at.type === AST_NODE_TYPES.ArrowFunctionExpression
		) {
			return at.generator && !at.async;
		}
	}
	return false;
}

export const noReturnedPromise = ESLintUtils.RuleCreator.withoutDocs<[], INoReturnedPromiseMessageId>({
	meta: {
		type: "problem",
		docs: {
			description: "Report a generator that returns a promise or a thenable, which an action's result can't be"
		},
		schema: [],
		messages: {
			returnedPromise:
				"{{name}} is a promise or a thenable, and a generator returns it here. An action or a parallel branch that returns one fails with NonPlainDataError, and a helper hands it on to the action that called it. Declare the call as an effect and yield* it: return yield* save(x)."
		}
	},
	defaultOptions: [],
	create(context) {
		const services = ESLintUtils.getParserServices(context);
		const program = services.program;
		const checker = program.getTypeChecker();

		const libFunction = (type: ts.Type) => {
			const symbol = type.getSymbol();
			return (
				symbol?.getName() === "Function" &&
				(symbol.declarations ?? []).some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
			);
		};

		const callable = (type: ts.Type) =>
			(type.isUnion()
				? type.types
				: [
						type
					]
			).some((part) => part.getCallSignatures().length > 0 || libFunction(part));

		const thenable = (type: ts.Type, seen: Set<ts.Type>): boolean => {
			if (seen.has(type) || (type.flags & UNCHECKED) !== 0) {
				return false;
			}
			seen.add(type);
			if (type.isUnion()) {
				return type.types.some((part) => thenable(part, seen));
			}
			if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
				const constraint = checker.getBaseConstraintOfType(type);
				return constraint !== undefined && thenable(constraint, seen);
			}
			const then = checker.getPropertyOfType(type, "then");
			if (!then) {
				return false;
			}
			return callable(checker.getTypeOfSymbol(then));
		};

		const nameOf = (node: TSESTree.Expression): string => {
			const at = unwrap(node);
			const text =
				at.type === AST_NODE_TYPES.CallExpression || at.type === AST_NODE_TYPES.NewExpression
					? `${at.type === AST_NODE_TYPES.NewExpression ? "new " : ""}${context.sourceCode.getText(at.callee)}(...)`
					: context.sourceCode.getText(node);
			return text.replace(/\s+/g, " ");
		};

		return {
			ReturnStatement(node) {
				if (!node.argument || !inSyncGenerator(node)) {
					return;
				}
				if (!thenable(services.getTypeAtLocation(node.argument), new Set())) {
					return;
				}
				context.report({
					node: node.argument,
					messageId: "returnedPromise",
					data: {
						name: nameOf(node.argument)
					}
				});
			}
		};
	}
});
