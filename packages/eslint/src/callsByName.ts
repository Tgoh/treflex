import { AST_NODE_TYPES, ASTUtils, type TSESTree } from "@typescript-eslint/utils";

export type IScopeOf = (node: TSESTree.Node) => Parameters<typeof ASTUtils.findVariable>[0];

/**
 * Whether `callee` is `name`, imported from any source under any alias, read off a namespace import
 * of any source, or an unresolved global.
 */
export function isImportedAs(callee: TSESTree.Node, name: string, scopeOf: IScopeOf): boolean {
	if (callee.type === AST_NODE_TYPES.MemberExpression) {
		if (
			callee.computed ||
			callee.property.type !== AST_NODE_TYPES.Identifier ||
			callee.property.name !== name ||
			callee.object.type !== AST_NODE_TYPES.Identifier
		) {
			return false;
		}
		const definition = ASTUtils.findVariable(scopeOf(callee), callee.object.name)?.defs[0];
		return definition?.type === "ImportBinding" && definition.node.type === AST_NODE_TYPES.ImportNamespaceSpecifier;
	}
	if (callee.type !== AST_NODE_TYPES.Identifier) {
		return false;
	}
	const definition = ASTUtils.findVariable(scopeOf(callee), callee.name)?.defs[0];
	if (!definition) {
		return callee.name === name;
	}
	return (
		definition.type === "ImportBinding" &&
		definition.node.type === AST_NODE_TYPES.ImportSpecifier &&
		definition.node.imported.type === AST_NODE_TYPES.Identifier &&
		definition.node.imported.name === name
	);
}

/** The text of a string literal, or of a template literal with no substitutions. */
export function literalText(node: TSESTree.Node | undefined): string | undefined {
	if (node?.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
		return node.value;
	}
	if (node?.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0) {
		return node.quasis[0]!.value.cooked ?? undefined;
	}
	return undefined;
}
