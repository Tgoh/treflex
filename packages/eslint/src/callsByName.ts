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

export interface ICalleeName {
	name: string;
	/** The module the name is imported from, or off whose namespace or default import it is read. */
	source?: string | undefined;
	/** Read off `window`, `globalThis` or `self`. */
	viaGlobalObject: boolean;
}

const GLOBAL_OBJECTS = new Set([
	"window",
	"globalThis",
	"self"
]);

export const LIFECYCLE_CALLS = new Set([
	"onMount",
	"onCleanup",
	"createEffect",
	"createComputed",
	"createRenderEffect",
	"useEffect",
	"useLayoutEffect",
	"createTrackedEffect",
	"createReaction"
]);

/** The specifier of the import declaration that holds an import binding. */
export function importSource(parent: TSESTree.ImportDeclaration | TSESTree.TSImportEqualsDeclaration): string | undefined {
	return parent.type === AST_NODE_TYPES.ImportDeclaration ? parent.source.value : undefined;
}

/**
 * The name `callee` calls: imported from any source under any alias, read off a namespace or default import, an
 * unresolved global, or a member of `window`, `globalThis` or `self`. `undefined` for a local binding.
 */
export function calleeName(callee: TSESTree.Node, scopeOf: IScopeOf): ICalleeName | undefined {
	if (callee.type === AST_NODE_TYPES.Identifier) {
		const definition = ASTUtils.findVariable(scopeOf(callee), callee.name)?.defs[0];
		if (!definition) {
			return {
				name: callee.name,
				viaGlobalObject: false
			};
		}
		if (
			definition.type === "ImportBinding" &&
			definition.node.type === AST_NODE_TYPES.ImportSpecifier &&
			definition.node.imported.type === AST_NODE_TYPES.Identifier
		) {
			return {
				name: definition.node.imported.name,
				source: importSource(definition.parent),
				viaGlobalObject: false
			};
		}
		return undefined;
	}
	if (
		callee.type !== AST_NODE_TYPES.MemberExpression ||
		callee.computed ||
		callee.property.type !== AST_NODE_TYPES.Identifier ||
		callee.object.type !== AST_NODE_TYPES.Identifier
	) {
		return undefined;
	}
	const definition = ASTUtils.findVariable(scopeOf(callee), callee.object.name)?.defs[0];
	if (
		definition?.type === "ImportBinding" &&
		(definition.node.type === AST_NODE_TYPES.ImportNamespaceSpecifier || definition.node.type === AST_NODE_TYPES.ImportDefaultSpecifier)
	) {
		return {
			name: callee.property.name,
			source: importSource(definition.parent),
			viaGlobalObject: false
		};
	}
	if (!definition && GLOBAL_OBJECTS.has(callee.object.name)) {
		return {
			name: callee.property.name,
			viaGlobalObject: true
		};
	}
	return undefined;
}

/** The name in `names` that `callee` calls as {@link calleeName} reads it, except as a member of a global object. */
export function calledAs(callee: TSESTree.Node, names: Set<string>, scopeOf: IScopeOf): string | undefined {
	const found = calleeName(callee, scopeOf);
	return found && !found.viaGlobalObject && names.has(found.name) ? found.name : undefined;
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
