import type { IActionGenerator, IActionYield, IOpenGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { AnswerOutsideOwnerError, AskRefusedError } from "../../src/Runtime/askErrors";
import { BindAfterWriteError } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { DraftDetachedError, DraftInsideOpenError, EntityReplacedError, HandWrittenIdError } from "../../src/Runtime/draftNode";
import { SyncEffectPromiseError, SyncEffectWorkError } from "../../src/Runtime/effectDeclarations";
import { EntityGoneError } from "../../src/Runtime/entityGoneError";
import { REFUSAL_LIMIT } from "../../src/Runtime/fiberMachine";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open } from "../../src/Runtime/open";
import { ReconcileRowsKeyError, ReconcileRowsWaitError } from "../../src/Runtime/reconcileRows";
import { isRefusal, OutsideActionError, TreflexRefusal } from "../../src/Runtime/refusal";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { StateCycleError } from "../../src/Runtime/stateCycle";
import { MoveBetweenRootsError } from "../../src/Runtime/transient";
import { settled } from "../../src/Testing/createTestRuntime";

interface INode {
	Value: number;
}

interface ISub {
	$Id: string;
	Note: string;
}

interface IWorld {
	$Id: string;
	Node: INode;
	Copy: INode | null;
	Note: string;
	Sub: ISub;
}

function build() {
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Node: {
				Value: 1
			},
			Copy: null,
			Note: "",
			Sub: {
				$Id: "sub",
				Note: ""
			}
		},
		{
			onError: () => {},
			implementations: {
				echo: () => Promise.resolve("ok"),
				dated: () => Promise.resolve(new Date(0)),
				dispatchesChild: () => runtime.dispatch(child, "sub")
			}
		}
	);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	const swallowed = () => diags.filter((diag) => diag.code === "action/refusal-swallowed");
	return {
		runtime,
		diags,
		swallowed
	};
}

function* echo(): Generator<IActionYield, unknown, any> {
	return yield {
		Type: "echo"
	} as IActionYield;
}

function* writeInsideOpen(draft: { Note: string }): IOpenGenerator {
	yield* open(
		(function* (): IActionGenerator {
			yield* echo();
			draft.Note = "inside";
		})()
	);
}

