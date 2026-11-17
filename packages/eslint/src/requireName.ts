import type ts from "typescript";
import { ESLintUtils } from "@typescript-eslint/utils";
import { actionUses, createNamer } from "./naming";

export type IRequireNameMessageId = "unnamed";

export const requireName = ESLintUtils.RuleCreator.withoutDocs<[], IRequireNameMessageId>({
	meta: {
		type: "problem",
		fixable: "code",
		docs: {
			description: "Require a durable name on every action passed to start, dispatch, an arrival mark, a work tag or a feature"
		},
		schema: [],
		messages: {
			unnamed:
				'Action "{{label}}" has no durable name, so a runtime with requireNames refuses it in development. Name it with named({{label}}, "Feature/Action") after its declaration, in its own module, or run `npx treflex-eslint name`, which names the unnamed actions it can find in the project.'
		}
	},
	defaultOptions: [],
	create(context) {
		const services = ESLintUtils.getParserServices(context);
		const checker = services.program.getTypeChecker();
		const namer = createNamer(checker);
		const linted = services.esTreeNodeToTSNodeMap.get(context.sourceCode.ast).getSourceFile();
		const taken = (name: string) => namer.namesIn(linted).names.has(name);
		const loc = (node: ts.Node) => ({
			start: context.sourceCode.getLocFromIndex(node.getStart(linted)),
			end: context.sourceCode.getLocFromIndex(node.end)
		});

		return {
			CallExpression(node) {
				for (const use of actionUses(checker, services.esTreeNodeToTSNodeMap.get(node))) {
					if (use.symbol === undefined) {
						context.report({
							loc: loc(use.node),
							messageId: "unnamed",
							data: {
								label: use.label
							}
						});
						continue;
					}
					const action = namer.unnamed(use.symbol);
					if (action === null) {
						continue;
					}
					const plan = action.file === linted && namer.namesIn(linted).unreadable.length === 0 ? namer.plan(action, taken) : null;
					context.report({
						loc: loc(use.node),
						messageId: "unnamed",
						data: {
							label: action.label
						},
						fix:
							plan === null || !("mark" in plan)
								? null
								: (fixer) =>
										[
											plan.import,
											plan.mark
										]
											.filter((insertion) => insertion !== null)
											.map((insertion) =>
												fixer.insertTextAfterRange(
													[
														insertion.at,
														insertion.at
													],
													insertion.text
												)
											)
					});
				}
			}
		};
	}
});
