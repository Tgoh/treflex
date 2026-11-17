import { AST_NODE_TYPES, ESLintUtils } from "@typescript-eslint/utils";
import { isImportedAs, literalText } from "./callsByName";

export type INamedMessageId = "notLiteral" | "duplicate" | "notTopLevel";

export const named = ESLintUtils.RuleCreator.withoutDocs<[], INamedMessageId>({
	meta: {
		type: "problem",
		docs: {
			description:
				"Require an action's durable name to be a string literal given by a top-level statement, and a name to name one action in a file"
		},
		schema: [],
		messages: {
			notLiteral:
				"An action's durable name is a string literal, the same in every build. A computed name, such as the function's own name, changes when a bundler renames it.",
			duplicate: '"{{name}}" already names another action in this file, and a name names one action. Give this one another name.',
			notTopLevel:
				"Name an action in the module that defines it, with a statement of its own after the declaration. A mark inside a function or a block runs each time it does, and an action a factory makes on each call can't be named: write one action that takes the factory's parameters as arguments."
		}
	},
	defaultOptions: [],
	create(context) {
		const scopeOf = (node: Parameters<typeof context.sourceCode.getScope>[0]) => context.sourceCode.getScope(node);
		const taken = new Set<string>();
		return {
			CallExpression(node) {
				if (!isImportedAs(node.callee, "named", scopeOf) || node.arguments.length < 2) {
					return;
				}
				if (node.parent.type !== AST_NODE_TYPES.ExpressionStatement || node.parent.parent.type !== AST_NODE_TYPES.Program) {
					context.report({
						node,
						messageId: "notTopLevel"
					});
				}
				const argument = node.arguments[1]!;
				const name = literalText(argument);
				if (name === undefined) {
					context.report({
						node: argument,
						messageId: "notLiteral"
					});
					return;
				}
				if (taken.has(name)) {
					context.report({
						node: argument,
						messageId: "duplicate",
						data: {
							name
						}
					});
					return;
				}
				taken.add(name);
			}
		};
	}
});
