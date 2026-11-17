import type { IBranchOutcome } from "../../src/Effects/parallelSettled";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it, vi } from "vitest";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";

interface IWorld {
	$Id: string;
	Log: string[];
	Child: {
		$Id: string;
		Log: string[];
	} | null;
}

function gated() {
	const gates = new Map<string, (value: unknown) => void>();
	return {
		gates,
		implementation: (effect: any) =>
			new Promise((resolve) => {
				gates.set(effect.Name, resolve);
			})
	};
}

function* wait(name: string): Generator<any, any, any> {
	return yield {
		Type: "gate",
		Name: name
	};
}

function* failNow(message: string): Generator<any, never, any> {
	throw new Error(message);
}

function* failAfter(name: string, message: string): Generator<any, never, any> {
	yield* wait(name);
	throw new Error(message);
}

function build(onError: (error: unknown) => void = () => {}) {
	const { gates, implementation } = gated();
	const records: IRecord[] = [];
	const escalated: unknown[] = [];
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Log: [],
			Child: {
				$Id: "child",
				Log: []
			}
		},
		{
			onError,
			implementations: {
				gate: implementation
			}
		}
	);
	runtime.on("record", (record) => records.push(record));
	const Errors = receiver<IWorld>("SettledErrors")({
		*"Action/Error"(_draft, message) {
			escalated.push(message);
		}
	});
	runtime.registerReceiver(Errors);
	return {
		runtime,
		gates,
		records,
		escalated,
		listen: () =>
			runtime.dispatch(function* listen(draft: IWorld): IActionGenerator {
				bind(draft, Errors);
			}, "root")
	};
}

const tick = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});

describe("parallelSettled", () => {
	it("lets every branch finish and hands back each value or error, in input order", async () => {
		const h = build();
		let outcomes!: [
			IBranchOutcome<string>,
			IBranchOutcome<never>,
			IBranchOutcome<number>
		];
		function* root(): IActionGenerator {
			outcomes = yield* parallelSettled(
				(function* (): Generator<any, string, any> {
					yield* wait("slow");
					return "read";
				})(),
				failAfter("failing", "boom"),
				(function* (): Generator<any, number, any> {
					return 7;
				})()
			);
		}
		const run = h.runtime.dispatch(root, "root");
		await tick();
		h.gates.get("failing")!(undefined);
		await tick();
		expect(outcomes).toBeUndefined();
		h.gates.get("slow")!(undefined);
		await run;

		expect(outcomes[0]).toEqual({
			ok: true,
			value: "read"
		});
		expect(outcomes[1].ok).toBe(false);
		expect(
			(
				outcomes[1] as {
					error: Error;
				}
			).error.message
		).toBe("boom");
		expect(outcomes[2]).toEqual({
			ok: true,
			value: 7
		});
	});

	it("does not stop a sibling when a branch fails, so its later writes land", async () => {
		const h = build();
		function* sibling(draft: IWorld): Generator<any, void, any> {
			yield* wait("sibling");
			draft.Log.push("sibling wrote");
		}
		function* root(draft: IWorld): IActionGenerator {
			yield* parallelSettled(failNow("boom"), sibling(draft));
		}
		const run = h.runtime.dispatch(root, "root");
		await tick();
		h.gates.get("sibling")!(undefined);
		await run;
		expect(h.runtime.state.Log).toEqual([
			"sibling wrote"
		]);
	});

	it("keeps a branch's failure off the route, unless the action rethrows it", async () => {
		const onError = vi.fn();
		const h = build(onError);
		await h.listen();
		function* swallows(): IActionGenerator {
			yield* parallelSettled(failNow("swallowed"), failAfter("late", "swallowed too"));
		}
		const run = h.runtime.dispatch(swallows, "child");
		await tick();
		h.gates.get("late")!(undefined);
		await run;
		await tick();
		expect(h.escalated).toEqual([]);
		expect(onError).not.toHaveBeenCalled();

		function* rethrows(): IActionGenerator {
			const [outcome] = yield* parallelSettled(failNow("rethrown"), failNow("not this one"));
			if (!outcome.ok) {
				throw outcome.error;
			}
		}
		await expect(h.runtime.dispatch(rethrows, "child")).rejects.toThrow("rethrown");
		await tick();
		expect(h.escalated).toHaveLength(1);
		expect(onError).not.toHaveBeenCalled();
	});

	it("stops its branches when the branch parked on it stops", async () => {
		const h = build();
		function* branch(
			draft: {
				$Id: string;
				Log: string[];
			},
			name: string
		): Generator<any, void, any> {
			try {
				yield* wait(name);
				draft.Log.push(`${name} resumed`);
			} finally {
				draft.Log.push(`${name} finally`);
			}
		}
		function* onChild(draft: { $Id: string; Log: string[] }): IActionGenerator {
			yield* parallelSettled(branch(draft, "one"), branch(draft, "two"));
			draft.Log.push("resumed");
		}
		const run = h.runtime.dispatch(onChild, "child");
		await tick();
		await h.runtime.dispatch(function* drop(draft: IWorld): IActionGenerator {
			draft.Child = null;
		}, "root");
		await run;
		await tick();

		expect(
			h.records
				.filter((r) => r.Kind === "branch:end")
				.map(
					(r) =>
						(
							r as {
								Status: string;
							}
						).Status
				)
		).toEqual([
			"cancelled",
			"cancelled"
		]);
		h.gates.get("one")!(undefined);
		await tick();
		expect(h.records.some((r) => r.Kind === "step" && r.Changes.some((c) => c.Value === "resumed"))).toBe(false);
	});

	it("journals the branch count on the effect and a plain-data outcome per branch on the response", async () => {
		const h = build();
		function* root(): IActionGenerator {
			yield* parallelSettled(
				(function* (): Generator<any, string, any> {
					return "value";
				})(),
				(function* (): Generator<any, void, any> {})(),
				failNow("boom")
			);
		}
		await h.runtime.dispatch(root, "root");
		const effect = h.records.find((r) => r.Kind === "effect" && r.Type === "parallelSettled") as any;
		expect(effect.Descriptor).toEqual({
			Type: "parallelSettled",
			Branches: 3
		});
		const response = h.records.find((r) => r.Kind === "response" && r.ForSeq === effect.Seq) as any;
		expect(response.Value).toEqual([
			{
				Ok: true,
				Value: "value"
			},
			{
				Ok: true
			},
			{
				Ok: false,
				Error: expect.objectContaining({
					Message: "boom"
				})
			}
		]);
		const complete = h.records.filter((r) => r.Kind === "branch:end" && r.Status === "errored") as any[];
		expect(complete).toHaveLength(1);
		expect(complete[0].Error).toEqual(
			expect.objectContaining({
				Message: "boom"
			})
		);
	});

	it("a failure before the first yield is an outcome, not an unhandled rejection", async () => {
		const h = build();
		let outcomes!: IBranchOutcome<unknown>[];
		function* root(): IActionGenerator {
			outcomes = yield* parallelSettled(failNow("at once"));
		}
		await h.runtime.dispatch(root, "root");
		expect(outcomes[0].ok).toBe(false);
	});
});
