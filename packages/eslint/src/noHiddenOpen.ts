import { AST_NODE_TYPES, ASTUtils, ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

export type INoHiddenOpenMessageId = "unknownCall" | "anyCaller";

// By name: an application's program may hold more than one copy of treflex.
const OPEN_MARK = "IOpenMark";
const ACTION_YIELD = "IActionYield";
const SELECTOR_GENERATOR = "ISelectorGenerator";
const OPEN = "open";

type IScopeOf = (node: TSESTree.Node) => Parameters<typeof ASTUtils.findVariable>[0];

function yieldTypeOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
	if ((type.flags & ts.TypeFlags.Object) === 0 || ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) {
		return undefined;
	}
	return checker.getTypeArguments(type as ts.TypeReference)[0];
}

function partsOf(type: ts.Type): readonly ts.Type[] {
	return type.isUnion()
		? type.types
		: [
				type
			];
}

function named(type: ts.Type | undefined, name: string): boolean {
	if (type === undefined || (type.flags & ts.TypeFlags.Any) !== 0) {
		return false;
	}
	return partsOf(type).some((part) => (part.getSymbol()?.getName() ?? part.aliasSymbol?.getName()) === name);
}

function enclosingGenerator(node: TSESTree.Node): TSESTree.FunctionLike | undefined {
	for (let at = node.parent; at; at = at.parent) {
		if (
			at.type === AST_NODE_TYPES.FunctionDeclaration ||
			at.type === AST_NODE_TYPES.FunctionExpression ||
			at.type === AST_NODE_TYPES.ArrowFunctionExpression
		) {
			return at.generator ? at : undefined;
		}
	}
	return undefined;
}

function callsOpen(node: TSESTree.Node, scopeOf: IScopeOf): boolean {
	if (node.type !== AST_NODE_TYPES.CallExpression || node.callee.type !== AST_NODE_TYPES.Identifier) {
		return false;
	}
	const name = node.callee.name;
	const definition = ASTUtils.findVariable(scopeOf(node), name)?.defs[0];
	if (!definition) {
		return name === OPEN;
	}
	return (
		definition.type === "ImportBinding" &&
		definition.node.type === AST_NODE_TYPES.ImportSpecifier &&
		definition.node.imported.type === AST_NODE_TYPES.Identifier &&
		definition.node.imported.name === OPEN
	);
}

export const noHiddenOpen = ESLintUtils.RuleCreator.withoutDocs<[], INoHiddenOpenMessageId>({
	meta: {
		type: "problem",
		docs: {
			description: "Report a call whose type can't say whether it opens, where the compiler can't see it"
		},
		schema: [],
		messages: {
			unknownCall:
				"This call's type doesn't say whether it opens, so it gets past IActionGenerator's check. Give the call a type that says whether it opens.",
			anyCaller:
				"This function's yield type is any, so the open(...) in it, or the call here that opens, marks nothing for its callers. Give the function a yield type that carries the marker, or leave it unannotated with no call typed any inside."
		}
	},
	defaultOptions: [],
	create(context) {
		const services = ESLintUtils.getParserServices(context);
		const checker = services.program.getTypeChecker();
		const scopeOf: IScopeOf = (node) => context.sourceCode.getScope(node);
		const typeOf = (node: TSESTree.Node) => services.getTypeAtLocation(node);
		const opens = (node: TSESTree.Node) => named(yieldTypeOf(checker, typeOf(node)), OPEN_MARK);
		return {
			YieldExpression(node) {
				if (!node.delegate || !node.argument) {
					return;
				}
				const generator = enclosingGenerator(node);
				if (!generator) {
					return;
				}
				const declaration = services.esTreeNodeToTSNodeMap.get(generator) as ts.SignatureDeclaration;
				const signature = checker.getSignatureFromDeclaration(declaration);
				const callerYield = signature ? yieldTypeOf(checker, checker.getReturnTypeOfSignature(signature)) : undefined;
				if (callerYield !== undefined && (callerYield.flags & ts.TypeFlags.Any) !== 0) {
					if (callsOpen(node.argument, scopeOf) || opens(node.argument)) {
						context.report({
							node,
							messageId: "anyCaller"
						});
					}
					return;
				}
				if (!named(callerYield, ACTION_YIELD) || named(callerYield, OPEN_MARK)) {
					return;
				}
				if (declaration.type && checker.getTypeAtLocation(declaration.type).aliasSymbol?.getName() === SELECTOR_GENERATOR) {
					return;
				}
				if ((typeOf(node.argument).flags & ts.TypeFlags.Any) !== 0) {
					context.report({
						node,
						messageId: "unknownCall"
					});
				}
			}
		};
	}
});
