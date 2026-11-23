import { AST_NODE_TYPES, ASTUtils, ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { calledAs, calleeName, importSource, LIFECYCLE_CALLS } from "./callsByName";
import { type IResolutions, importsComponentFeature } from "./componentFeatureModules";

export type INoMainStateInLifecycleMessageId = "noMainStateInLifecycle" | "reasonRequired";

interface IDisableDirective {
	type: "disable" | "enable" | "disable-line" | "disable-next-line";
	value: string;
	justification: string;
	node: {
		loc: TSESTree.SourceLocation;
	};
}

interface IDirectiveSource {
	getDisableDirectives(): {
		directives: IDisableDirective[];
	};
}

type IFunction = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression | TSESTree.FunctionDeclaration;

type IScope = Parameters<typeof ASTUtils.findVariable>[0];

type ISite =
	| {
			kind: "lifecycle";
			where: string;
			returnsUsed?: boolean;
			returnsCleanup?: boolean;
	  }
	| {
			kind: "runs";
			at: TSESTree.CallExpression;
			returns: boolean;
	  }
	| {
			kind: "deferred";
			at: TSESTree.CallExpression;
			as?: string;
	  }
	| {
			kind: "event";
	  };

const CLEANUP_RETURNING = new Set([
	"useEffect",
	"useLayoutEffect",
	"createTrackedEffect",
	"createReaction"
]);
const SPLIT_EFFECTS = new Set([
	"createEffect",
	"createRenderEffect"
]);
const BUNDLE_TAKERS = new Set([
	"createEffect",
	"createRenderEffect",
	"createReaction"
]);
const SETTLED = new Set([
	"onSettled",
	"onFlush"
]);
const TIMERS = new Set([
	"setTimeout",
	"setInterval",
	"queueMicrotask",
	"requestAnimationFrame",
	"requestIdleCallback"
]);
const RUNNERS_RETURNING = new Set([
	"untrack",
	"batch"
]);
const RUNNERS_VOID = new Set([
	"startTransition"
]);
const CALLBACK_WRAPPERS = new Set([
	"useCallback",
	"useEffectEvent"
]);
const CONTINUATIONS = new Set([
	"then",
	"catch",
	"finally"
]);
const COMPONENT_FEATURE = new Set([
	"createComponentFeature"
]);
const DISPATCH = new Set([
	"useDispatch"
]);
const REDUX = new Set([
	"react-redux",
	"@reduxjs/toolkit"
]);
const ON = new Set([
	"on"
]);
const TRANSITION = new Set([
	"useTransition"
]);
const MEMO = new Set([
	"createMemo",
	"useMemo"
]);
const BODY = "the component's body";
const MAX_ALIASES = 16;

const WRAPPERS = new Set<string>([
	AST_NODE_TYPES.TSAsExpression,
	AST_NODE_TYPES.TSNonNullExpression,
	AST_NODE_TYPES.TSSatisfiesExpression,
	AST_NODE_TYPES.TSTypeAssertion,
	AST_NODE_TYPES.ChainExpression
]);

function unwrap(node: TSESTree.Node): TSESTree.Node {
	let current = node;
	while (WRAPPERS.has(current.type)) {
		current = (current as TSESTree.TSAsExpression).expression;
	}
	return current;
}

function isFunction(node: TSESTree.Node): node is IFunction {
	return (
		node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
		node.type === AST_NODE_TYPES.FunctionExpression ||
		node.type === AST_NODE_TYPES.FunctionDeclaration
	);
}

function enclosingFunction(node: TSESTree.Node): IFunction | undefined {
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (isFunction(parent)) {
			return parent;
		}
	}
	return undefined;
}

function memberName(node: TSESTree.MemberExpression): string | undefined {
	if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
		return node.property.name;
	}
	if (node.computed && node.property.type === AST_NODE_TYPES.Literal && typeof node.property.value === "string") {
		return node.property.value;
	}
	return undefined;
}

function asNamed(found: ISite, where: string | undefined): string | undefined {
	return found.kind === "deferred" && found.as && where === BODY ? found.as : where;
}