function* child(draft: ISub): IOpenGenerator {
	yield* writeInsideOpen(draft);
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("action/refusal-swallowed", () => {
	it("reports a catch that swallows a refusal its own code met, once, naming the refusal and the action", async () => {
		const h = build();
		function* swallows(draft: IWorld): IOpenGenerator {
			try {
				yield* writeInsideOpen(draft);
			} catch {}
		}
		await h.runtime.dispatch(swallows, "root");
		const [diag, ...rest] = h.swallowed();
		expect(rest).toEqual([]);
		expect(diag!.data).toMatchObject({
			actionName: "swallows",
			entityId: "root",
			count: 1,
			refusal: {
				Name: "DraftInsideOpenError"
			}
		});
	});

	it("stays quiet when the catch rethrows the refusal", async () => {
		const h = build();
		function* rethrows(draft: IWorld): IOpenGenerator {
			try {
				yield* writeInsideOpen(draft);
			} catch (error) {
				if (isRefusal(error)) {
					throw error;
				}
			}
		}
		await expect(h.runtime.dispatch(rethrows, "root")).rejects.toBeInstanceOf(DraftInsideOpenError);
		expect(h.swallowed()).toEqual([]);
	});

	it("reports a refusal thrown in at a yield, for writes that broke the tree rule", async () => {
		const h = build();
		function* aliases(draft: IWorld): IActionGenerator {
			try {
				draft.Copy = draft.Node;
				yield* echo();
			} catch {}
		}
		await h.runtime.dispatch(aliases, "root");
		expect(
			h.swallowed().map(
				(diag) =>
					(
						diag.data!.refusal as {
							Name: string;
						}
					).Name
			)
		).toEqual([
			"StateAliasError"
		]);
	});

	it("stays quiet over a caught failure that depends on the data, such as a non-plain effect result", async () => {
		const h = build();
		let caught: unknown;
		function* reports(_draft: IWorld): IActionGenerator {
			try {
				yield {
					Type: "dated"
				} as IActionYield;
			} catch (error) {
				caught = error;
			}
		}
		await h.runtime.dispatch(reports, "root");
		expect(caught).toBeInstanceOf(NonPlainDataError);
		expect(h.swallowed()).toEqual([]);
	});

	it("reports a branch's refusal that parallel rethrows into the parent's broad catch", async () => {
		const h = build();
		function* fansOut(draft: IWorld): IActionGenerator {
			try {
				yield* parallel(
					(function* (): IActionGenerator {
						draft.Copy = draft.Node;
						yield* echo();
					})(),
					echo()
				);
			} catch {}
		}
		await h.runtime.dispatch(fansOut, "root");
		expect(h.swallowed()).toHaveLength(1);
	});

	it("reports a refusal parallelSettled hands back that the action ignores", async () => {
		const h = build();
		function* settles(draft: IWorld): IActionGenerator {
			yield* parallelSettled(
				(function* (): IActionGenerator {
					draft.Copy = draft.Node;
					yield* echo();
				})()
			);
		}
		await h.runtime.dispatch(settles, "root");
		expect(h.swallowed()).toHaveLength(1);
	});

	it("leaves another action's refusal to that action, which ended with it", async () => {
		const h = build();
		let caught: unknown;
		function* parent(_draft: IWorld): IActionGenerator {
			try {
				yield {
					Type: "dispatchesChild"
				} as IActionYield;
			} catch (error) {
				caught = error;
			}
		}
		await h.runtime.dispatch(parent, "root");
		await settled();
		expect(caught).toBeInstanceOf(DraftInsideOpenError);
		expect(h.swallowed()).toEqual([]);
	});

	it("is raised beside action/refusal-loop by a catch that retries the refused writes", async () => {
		const h = build();
		const error = await h.runtime
			.dispatch(function* retries(draft: IWorld): IActionGenerator {
				while (true) {
					draft.Copy = draft.Node;
					try {
						yield* echo();
						return;
					} catch {}
				}
			}, "root")
			.then(
				() => undefined,
				(thrown: unknown) => thrown
			);
		expect(error).toBeInstanceOf(StateAliasError);
		expect(h.diags.filter((diag) => diag.code === "action/refusal-loop")).toHaveLength(1);
		expect(h.swallowed().map((diag) => diag.data!.count)).toEqual([
			REFUSAL_LIMIT
		]);
	});
});

describe("which errors are refusals", () => {
	it("counts a rule the code broke, whatever the data", () => {
		const refusals: unknown[] = [
			new DraftInsideOpenError("a"),
			new EntityReplacedError("id", []),
			new HandWrittenIdError("id", "problem"),
			new BindAfterWriteError("bind", "id"),
			new StateAliasError([], [], 0, ""),
			new StateCycleError([], [], 0, ""),
			new MoveBetweenRootsError(
				[
					"AppState"
				],
				[
					"TransientState"
				]
			),
			new AskRefusedError("outside-open", "a", "e", "o"),
			new AnswerOutsideOwnerError("o", "a"),
			new SyncEffectPromiseError("t"),
			new SyncEffectWorkError("t", "dispatched"),
			new ReconcileRowsWaitError("add", "a wait"),
			new OutsideActionError("open"),
			new TreflexRefusal("plain")
		];
		expect(refusals.filter((error) => !isRefusal(error))).toEqual([]);
	});

	it("leaves out what depends on the data, what a caller may expect, and what isn't an error of treflex's", () => {
		const others: unknown[] = [
			new DraftDetachedError("gone"),
			new EntityGoneError("id", "gone"),
			new NonPlainDataError("x", "a Date", []),
			new ReconcileRowsKeyError("two rows share a key."),
			new TypeError("Failed to fetch"),
			new Error("boom"),
			{
				Thrown: "value"
			},
			null
		];
		expect(others.filter(isRefusal)).toEqual([]);
	});
});
