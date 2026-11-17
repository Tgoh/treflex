import { AST_NODE_TYPES, ASTUtils, ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

export type INoEditAfterWriteMessageId = "noEditAfterWrite";

const ARRAY_EDITS = new Set([
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"sort",
	"reverse",
	"fill",
	"copyWithin"
]);

const NODE_LOOKUPS = new Set([
	"find",
	"findLast",
	"at"
]);

interface IWrite {
	at: TSESTree.Node;
	// Object.assign freezes what the source's properties hold and leaves the source open.
	contentsOnly: boolean;
}

function unwrap(node: TSESTree.Node): TSESTree.Node {
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

function methodOf(call: TSESTree.CallExpression): {
	name: string | null;
	receiver: TSESTree.Node;
} | null {
	const callee = unwrap(call.callee);
	return callee.type === AST_NODE_TYPES.MemberExpression
		? {
				name: ASTUtils.getPropertyName(callee),
				receiver: callee.object
			}
		: null;
}

function contains(outer: TSESTree.Node, inner: TSESTree.Node): boolean {
	return outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];
}

function isLoop(node: TSESTree.Node): boolean {
	return (
		node.type === AST_NODE_TYPES.ForStatement ||
		node.type === AST_NODE_TYPES.ForOfStatement ||
		node.type === AST_NODE_TYPES.ForInStatement ||
		node.type === AST_NODE_TYPES.WhileStatement ||
		node.type === AST_NODE_TYPES.DoWhileStatement
	);
}

function leavesBefore(last: TSESTree.Statement | undefined, edit: TSESTree.Node): boolean {
	if (last?.type === AST_NODE_TYPES.ReturnStatement || last?.type === AST_NODE_TYPES.ThrowStatement) {
		return true;
	}
	if (last?.type !== AST_NODE_TYPES.BreakStatement && last?.type !== AST_NODE_TYPES.ContinueStatement) {
		return false;
	}
	const label = last.label?.name;
	const isTarget = (node: TSESTree.Node): boolean =>
		label !== undefined
			? node.type === AST_NODE_TYPES.LabeledStatement && node.label.name === label
			: isLoop(node) || (last.type === AST_NODE_TYPES.BreakStatement && node.type === AST_NODE_TYPES.SwitchStatement);
	let target: TSESTree.Node | undefined = last.parent;
	while (target && !isTarget(target)) {
		target = target.parent;
	}
	return !!target && contains(target, edit);
}

function editCanFollow(write: TSESTree.Node, edit: TSESTree.Node): boolean {
	let below = write;
	let above = write.parent;
	while (above && !contains(above, edit)) {
		if (above.type === AST_NODE_TYPES.ReturnStatement || above.type === AST_NODE_TYPES.ThrowStatement) {
			return false;
		}
		const last =
			above.type === AST_NODE_TYPES.BlockStatement
				? above.body.at(-1)
				: above.type === AST_NODE_TYPES.SwitchCase
					? above.consequent.at(-1)
					: undefined;
		if (leavesBefore(last, edit)) {
			return false;
		}
		below = above;
		above = above.parent;
	}
	return !((above?.type === AST_NODE_TYPES.IfStatement || above?.type === AST_NODE_TYPES.ConditionalExpression) && below !== above.test);
}

export const noEditAfterWrite = ESLintUtils.RuleCreator.withoutDocs<[], INoEditAfterWriteMessageId>({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow editing a local after writing it into the draft, which freezes it"
		},
		schema: [],
		messages: {
			noEditAfterWrite:
				'"{{name}}" is frozen once written into the draft, so this edit throws a TypeError. Set it before the write, or change it through the draft.'
		}
	},
	defaultOptions: [],
	create(context) {
		const { sourceCode } = context;
		const services = ESLintUtils.getParserServices(context);
		const checker = services.program.getTypeChecker();

		const isEntityDraft = (parameter: TSESTree.Parameter): boolean => {
			const id = services.getTypeAtLocation(parameter).getProperty("$Id");
			return (
				id !== undefined &&
				(checker.getTypeOfSymbolAtLocation(id, services.esTreeNodeToTSNodeMap.get(parameter)).flags & ts.TypeFlags.StringLike) !== 0
			);
		};

		const variableOf = (identifier: TSESTree.Identifier) => ASTUtils.findVariable(sourceCode.getScope(identifier), identifier.name);

		const check = (fn: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression): void => {
			const draft = fn.params[0];
			if (!fn.generator || draft?.type !== AST_NODE_TYPES.Identifier || !isEntityDraft(draft)) {
				return;
			}
			const draftVariable = variableOf(draft);
			if (!draftVariable) {
				return;
			}

			const live = new Set<TSESLint.Scope.Variable>([
				draftVariable
			]);
			// Kept once set, so `if (c) x = d.A; else x = {};` stays out whichever arm comes last.
			const fromDraft = new Set<TSESLint.Scope.Variable>();
			// Parameters, loop bindings and destructured bindings: any may be a live node, and so may a part of one.
			const untracked = new Set(sourceCode.getDeclaredVariables(fn));
			const plain = new Set<TSESLint.Scope.Variable>();
			const writes = new Map<TSESLint.Scope.Variable, IWrite[]>();

			const isRootedIn = (expression: TSESTree.Node, roots: ReadonlySet<TSESLint.Scope.Variable>): boolean => {
				const node = unwrap(expression);
				if (node.type === AST_NODE_TYPES.Identifier) {
					const variable = variableOf(node);
					return variable !== null && roots.has(variable);
				}
				if (node.type === AST_NODE_TYPES.MemberExpression) {
					return isRootedIn(node.object, roots);
				}
				if (node.type === AST_NODE_TYPES.CallExpression) {
					const method = methodOf(node);
					return method !== null && method.name !== null && NODE_LOOKUPS.has(method.name) && isRootedIn(method.receiver, roots);
				}
				return false;
			};

			const isLive = (expression: TSESTree.Node): boolean => isRootedIn(expression, live);

			// Wider than isLive: a helper handed the draft may return a node, and a copy of a collection holds its nodes.
			const comesFromDraft = (expression: TSESTree.Node): boolean => {
				const node = unwrap(expression);
				switch (node.type) {
					case AST_NODE_TYPES.Identifier: {
						const variable = variableOf(node);
						return variable !== null && (live.has(variable) || fromDraft.has(variable));
					}
					case AST_NODE_TYPES.MemberExpression:
						return comesFromDraft(node.object);
					case AST_NODE_TYPES.CallExpression:
						return comesFromDraft(node.callee) || node.arguments.some(comesFromDraft);
					case AST_NODE_TYPES.SpreadElement:
					case AST_NODE_TYPES.AwaitExpression:
						return comesFromDraft(node.argument);
					case AST_NODE_TYPES.YieldExpression:
						return node.argument ? comesFromDraft(node.argument) : false;
					case AST_NODE_TYPES.ConditionalExpression:
						return comesFromDraft(node.consequent) || comesFromDraft(node.alternate);
					case AST_NODE_TYPES.LogicalExpression:
						return comesFromDraft(node.left) || comesFromDraft(node.right);
					default:
						return false;
				}
			};

			const bind = (variables: readonly TSESLint.Scope.Variable[], single: boolean, value: TSESTree.Node): void => {
				const isNode = isLive(value);
				const derived = isNode || comesFromDraft(value) || isRootedIn(value, untracked);
				for (const variable of variables) {
					if (isNode) {
						live.add(variable);
					}
					if (single) {
						untracked.delete(variable);
					}
					if (derived) {
						fromDraft.add(variable);
					} else if (single && !fromDraft.has(variable)) {
						plain.add(variable);
					}
				}
			};

			const noteWrite = (value: TSESTree.Node, at: TSESTree.Node, contentsOnly: boolean): void => {
				const node = unwrap(value);
				const variable = node.type === AST_NODE_TYPES.Identifier ? variableOf(node) : null;
				if (variable && plain.has(variable)) {
					writes.set(variable, [
						...(writes.get(variable) ?? []),
						{
							at,
							contentsOnly
						}
					]);
				}
			};

			const noteEdit = (edit: TSESTree.Node, container: TSESTree.Node): void => {
				let at = unwrap(container);
				let nested = false;
				while (at.type === AST_NODE_TYPES.MemberExpression) {
					at = unwrap(at.object);
					nested = true;
				}
				if (at.type !== AST_NODE_TYPES.Identifier) {
					return;
				}
				const variable = variableOf(at);
				const closing = (variable ? (writes.get(variable) ?? []) : []).filter(
					(write) => (nested || !write.contentsOnly) && editCanFollow(write.at, edit)
				);
				if (closing.length > 0) {
					context.report({
						node: edit,
						messageId: "noEditAfterWrite",
						data: {
							name: closing.some((write) => !write.contentsOnly) ? at.name : sourceCode.getText(container)
						}
					});
				}
			};

			const noteMemberEdit = (edit: TSESTree.Node, target: TSESTree.Node): void => {
				const member = unwrap(target);
				if (member.type === AST_NODE_TYPES.MemberExpression) {
					noteEdit(edit, member.object);
				}
			};

			const noteCall = (call: TSESTree.CallExpression): void => {
				const method = methodOf(call);
				if (!method) {
					return;
				}
				if (method.name !== null && ARRAY_EDITS.has(method.name)) {
					noteEdit(call, method.receiver);
				}
				const receiver = unwrap(method.receiver);
				if (method.name === "assign" && receiver.type === AST_NODE_TYPES.Identifier && receiver.name === "Object") {
					const [target, ...sources] = call.arguments;
					if (target) {
						noteEdit(call, target);
					}
					if (target && isLive(target)) {
						for (const source of sources) {
							noteWrite(source, call, true);
						}
					}
				}
				if (!isLive(method.receiver)) {
					return;
				}
				const written =
					method.name === "push" || method.name === "unshift" ? call.arguments : method.name === "splice" ? call.arguments.slice(2) : [];
				for (const argument of written) {
					noteWrite(argument, call, false);
				}
			};

			const after = (node: TSESTree.Node): void => {
				switch (node.type) {
					case AST_NODE_TYPES.VariableDeclarator:
						if (node.init) {
							bind(sourceCode.getDeclaredVariables(node), node.id.type === AST_NODE_TYPES.Identifier, node.init);
						}
						break;
					case AST_NODE_TYPES.AssignmentExpression: {
						noteMemberEdit(node, node.left);
						if (node.operator !== "=") {
							break;
						}
						const target = unwrap(node.left);
						if (target.type === AST_NODE_TYPES.Identifier) {
							const variable = variableOf(target);
							if (variable) {
								bind(
									[
										variable
									],
									true,
									node.right
								);
							}
						} else if (target.type === AST_NODE_TYPES.MemberExpression && isLive(target)) {
							noteWrite(node.right, node, false);
						}
						break;
					}
					case AST_NODE_TYPES.UpdateExpression:
						noteMemberEdit(node, node.argument);
						break;
					case AST_NODE_TYPES.UnaryExpression:
						if (node.operator === "delete") {
							noteMemberEdit(node, node.argument);
						}
						break;
					case AST_NODE_TYPES.CallExpression:
						noteCall(node);
						break;
				}
			};

			const walk = (node: TSESTree.Node): void => {
				if (
					node.type === AST_NODE_TYPES.FunctionDeclaration ||
					node.type === AST_NODE_TYPES.FunctionExpression ||
					node.type === AST_NODE_TYPES.ArrowFunctionExpression
				) {
					return;
				}
				if (node.type === AST_NODE_TYPES.Identifier) {
					const variable = variableOf(node);
					if (variable?.references.some((reference) => reference.identifier === node && reference.isWrite())) {
						live.delete(variable);
						plain.delete(variable);
						writes.delete(variable);
						untracked.add(variable);
					}
				}
				const children = node as unknown as Record<string, TSESTree.Node | (TSESTree.Node | null)[] | null | undefined>;
				for (const key of sourceCode.visitorKeys[node.type] ?? []) {
					const child = children[key];
					if (Array.isArray(child)) {
						for (const item of child) {
							if (item) {
								walk(item);
							}
						}
					} else if (child) {
						walk(child);
					}
				}
				after(node);
			};

			walk(fn.body);
		};

		return {
			FunctionDeclaration: check,
			FunctionExpression: check
		};
	}
});