export const noMainStateInLifecycle = ESLintUtils.RuleCreator.withoutDocs<[], INoMainStateInLifecycleMessageId>({
	meta: {
		type: "problem",
		docs: {
			description:
				"Report a component starting main-state work from its lifecycle: a mount, an effect, a cleanup, or a timer one of them or the component's body sets"
		},
		schema: [],
		messages: {
			noMainStateInLifecycle:
				"This starts main-state work from {{where}}, so it runs again at every mount, a restore's included, and never in a test without views. Start the action from the event behind it: a handler, a receiver, the action that opens the screen, or the action that writes what this watches. Disable this only for work no event stands behind, caused by what is on screen and safe to start at every mount (an action that checks state, marked leading, or latest when keyed on what it loads), or for state that is the component's own where this rule can't see it, such as a component feature it can't read; give that reason, on the line above this call: // eslint-disable-next-line {{rule}} -- <reason>",
			reasonRequired:
				"This turns {{rule}} off with no reason, so it doesn't count. Say after ' -- ' why no event stands behind the work, or why its state is the component's own: // eslint-disable-next-line {{rule}} -- <reason>. Only a reason after the dashes counts, not a comment on the line above."
		}
	},
	defaultOptions: [],
	create(context) {
		const scopeOf = (node: TSESTree.Node): IScope => context.sourceCode.getScope(node);
		const isNamed = (callee: TSESTree.Node, names: Set<string>): string | undefined => calledAs(callee, names, scopeOf);
		const resolutions: IResolutions = new Map();

		function declaratorOf(id: TSESTree.Identifier): TSESTree.VariableDeclarator | undefined {
			const variable = ASTUtils.findVariable(scopeOf(id), id.name);
			const definition = variable?.defs[0];
			if (variable?.defs.length !== 1 || definition?.type !== "Variable") {
				return undefined;
			}
			if (definition.parent.kind !== "const" && variable.references.filter((reference) => reference.isWrite()).length > 1) {
				return undefined;
			}
			return definition.node;
		}

		function readsOf(variable: ReturnType<typeof ASTUtils.findVariable>): TSESTree.Node[] {
			return (variable?.references ?? []).filter((reference) => reference.isRead()).map((reference) => reference.identifier);
		}

		function isComponentFeature(node: TSESTree.Node, depth: number): boolean {
			const target = unwrap(node);
			if (target.type !== AST_NODE_TYPES.Identifier || depth > MAX_ALIASES) {
				return false;
			}
			const definition = ASTUtils.findVariable(scopeOf(target), target.name)?.defs[0];
			if (definition?.type === "ImportBinding") {
				const imported =
					definition.node.type === AST_NODE_TYPES.ImportDefaultSpecifier
						? "default"
						: definition.node.type === AST_NODE_TYPES.ImportSpecifier && definition.node.imported.type === AST_NODE_TYPES.Identifier
							? definition.node.imported.name
							: undefined;
				const source = importSource(definition.parent);
				return imported !== undefined && source !== undefined && importsComponentFeature(context.filename, source, imported, resolutions);
			}
			const init = declaratorOf(target)?.init;
			if (!init) {
				return false;
			}
			const value = unwrap(init);
			if (value.type === AST_NODE_TYPES.Identifier) {
				return isComponentFeature(value, depth + 1);
			}
			if (value.type !== AST_NODE_TYPES.CallExpression) {
				return false;
			}
			const factory = unwrap(value.callee);
			return factory.type === AST_NODE_TYPES.CallExpression && isNamed(factory.callee, COMPONENT_FEATURE) !== undefined;
		}

		function handleOf(node: TSESTree.Node, kind: "feature" | "dispatch", depth = 0): TSESTree.CallExpression | undefined {
			const value = unwrap(node);
			if (depth > MAX_ALIASES) {
				return undefined;
			}
			if (value.type === AST_NODE_TYPES.CallExpression) {
				if (kind === "dispatch") {
					const found = calleeName(value.callee, scopeOf);
					return found && !found.viaGlobalObject && DISPATCH.has(found.name) && !REDUX.has(found.source ?? "") ? value : undefined;
				}
				const callee = unwrap(value.callee);
				if (
					value.arguments.length === 0 &&
					callee.type === AST_NODE_TYPES.MemberExpression &&
					memberName(callee) === "use" &&
					!isComponentFeature(callee.object, 0)
				) {
					return value;
				}
				return undefined;
			}
			if (value.type !== AST_NODE_TYPES.Identifier) {
				return undefined;
			}
			const declarator = declaratorOf(value);
			if (declarator?.init && declarator.id.type === AST_NODE_TYPES.Identifier) {
				return handleOf(declarator.init, kind, depth + 1);
			}
			return undefined;
		}

		function methodOf(id: TSESTree.Identifier, depth = 0): TSESTree.CallExpression | undefined {
			const declarator = declaratorOf(id);
			if (!declarator?.init || depth > MAX_ALIASES) {
				return undefined;
			}
			if (declarator.id.type === AST_NODE_TYPES.Identifier) {
				const init = unwrap(declarator.init);
				if (init.type === AST_NODE_TYPES.MemberExpression && memberName(init) !== undefined) {
					return handleOf(init.object, "feature");
				}
				if (init.type === AST_NODE_TYPES.Identifier) {
					return methodOf(init, depth + 1);
				}
				return undefined;
			}
			if (declarator.id.type !== AST_NODE_TYPES.ObjectPattern) {
				return undefined;
			}
			const binding = ASTUtils.findVariable(scopeOf(id), id.name)?.defs[0]?.name;
			let property: TSESTree.Node | undefined = binding?.parent;
			if (property?.type === AST_NODE_TYPES.AssignmentPattern) {
				property = property.parent;
			}
			if (property?.type !== AST_NODE_TYPES.Property || property.parent !== declarator.id) {
				return undefined;
			}
			return handleOf(declarator.init, "feature");
		}

		function originOf(call: TSESTree.CallExpression): TSESTree.CallExpression | undefined {
			const callee = unwrap(call.callee);
			if (callee.type === AST_NODE_TYPES.MemberExpression) {
				return memberName(callee) === undefined ? undefined : handleOf(callee.object, "feature");
			}
			if (callee.type === AST_NODE_TYPES.Identifier) {
				return handleOf(callee, "dispatch") ?? methodOf(callee);
			}
			if (callee.type === AST_NODE_TYPES.CallExpression) {
				return handleOf(callee, "dispatch");
			}
			return undefined;
		}

		function sitesOf(fn: IFunction): TSESTree.Node[] {
			if (fn.type === AST_NODE_TYPES.FunctionDeclaration) {
				const upper = scopeOf(fn).upper;
				return fn.id && upper ? readsOf(ASTUtils.findVariable(upper, fn.id.name)) : [];
			}
			const parent = fn.parent;
			if (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.init === fn && parent.id.type === AST_NODE_TYPES.Identifier) {
				return declaratorOf(parent.id) ? readsOf(ASTUtils.findVariable(scopeOf(parent.id), parent.id.name)) : [];
			}
			if (
				parent.type === AST_NODE_TYPES.CallExpression &&
				parent.arguments[0] === fn &&
				isNamed(parent.callee, CALLBACK_WRAPPERS) &&
				parent.parent.type === AST_NODE_TYPES.VariableDeclarator &&
				parent.parent.init === parent &&
				parent.parent.id.type === AST_NODE_TYPES.Identifier
			) {
				const id = parent.parent.id;
				return declaratorOf(id) ? readsOf(ASTUtils.findVariable(scopeOf(id), id.name)) : [];
			}
			return [
				fn
			];
		}

		function isTransitionStart(callee: TSESTree.Node): boolean {
			if (callee.type !== AST_NODE_TYPES.Identifier) {
				return false;
			}
			const declarator = declaratorOf(callee);
			if (
				declarator?.id.type !== AST_NODE_TYPES.ArrayPattern ||
				declarator.id.elements[1] !== ASTUtils.findVariable(scopeOf(callee), callee.name)?.defs[0]?.name
			) {
				return false;
			}
			const init = declarator.init && unwrap(declarator.init);
			return init?.type === AST_NODE_TYPES.CallExpression && isNamed(init.callee, TRANSITION) !== undefined;
		}

		function classifyCall(site: TSESTree.Node): ISite {
			const call = site.parent;
			if (
				isFunction(site) &&
				call?.type === AST_NODE_TYPES.JSXExpressionContainer &&
				(call.parent.type === AST_NODE_TYPES.JSXElement || call.parent.type === AST_NODE_TYPES.JSXFragment)
			) {
				return {
					kind: "lifecycle",
					where: "a render callback",
					returnsUsed: true
				};
			}
			if (
				call?.type === AST_NODE_TYPES.Property &&
				call.value === site &&
				!call.computed &&
				call.key.type === AST_NODE_TYPES.Identifier &&
				(call.key.name === "effect" || call.key.name === "error") &&
				call.parent.type === AST_NODE_TYPES.ObjectExpression &&
				call.parent.parent.type === AST_NODE_TYPES.CallExpression
			) {
				const host = call.parent.parent;
				const taker = isNamed(host.callee, BUNDLE_TAKERS);
				const at = host.arguments.indexOf(call.parent);
				if (taker && at === (taker === "createReaction" ? 0 : 1)) {
					return {
						kind: "lifecycle",
						where: taker,
						returnsCleanup: call.key.name === "effect"
					};
				}
			}
			if (call?.type !== AST_NODE_TYPES.CallExpression) {
				return {
					kind: "event"
				};
			}
			if (call.callee === site) {
				return {
					kind: "runs",
					at: call,
					returns: true
				};
			}
			const index = call.arguments.indexOf(site as TSESTree.CallExpressionArgument);
			const split = isNamed(call.callee, SPLIT_EFFECTS);
			const second = call.arguments[1] && unwrap(call.arguments[1]);
			// Solid 1.9's createEffect(fn, initialValue): its second argument is a value, not an effect function.
			const initialValue =
				second?.type === AST_NODE_TYPES.Literal ||
				(second?.type === AST_NODE_TYPES.Identifier &&
					second.name === "undefined" &&
					!ASTUtils.findVariable(scopeOf(second), "undefined")?.defs.length);
			if (split && second && !initialValue && (index === 0 || index === 1)) {
				return index === 0
					? {
							kind: "lifecycle",
							where: split,
							returnsUsed: true
						}
					: {
							kind: "lifecycle",
							where: split,
							returnsCleanup: true
						};
			}
			const lifecycle = isNamed(call.callee, LIFECYCLE_CALLS);
			if (lifecycle && index === 0) {
				return {
					kind: "lifecycle",
					where: lifecycle,
					returnsCleanup: CLEANUP_RETURNING.has(lifecycle)
				};
			}
			const settled = isNamed(call.callee, SETTLED);
			if (settled && index === 0) {
				return {
					kind: "deferred",
					at: call,
					...(settled === "onSettled"
						? {
								as: settled
							}
						: {})
				};
			}
			const memo = isNamed(call.callee, MEMO);
			if (memo && index === 0) {
				return {
					kind: "lifecycle",
					where: memo,
					returnsUsed: true
				};
			}
			const outer = call.parent;
			if (index === 1 && isNamed(call.callee, ON) && outer?.type === AST_NODE_TYPES.CallExpression && outer.arguments[0] === call) {
				const wrapping = isNamed(outer.callee, LIFECYCLE_CALLS);
				if (wrapping) {
					return {
						kind: "lifecycle",
						where: wrapping
					};
				}
				const wrappingMemo = isNamed(outer.callee, MEMO);
				if (wrappingMemo) {
					return {
						kind: "lifecycle",
						where: wrappingMemo,
						returnsUsed: true
					};
				}
			}
			if (index === 0 && TIMERS.has(calleeName(call.callee, scopeOf)?.name ?? "")) {
				return {
					kind: "deferred",
					at: call
				};
			}
			if (index === 0 && isNamed(call.callee, RUNNERS_RETURNING)) {
				return {
					kind: "runs",
					at: call,
					returns: true
				};
			}
			if (index === 0 && (isNamed(call.callee, RUNNERS_VOID) || isTransitionStart(call.callee))) {
				return {
					kind: "runs",
					at: call,
					returns: false
				};
			}
			const callee = unwrap(call.callee);
			if (callee.type === AST_NODE_TYPES.MemberExpression) {
				const method = memberName(callee);
				if (method !== undefined && CONTINUATIONS.has(method)) {
					return {
						kind: "deferred",
						at: call
					};
				}
				if ((method === "forEach" || method === "map") && index === 0) {
					return {
						kind: "runs",
						at: call,
						returns: method === "map"
					};
				}
			}
			return {
				kind: "event"
			};
		}

		function returnedBy(site: TSESTree.Node): IFunction | undefined {
			const parent = site.parent;
			if (parent?.type === AST_NODE_TYPES.ArrowFunctionExpression && parent.body === site) {
				return parent;
			}
			if (parent?.type === AST_NODE_TYPES.ReturnStatement && parent.argument === site) {
				return enclosingFunction(parent);
			}
			return undefined;
		}

		function classify(site: TSESTree.Node): ISite {
			const effect = returnedBy(site);
			if (effect) {
				for (const effectSite of sitesOf(effect)) {
					const found = classifyCall(effectSite);
					if (found.kind === "lifecycle" && found.returnsCleanup) {
						return {
							kind: "lifecycle",
							where: `${found.where}'s cleanup`
						};
					}
					if (found.kind === "deferred" && found.as === "onSettled") {
						return {
							kind: "deferred",
							at: found.at,
							as: "onSettled's cleanup"
						};
					}
				}
				return {
					kind: "event"
				};
			}
			return classifyCall(site);
		}

		function startOf(fn: IFunction | undefined, body: IFunction | undefined, seen: Set<IFunction>): string | undefined {
			if (!fn) {
				return undefined;
			}
			if (seen.has(fn)) {
				return undefined;
			}
			seen.add(fn);
			for (const site of sitesOf(fn)) {
				const found = classify(site);
				if (found.kind === "lifecycle") {
					return found.where;
				}
				if (found.kind !== "event" && fn !== body) {
					const where = asNamed(found, startOf(enclosingFunction(found.at), body, seen));
					if (where) {
						return where;
					}
				}
			}
			return fn === body ? BODY : undefined;
		}

		function flowOf(node: TSESTree.Node, body: IFunction | undefined, seen: Set<IFunction>): string | undefined {
			let current = node;
			for (;;) {
				const parent = current.parent;
				if (!parent) {
					return undefined;
				}
				if (WRAPPERS.has(parent.type)) {
					current = parent;
					continue;
				}
				if (
					(parent.type === AST_NODE_TYPES.LogicalExpression && parent.right === current) ||
					(parent.type === AST_NODE_TYPES.ConditionalExpression && parent.test !== current) ||
					(parent.type === AST_NODE_TYPES.SequenceExpression && parent.expressions.at(-1) === current)
				) {
					current = parent;
					continue;
				}
				const discarded =
					parent.type === AST_NODE_TYPES.ExpressionStatement ||
					parent.type === AST_NODE_TYPES.AwaitExpression ||
					parent.type === AST_NODE_TYPES.SequenceExpression ||
					(parent.type === AST_NODE_TYPES.UnaryExpression && parent.operator === "void") ||
					(parent.type === AST_NODE_TYPES.MemberExpression &&
						parent.object === current &&
						CONTINUATIONS.has(memberName(parent) ?? "") &&
						parent.parent.type === AST_NODE_TYPES.CallExpression &&
						parent.parent.callee === parent);
				if (discarded) {
					return startOf(enclosingFunction(node), body, new Set());
				}
				const returner = returnedBy(current);
				if (!returner || seen.has(returner)) {
					return undefined;
				}
				seen.add(returner);
				for (const site of sitesOf(returner)) {
					const found = classify(site);
					let where: string | undefined;
					if (found.kind === "lifecycle") {
						where = found.returnsUsed ? undefined : found.where;
					} else if (found.kind === "runs" && found.returns) {
						where = flowOf(found.at, body, seen);
					} else if (found.kind !== "event") {
						where = asNamed(found, startOf(enclosingFunction(found.at), body, new Set()));
					}
					if (where) {
						return where;
					}
				}
				return undefined;
			}
		}

		function referenceOrigin(node: TSESTree.Node): TSESTree.CallExpression | undefined {
			const value = unwrap(node);
			if (value.type === AST_NODE_TYPES.MemberExpression) {
				const name = memberName(value);
				return name === undefined || name === "state" ? undefined : handleOf(value.object, "feature");
			}
			if (value.type === AST_NODE_TYPES.Identifier) {
				return handleOf(value, "dispatch") ?? methodOf(value);
			}
			return undefined;
		}

		function passedStart(argument: TSESTree.Node, body: IFunction | undefined): string | undefined {
			const found = classify(argument);
			if (found.kind === "lifecycle") {
				return found.returnsUsed ? undefined : found.where;
			}
			if (found.kind === "runs" && found.returns) {
				return flowOf(found.at, body, new Set());
			}
			return found.kind === "event" ? undefined : asNamed(found, startOf(enclosingFunction(found.at), body, new Set()));
		}

		const siteLines = new Set<number>();

		function report(node: TSESTree.Node, where: string | undefined): void {
			if (where) {
				siteLines.add(node.loc.start.line);
				context.report({
					node,
					messageId: "noMainStateInLifecycle",
					data: {
						where,
						rule: context.id
					}
				});
			}
		}

		function lineCovered(directive: IDisableDirective): number | undefined {
			if (directive.type === "disable-line") {
				return directive.node.loc.start.line;
			}
			return directive.type === "disable-next-line" ? directive.node.loc.end.line + 1 : undefined;
		}

		function needsReason(directive: IDisableDirective): boolean {
			if (directive.type === "enable" || directive.justification.trim() !== "") {
				return false;
			}
			const named = directive.value.split(/[\s,]+/).filter((name) => name !== "" && !name.startsWith("--"));
			if (named.includes(context.id)) {
				return true;
			}
			const line = lineCovered(directive);
			return named.length === 0 && line !== undefined && siteLines.has(line);
		}

		function reportReason(directive: IDisableDirective): void {
			const line = directive.node.loc.start.line;
			const descriptor = {
				messageId: "reasonRequired" as const,
				data: {
					rule: context.id
				}
			};
			try {
				context.report({
					...descriptor,
					loc: {
						line,
						column: -1
					}
				});
			} catch {
				context.report({
					...descriptor,
					loc: {
						line,
						column: 0
					}
				});
			}
		}

		function reportReturnedCleanup(returned: TSESTree.Node | null | undefined): void {
			const origin = returned && referenceOrigin(returned);
			if (returned && origin) {
				report(returned, passedStart(returned, enclosingFunction(origin)));
			}
		}

		return {
			"Program:exit"() {
				for (const directive of (context.sourceCode as unknown as IDirectiveSource).getDisableDirectives().directives) {
					if (needsReason(directive)) {
						reportReason(directive);
					}
				}
			},
			ArrowFunctionExpression(node) {
				if (node.expression) {
					reportReturnedCleanup(node.body);
				}
			},
			ReturnStatement(node) {
				reportReturnedCleanup(node.argument);
			},
			CallExpression(node) {
				const origin = originOf(node);
				if (origin) {
					report(node, flowOf(node, enclosingFunction(origin), new Set()));
				}
				for (const argument of node.arguments) {
					const passed = referenceOrigin(argument);
					if (passed) {
						report(argument, passedStart(argument, enclosingFunction(passed)));
					}
				}
			}
		};
	}
});
