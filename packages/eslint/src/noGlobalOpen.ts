import { AST_NODE_TYPES, ASTUtils, ESLintUtils } from "@typescript-eslint/utils";

export type INoGlobalOpenMessageId = "noGlobalOpen";

const OPEN = "open";

export const noGlobalOpen = ESLintUtils.RuleCreator.withoutDocs<[], INoGlobalOpenMessageId>({
	meta: {
		type: "problem",
		docs: {
			description: "Report a call to open that nothing declares or imports, which reaches the browser's window.open"
		},
		schema: [],
		messages: {
			noGlobalOpen:
				"Nothing declares or imports open here, so this calls the browser's window.open. Import it: import { open } from \"treflex\". Write window.open to mean the browser's."
		}
	},
	defaultOptions: [],
	create(context) {
		return {
			CallExpression(node) {
				if (node.callee.type !== AST_NODE_TYPES.Identifier || node.callee.name !== OPEN) {
					return;
				}
				const variable = ASTUtils.findVariable(context.sourceCode.getScope(node), OPEN);
				if (variable && variable.defs.length > 0) {
					return;
				}
				context.report({
					node,
					messageId: "noGlobalOpen"
				});
			}
		};
	}
});
