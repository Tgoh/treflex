import { AST_NODE_TYPES, ASTUtils, ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

export type INoYieldInFinallyMessageId = "noYieldInFinally";

function isTransientCall(
	node: TSESTree.Expression | null | undefined,
	scopeOf: (node: TSESTree.Node) => Parameters<typeof ASTUtils.findVariable>[0]
): boolean {
	if (node?.type !== AST_NODE_TYPES.CallExpression || node.callee.type !== AST_NODE_TYPES.Identifier) {
		return false;
	}
	const name = node.callee.name;
	const definition = ASTUtils.findVariable(scopeOf(node), name)?.defs[0];
	if (!definition) {
		return name === "transient";
	}
	return (
		definition.type === "ImportBinding" &&
		definition.node.type === AST_NODE_TYPES.ImportSpecifier &&
		definition.node.imported.type === AST_NODE_TYPES.Identifier &&
		definition.node.imported.name === "transient"
	);
}

function inFinally(node: TSESTree.Node): boolean {
	let child: TSESTree.Node = node;
	for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (
			parent.type === AST_NODE_TYPES.FunctionDeclaration ||
			parent.type === AST_NODE_TYPES.FunctionExpression ||
			parent.type === AST_NODE_TYPES.ArrowFunctionExpression
		) {
			return false;
		}
		if (parent.type === AST_NODE_TYPES.TryStatement && parent.finalizer === child) {
			return true;
		}
	}
	return false;
}

export const noYieldInFinally = ESLintUtils.RuleCreator.withoutDocs<[], INoYieldInFinallyMessageId>({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow a yield in a finally block, which a stopped action cannot dispatch"
		},
		schema: [],
		messages: {
			noYieldInFinally:
				"A yield in a finally block can't run when the action is stopped: the runtime reports cancel/finally-yield and skips the rest of that finally block. Keep the finally synchronous, and move cleanup that needs an effect to an action that outlives it."
		}
	},
	defaultOptions: [],
	create(context) {
		const scopeOf = (node: TSESTree.Node) => context.sourceCode.getScope(node);
		return {
			YieldExpression(node) {
				if (node.delegate && isTransientCall(node.argument, scopeOf)) {
					return;
				}
				if (inFinally(node)) {
					context.report({
						node,
						messageId: "noYieldInFinally"
					});
				}
			}
		};
	}
});
