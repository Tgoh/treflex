import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator, IActionYield, IOpenGenerator } from "../../src/Types/IAction";
import type { IActionContext } from "../../src/Types/IActionContext";
import type { IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineEffect, implementation } from "../../src/Effects/defineEffect";
import { openResource } from "../../src/Effects/openResource";
import { parallel } from "../../src/Effects/parallel";
import { resource } from "../../src/Effects/resource";
import { start } from "../../src/Effects/start";
import { external } from "../../src/Reads/external";
import { bind } from "../../src/Runtime/bind";
import { createActivityLog, type IActivityLogEntry } from "../../src/Runtime/createActivityLog";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { treeWrite } from "../testHelpers";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"FiberEnds/Removed": {};
	}
}

type IRow = {
	$Id: string;
	Name: string;
	Cleaned?: boolean;
	Resumed?: boolean;
	Note?: string;
};

type IWorld = {
	$Id: string;
	Rows: IRow[];
};

type IDeferred = {
	open: (value?: unknown) => void;
	fail: (error: unknown) => void;
	signal: AbortSignal;
};

const seed = (): IWorld => ({
	$Id: "root",
	Rows: [
		{
			$Id: "row-1",
			Name: "one"
		}
	]
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function* gate(name: string): Generator<IActionYield, any, any> {
	return yield {
		Type: "gate",
		Name: name
	} as IActionYield;
}

interface IStampEffect {
	Type: "fiberEnds/stamp";
	Text: string;
}
const stamp = defineEffect<IStampEffect, void>("fiberEnds/stamp", {
	settles: "sync"
});

const secret = defineEffect<
	{
		Type: "fiberEnds/secret";
	},
	void
>("fiberEnds/secret", {
	redact: true
});

async function build(verifyIndex?: "always") {
	const gates: Record<string, IDeferred> = {};
	const log: string[] = [];
	const errors: unknown[] = [];
	const signals: AbortSignal[] = [];
	const runtime = createRuntime<IWorld>(seed(), {
		verifyIndex,
		onError: (error) => errors.push(error),
		implementations: {
			gate: (
				effect: {
					Name: string;
				},
				action?: IActionContext
			) => {
				signals.push(action!.signal);
				return new Promise((resolve, reject) => {
					gates[effect.Name] = {
						open: resolve,
						fail: reject,
						signal: action!.signal
					};
				});
			},
			"fiberEnds/stamp": (effect: IStampEffect) => {
				log.push(effect.Text);
			}
		}
	}) as IRuntimeInternal<IWorld>;
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	const failures: IRuntimeEventOf<"failure">[] = [];
	runtime.on("failure", (event) => failures.push(event));

	const escalated: {
		Error: {
			Message?: string;
		};
	}[] = [];
	const Errors = receiver<IWorld>("FiberEndsErrors")({
		*"Action/Error"(_draft, message) {
			escalated.push(message as never);
		}
	});
	runtime.registerReceiver(Errors);
	await runtime.dispatch(function* listen(draft: IWorld): IActionGenerator {
		bind(draft, Errors);
	}, "root");

	return {
		runtime,
		gates,
		log,
		errors,
		signals,
		escalated,
		records,
		diags,
		failures,
		row: () => runtime.state.Rows[0],
		ofKind: <K extends IRecord["Kind"]>(kind: K) =>
			records.filter(
				(
					r
				): r is Extract<
					IRecord,
					{
						Kind: K;
					}
				> => r.Kind === kind
			),
		endOf: (name: string) => {
			const started = records.find((r) => r.Kind === "action:start" && r.Label === name) as
				| Extract<
						IRecord,
						{
							Kind: "action:start";
						}
				  >
				| undefined;
			return records.find((r) => r.Kind === "action:end" && r.ActionId === started?.ActionId) as
				| Extract<
						IRecord,
						{
							Kind: "action:end";
						}
				  >
				| undefined;
		}
	};
}

let harness: Awaited<ReturnType<typeof build>> | undefined;

async function begin(verifyIndex?: "always") {
	harness = await build(verifyIndex);
	return harness;
}

function watched<T>(run: Promise<T>) {
	const state: {
		settled: "pending" | "resolved" | "rejected";
		error?: Error;
	} = {
		settled: "pending"
	};
	void run.then(
		() => {
			state.settled = "resolved";
		},
		(error: Error) => {
			state.settled = "rejected";
			state.error = error;
		}
	);
	return state;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	harness?.runtime.dispose();
	harness = undefined;
	vi.restoreAllMocks();
});

function* failsAfter(name: string, message = "branch boom"): Generator<IActionYield, void, any> {
	yield* gate(name);
	throw new Error(message);
}

describe("a failing parallel branch", () => {
	it("ends a sibling at once: its finally runs, its effect is left running, and the failure rethrows", async () => {
		const h = await begin();
		function* sibling(draft: IRow): Generator<IActionYield, string, any> {
			try {
				const value = yield* gate("sibling");
				h.log.push(`resumed:${value}`);
				draft.Resumed = true;
				yield* gate("never");
				return "sibling";
			} catch {
				h.log.push("catch");
				return "caught";
			} finally {
				draft.Cleaned = true;
				h.log.push("finally");
			}
		}
		function* root(draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), sibling(draft));
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();

		h.gates.failer.open();
		await tick();

		expect(run.settled).toBe("rejected");
		expect(run.error?.message).toBe("branch boom");
		expect(h.gates.sibling.signal.aborted).toBe(true);
		h.gates.sibling.open("from the server");
		await tick();
		expect(h.log).toEqual([
			"finally"
		]);
		expect(h.gates.never).toBeUndefined();
		expect(h.row().Cleaned).toBe(true);
		expect(h.row().Resumed).toBeUndefined();
		expect(h.escalated.map((e) => e.Error.Message)).toEqual([
			"branch boom"
		]);
		expect(h.errors).toEqual([]);
		expect(h.endOf("root")?.Status).toBe("errored");

		const effect = h.ofKind("effect").find(
			(r) =>
				r.Type === "gate" &&
				(
					r.Descriptor as {
						Name: string;
					}
				).Name === "sibling"
		)!;
		expect(h.ofKind("response").filter((r) => r.ForSeq === effect.Seq)).toEqual([]);
	});

	it("rethrows past a sibling whose effect never settles", async () => {
		const h = await begin();
		h.runtime.registerImplementation("never", () => new Promise(() => {}));
		function* sibling(): Generator<IActionYield, void, any> {
			try {
				yield {
					Type: "never"
				};
			} finally {
				h.log.push("finally");
			}
		}
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), sibling());
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.failer.open();
		await tick();

		expect(run.error?.message).toBe("branch boom");
		expect(h.log).toEqual([
			"finally"
		]);
	});

	it("does not take a stopped sibling's rejected effect as a failure", async () => {
		const h = await begin();
		function* sibling(): Generator<IActionYield, void, any> {
			try {
				yield* gate("sibling");
			} catch {
				h.log.push("catch");
			}
		}
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), sibling());
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.failer.open();
		await tick();
		h.gates.sibling.fail(new Error("server said no"));
		await tick();

		expect(run.error?.message).toBe("branch boom");
		expect(h.log).toEqual([]);
		const effect = h.ofKind("effect").find(
			(r) =>
				r.Type === "gate" &&
				(
					r.Descriptor as {
						Name: string;
					}
				).Name === "sibling"
		)!;
		expect(h.ofKind("response").filter((r) => r.ForSeq === effect.Seq)).toEqual([]);
	});

	it("does not take a stopped sibling's throwing finally as a failure", async () => {
		const h = await begin();
		function* sibling(): Generator<IActionYield, void, any> {
			try {
				yield* gate("sibling");
			} finally {
				// biome-ignore lint/correctness/noUnsafeFinally: the throw from a close is the case under test
				throw new Error("finally boom");
			}
		}
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), sibling());
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.failer.open();
		await tick();

		expect(run.error?.message).toBe("branch boom");
		expect(
			h.failures.map((failure) => [
				String(failure.Error),
				failure.Close,
				failure.Taken
			])
		).toEqual([
			[
				"Error: finally boom",
				true,
				false
			],
			[
				"Error: branch boom",
				false,
				true
			]
		]);
		const ends = h.ofKind("branch:end");
		expect(ends.map((r) => r.Status).sort()).toEqual([
			"cancelled",
			"errored"
		]);
		expect(ends.find((r) => r.Status === "cancelled")).not.toHaveProperty("Error");
	});

	it("lets the action catch the failure and carry on, once every branch has stopped", async () => {
		const h = await begin();
		function* sibling(draft: IRow): Generator<IActionYield, void, any> {
			try {
				yield* gate("sibling");
			} finally {
				draft.Cleaned = true;
			}
		}
		function* root(draft: IRow): IActionGenerator<string> {
			try {
				yield* parallel(failsAfter("failer"), sibling(draft));
			} catch (error) {
				h.log.push(`caught:${(error as Error).message}:${draft.Cleaned}`);
			}
			yield* gate("after");
			h.log.push("carried on");
			return "done";
		}
		const run = h.runtime.dispatch(root, "row-1");
		await tick();
		h.gates.failer.open();
		await tick();
		expect(h.log).toEqual([
			"caught:branch boom:true"
		]);
		h.gates.after.open();
		await expect(run).resolves.toBe("done");
		expect(h.escalated).toEqual([]);
	});

	it("rethrows the first failure, and keeps every failure on the record", async () => {
		const h = await begin();
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("first", "first boom"), failsAfter("second", "second boom"));
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.first.open();
		await tick();
		expect(run.error?.message).toBe("first boom");
		h.gates.second.open();
		await tick();
		expect(h.ofKind("branch:end").map((r) => r.Status)).toEqual([
			"errored",
			"cancelled"
		]);

		const nested = await build();
		function* inner(): Generator<IActionYield, void, any> {
			yield* parallel(failsAfter("inner-fails", "inner boom"), gate("inner-holds"));
		}
		function* outer(_draft: IRow): IActionGenerator {
			yield* parallel(inner(), failsAfter("outer-fails", "outer boom"));
		}
		const nestedRun = watched(nested.runtime.dispatch(outer, "row-1"));
		await tick();
		nested.gates["inner-fails"].open();
		nested.gates["outer-fails"].open();
		await tick();

		expect(nestedRun.error?.message).toBe("outer boom");
		const errored = nested.ofKind("branch:end").filter((r) => r.Status === "errored");
		expect(errored.map((r) => r.Error)).toMatchObject([
			{
				Message: "inner boom"
			},
			{
				Message: "outer boom"
			}
		]);
		for (const record of nested.ofKind("branch:end").filter((r) => r.Status !== "errored")) {
			expect(record).not.toHaveProperty("Error");
		}
		nested.runtime.dispose();
	});

	it("starts a branch not yet started as stopped when an earlier one fails in step zero", async () => {
		const h = await begin();
		function* throwsAtOnce(): Generator<IActionYield, void, any> {
			h.log.push("first");
			throw new Error("step zero boom");
		}
		function* later(draft: IRow): Generator<IActionYield, void, any> {
			h.log.push("later ran");
			draft.Note = "later ran";
			yield* gate("later");
		}
		function* root(draft: IRow): IActionGenerator {
			yield* parallel(throwsAtOnce(), later(draft));
		}
		await expect(h.runtime.dispatch(root, "row-1")).rejects.toThrow("step zero boom");

		expect(h.log).toEqual([
			"first"
		]);
		expect(h.row().Note).toBeUndefined();
		expect(h.gates.later).toBeUndefined();
		expect(h.ofKind("branch:start")).toHaveLength(2);
		expect(h.ofKind("branch:end").map((r) => r.Status)).toEqual([
			"errored",
			"cancelled"
		]);
	});

	it("sees a failure after sync effects before the next branch starts", async () => {
		const h = await begin();
		function* throwsAfterSync(): Generator<IActionYield, void, any> {
			yield* stamp({
				Text: "first:after-sync"
			});
			throw new Error("sync boom");
		}
		function* later(): Generator<IActionYield, void, any> {
			h.log.push("later ran");
			yield* stamp({
				Text: "later:after-sync"
			});
		}
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(throwsAfterSync(), later());
		}
		await expect(h.runtime.dispatch(root, "row-1")).rejects.toThrow("sync boom");

		expect(h.log).toEqual([
			"first:after-sync"
		]);
	});

	it("reports nothing for a success", async () => {
		const h = await begin();
		function* root(_draft: IRow): IActionGenerator<unknown[]> {
			return yield* parallel(gate("a"), gate("b"));
		}
		const run = h.runtime.dispatch(root, "row-1");
		await tick();
		h.gates.b.open("b");
		h.gates.a.open("a");
		await expect(run).resolves.toEqual([
			"a",
			"b"
		]);
		expect(h.ofKind("branch:end").map((r) => r.Status)).toEqual([
			"completed",
			"completed"
		]);
	});
});

describe("a fiber waiting on parallel, when it stops", () => {
	it("ends its branches and then itself, with their effects in flight", async () => {
		const h = await begin();
		function* inner(draft: IRow): Generator<IActionYield, void, any> {
			try {
				yield* gate("inner");
				draft.Resumed = true;
				yield* gate("inner-2");
			} finally {
				h.log.push("inner finally");
			}
		}
		function* nested(draft: IRow): Generator<IActionYield, void, any> {
			try {
				yield* parallel(inner(draft));
				h.log.push("nested resumed");
			} finally {
				h.log.push("nested finally");
			}
		}
		function* root(draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), nested(draft));
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.failer.open();
		await tick();

		expect(run.error?.message).toBe("branch boom");
		expect(h.log).toEqual([
			"inner finally",
			"nested finally"
		]);
		h.gates.inner.open();
		await tick();
		expect(h.row().Resumed).toBeUndefined();
		expect(h.gates["inner-2"]).toBeUndefined();
	});
});

describe("removing the entity of an action waiting on parallel", () => {
	it("ends the root cancelled at once, whatever its branches' effects are doing, with no Action/Error", async () => {
		const h = await begin();
		function* branch(name: string): Generator<IActionYield, void, any> {
			try {
				yield* gate(name);
			} finally {
				h.log.push(`${name} finally`);
			}
		}
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(branch("a"), branch("b"));
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();

		treeWrite(h.runtime, (s) => {
			s.Rows = [];
		});
		expect(h.gates.a.signal.aborted).toBe(true);
		expect(h.gates.b.signal.aborted).toBe(true);
		await tick();

		expect(run.settled).toBe("resolved");
		expect(h.log).toEqual([
			"a finally",
			"b finally"
		]);
		expect(h.endOf("root")?.Status).toBe("cancelled");
		expect(h.escalated).toEqual([]);
		expect(h.errors).toEqual([]);
	});
});

describe("action.signal", () => {
	function captured(h: Awaited<ReturnType<typeof build>>) {
		const signals: AbortSignal[] = [];
		h.runtime.registerImplementation("captureSignal", (_effect: unknown, action?: IActionContext) => {
			signals.push(action!.signal);
		});
		return signals;
	}
	function* capture(): Generator<IActionYield, void, any> {
		yield {
			Type: "captureSignal"
		};
	}

	it("does not fire when a fiber completes or throws by itself", async () => {
		const h = await begin();
		const signals = captured(h);
		function* completes(_draft: IRow): IActionGenerator {
			yield* capture();
		}
		function* throws(_draft: IRow): IActionGenerator {
			yield* capture();
			throw new Error("boom");
		}
		function* withChild(_draft: IRow): IActionGenerator {
			yield* parallel(capture());
		}
		await h.runtime.dispatch(completes, "row-1");
		await h.runtime.dispatch(throws, "row-1").catch(() => {});
		await h.runtime.dispatch(withChild, "row-1");
		await tick();

		expect(signals).toHaveLength(3);
		expect(signals.some((signal) => signal.aborted)).toBe(false);
	});

	it("does not fire on a parallel branch that throws by itself in a resume step", async () => {
		const h = await begin();
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), gate("sibling"));
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.failer.open();
		await tick();

		expect(run.error?.message).toBe("branch boom");
		expect(h.gates.failer.signal.aborted).toBe(false);
		expect(h.gates.sibling.signal.aborted).toBe(true);
	});

	it("does not fire on a branch that returned in the batch ahead of a sibling's throw", async () => {
		const h = await begin();
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(gate("returns"), failsAfter("failer"));
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.returns.open("value");
		h.gates.failer.open();
		await tick();

		expect(run.error?.message).toBe("branch boom");
		expect(h.gates.returns.signal.aborted).toBe(false);
		expect(h.gates.failer.signal.aborted).toBe(false);
		expect(h.ofKind("branch:end").map((r) => r.Status)).toEqual([
			"completed",
			"errored"
		]);
	});

	it("fires on a branch whose effect settled in the batch but which resumes behind a sibling's throw", async () => {
		const h = await begin();
		function* root(_draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), gate("resumes-late"));
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.failer.open();
		h.gates["resumes-late"].open("value");
		await tick();

		expect(run.error?.message).toBe("branch boom");
		expect(h.gates["resumes-late"].signal.aborted).toBe(true);
		expect(h.ofKind("branch:end").map((r) => r.Status)).toEqual([
			"errored",
			"cancelled"
		]);
	});

	it("stays live on a root that fails through a parallel, which was not told to end, so Action/Error escalates", async () => {
		const h = await begin();
		const signals = captured(h);
		function* root(_draft: IRow): IActionGenerator {
			yield* capture();
			yield* parallel(failsAfter("failer"), gate("sibling"));
		}
		const run = watched(h.runtime.dispatch(root, "row-1"));
		await tick();
		h.gates.failer.open();
		await tick();

		expect(run.error?.message).toBe("branch boom");
		expect(signals[0].aborted).toBe(false);
		expect(h.gates.sibling.signal.aborted).toBe(true);
		expect(h.escalated.map((e) => e.Error.Message)).toEqual([
			"branch boom"
		]);
	});

	it("is its own per fiber, and reads aborted when first read after the fiber was told to end", async () => {
		const h = await begin();
		let held!: IActionContext;
		h.runtime.registerImplementation("hold", (_effect: unknown, action?: IActionContext) => {
			held = action!;
			return new Promise(() => {});
		});
		const signals = captured(h);
		function* holding(): Generator<IActionYield, void, any> {
			yield {
				Type: "hold"
			};
		}
		function* root(_draft: IRow): IActionGenerator {
			yield* capture();
			try {
				yield* parallel(holding(), failsAfter("root"));
			} catch {}
			yield* gate("after");
		}
		const run = h.runtime.dispatch(root, "row-1");
		await tick();
		h.gates.root.open();
		await tick();

		expect(held.signal).not.toBe(signals[0]);
		expect(held.signal.aborted).toBe(true);
		expect(signals[0].aborted).toBe(false);
		h.gates.after.open();
		await run;
	});

	it.each([
		[
			"the default cadence",
			undefined
		],
		[
			"verifyIndex always",
			"always"
		]
	] as const)("fires on runtime.dispose, and a finally that writes after it does not throw, under %s", async (_name, verifyIndex) => {
		const h = await begin(verifyIndex);
		let finished = false;
		function* root(draft: IRow): IActionGenerator {
			try {
				yield* gate("a");
			} finally {
				draft.Cleaned = true;
				finished = true;
			}
		}
		const run = h.runtime.dispatch(root, "row-1");
		await tick();
		h.runtime.dispose();
		harness = undefined;
		expect(h.gates.a.signal.aborted).toBe(true);

		await expect(run).resolves.toBeUndefined();
		expect(finished).toBe(true);
	});

	it("reaches a resource method's context, and the method decides", async () => {
		const h = await begin();
		let methodSignal!: AbortSignal;
		let finish!: (value: string) => void;
		h.runtime.registerResourceType(
			"fiberEnds/method" as never,
			((_params: unknown, r: any) => {
				r.methods({
					slow(ctx: { signal: AbortSignal }) {
						methodSignal = ctx.signal;
						return new Promise<string>((resolve) => {
							finish = resolve;
						});
					}
				});
			}) as never
		);
		await h.runtime.dispatch(function* open(draft: IWorld): IActionGenerator {
			yield* (openResource as any)(draft, "FiberEnds/Method", {
				Type: "fiberEnds/method"
			});
		}, "root");
		function* caller(_draft: IRow): IActionGenerator {
			yield* (resource as any)("root", "FiberEnds/Method").slow();
			h.log.push("resumed");
		}
		const run = h.runtime.dispatch(caller, "row-1");
		await tick();
		treeWrite(h.runtime, (s) => {
			s.Rows = [];
		});

		expect(methodSignal.aborted).toBe(true);
		await expect(run).resolves.toBeUndefined();
		finish("late");
		await tick();
		expect(h.log).toEqual([]);
		expect(h.errors).toEqual([]);
	});
});

describe("an effect that stops its own fiber during its dispatch", () => {
	const responsesTo = (h: Awaited<ReturnType<typeof build>>, type: string) => {
		const effect = h.ofKind("effect").find((r) => r.Type === type)!;
		return h.ofKind("response").filter((r) => r.ForSeq === effect.Seq);
	};

	it.each<
		[
			string,
			() => unknown
		]
	>([
		[
			"a resolved promise",
			() => Promise.resolve("value")
		],
		[
			"a plain value",
			() => "value"
		],
		[
			"a sync throw",
			() => {
				throw new Error("thrown after the stop");
			}
		],
		[
			"a rejected promise",
			() => Promise.reject(new Error("rejected after the stop"))
		],
		[
			"a pending promise",
			() => new Promise(() => {})
		]
	])("gets no response and no resume, returning %s", async (_name, returns) => {
		const h = await begin();
		h.runtime.registerImplementation("removesOwnEntity", () => {
			treeWrite(h.runtime, (s) => {
				s.Rows = [];
			});
			return returns();
		});
		function* root(_draft: IRow): IActionGenerator {
			try {
				yield {
					Type: "removesOwnEntity"
				};
				h.log.push("resumed");
			} catch {
				h.log.push("caught");
			} finally {
				h.log.push("finally");
			}
		}
		await expect(h.runtime.dispatch(root, "row-1")).resolves.toBeUndefined();
		await tick();

		expect(h.log).toEqual([
			"finally"
		]);
		expect(h.endOf("root")?.Status).toBe("cancelled");
		expect(responsesTo(h, "removesOwnEntity")).toEqual([]);
		expect(h.escalated).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it("keeps the response of an effect that settled ahead of a stop, with no resume", async () => {
		const h = await begin();
		function* root(_draft: IRow): IActionGenerator {
			yield* gate("settled");
			h.log.push("resumed");
		}
		const run = h.runtime.dispatch(root, "row-1");
		await tick();
		h.gates.settled.open("value");
		treeWrite(h.runtime, (s) => {
			s.Rows = [];
		});
		await run;

		expect(h.log).toEqual([]);
		expect(h.endOf("root")?.Status).toBe("cancelled");
		expect(responsesTo(h, "gate")).toHaveLength(1);
	});
});

describe("a fiber's end", () => {
	it("tells a stopped branch's own branches to end with it", async () => {
		const h = await begin();
		function* grandchild(draft: IRow): Generator<IActionYield, void, any> {
			yield* gate("grandchild");
			draft.Note = "grandchild ran on";
			yield* gate("send");
		}
		function* branch(draft: IRow): Generator<IActionYield, void, any> {
			yield* parallel(grandchild(draft), gate("branch"));
		}
		function* root(draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), branch(draft));
		}
		const run = h.runtime.dispatch(root, "row-1").catch(() => {});
		await tick();
		h.gates.failer.open();
		h.gates.grandchild.open();
		await run;
		await tick();

		expect(h.gates.grandchild.signal.aborted).toBe(true);
		expect(h.row().Note).toBeUndefined();
		expect(h.gates.send).toBeUndefined();
	});
});

describe("start", () => {
	it("outlives its starter, whatever the starter's end", async () => {
		for (const ending of [
			"returns",
			"throws"
		]) {
			const h = await build();
			function* started(draft: IRow): IActionGenerator {
				yield* gate("started");
				draft.Note = "started ran on";
			}
			function* starter(draft: IRow): IActionGenerator {
				yield* start(started, draft);
				if (ending === "throws") {
					throw new Error("starter boom");
				}
			}
			await h.runtime.dispatch(starter, "row-1").catch(() => {});

			h.gates.started.open();
			await tick();

			expect(h.row().Note).toBe("started ran on");
			expect(h.gates.started.signal.aborted).toBe(false);
			h.runtime.dispose();
		}
	});

	it("outlives a parallel branch that started it, when a sibling fails", async () => {
		const h = await begin();
		function* started(draft: IRow): IActionGenerator {
			yield* gate("started");
			draft.Note = "started ran on";
		}
		function* starter(draft: IRow): Generator<IActionYield, void, any> {
			yield* start(started, draft);
			yield* gate("starter");
		}
		function* root(draft: IRow): IActionGenerator {
			yield* parallel(failsAfter("failer"), starter(draft));
		}
		const run = h.runtime.dispatch(root, "row-1").catch(() => {});
		await tick();
		h.gates.failer.open();
		await tick();
		h.gates.starter.open();
		await run;

		h.gates.started.open();
		await tick();
		expect(h.row().Note).toBe("started ran on");
	});
});

describe("a stop inside a closing finally", () => {
	type IHarness = Awaited<ReturnType<typeof build>>;

	const closeDiags = (h: IHarness) => [
		...h.diags.filter((d) => d.code.startsWith("cancel/")),
		...h.failures.filter((failure) => failure.Close)
	];

	it("runs an open a closing finally opens, and the rest of that finally, then stays stopped", async () => {
		const h = await begin();
		function* load(): IOpenGenerator<string> {
			try {
				yield* gate("body");
				return "loaded";
			} finally {
				const read = yield* open(
					(function* (): IActionGenerator<string> {
						h.log.push("open body");
						return "open result";
					})()
				);
				h.log.push(read);
			}
		}
		function* root(_draft: IRow): IOpenGenerator {
			try {
				yield* load();
				h.log.push("after the helper");
			} finally {
				h.log.push("outer finally");
			}
		}
		const run = h.runtime.dispatch(root, "row-1");
		await tick();
		treeWrite(h.runtime, (s) => {
			s.Rows = [];
		});
		await run;

		expect(h.log).toEqual([
			"open body",
			"open result",
			"outer finally"
		]);
		expect(h.endOf("root")?.Status).toBe("cancelled");
		expect(closeDiags(h)).toEqual([]);
	});
});

describe("a throw in the step that stops the fiber or whose flush throws", () => {
	type IHarness = Awaited<ReturnType<typeof build>>;

	const closeDiags = (h: IHarness) => [
		...h.diags.filter((d) => d.code.startsWith("cancel/")),
		...h.failures.filter((failure) => failure.Close)
	];

	describe.each<
		[
			string,
			(body: () => IActionGenerator) => IOpenGenerator
		]
	>([
		[
			"no wrapper",
			(body) => body()
		],
		[
			"an open nothing got into",
			(body) => open(body())
		]
	])("a throw and a stop in one step inside %s", (_shape, wrap) => {
		it("ends the action errored, and onError hears the throw", async () => {
			const h = await begin();
			function* root(_draft: IRow): IOpenGenerator {
				try {
					yield* wrap(function* (): IActionGenerator {
						yield* gate("ready");
						treeWrite(h.runtime, (s) => {
							s.Rows = [];
						});
						throw new Error("in the region");
					});
					h.log.push("after");
				} finally {
					h.log.push("outer finally");
				}
			}
			const run = h.runtime.dispatch(root, "row-1");
			await tick();
			h.gates.ready.open();
			await expect(run).rejects.toThrow("in the region");

			expect(h.log).toEqual([
				"outer finally"
			]);
			expect(h.endOf("root")?.Status).toBe("errored");
			expect(h.errors.map((error) => (error as Error).message)).toEqual([
				"in the region"
			]);
			expect(closeDiags(h)).toEqual([]);
		});
	});

	it("ends an open other work got into silently cancelled, on a throw and a stop in one step", async () => {
		const h = await begin();
		function* root(_draft: IRow): IOpenGenerator {
			try {
				yield* open(
					(function* (): IActionGenerator {
						yield* gate("ready");
						treeWrite(h.runtime, (s) => {
							s.Rows = [];
						});
						throw new Error("in the region");
					})()
				);
				h.log.push("after");
			} catch {
				h.log.push("caught");
			} finally {
				h.log.push("outer finally");
			}
		}
		const run = h.runtime.dispatch(root, "row-1");
		await tick();
		const other = h.runtime.dispatch(function* other(_draft: IRow): IActionGenerator {
			yield* gate("other");
		}, "row-1");
		await tick();
		expect(h.gates.other).toBeDefined();
		h.gates.ready.open();
		await expect(run).resolves.toBeUndefined();
		await other;

		expect(h.log).toEqual([
			"outer finally"
		]);
		expect(h.endOf("root")?.Status).toBe("cancelled");
		expect(h.errors).toEqual([]);
		expect(closeDiags(h)).toEqual([]);
	});
});

describe("a failed fiber's error and the activity log", () => {
	async function buildLogged() {
		const runtime = createRuntime<IWorld>(seed(), {
			onError: () => {}
		}) as IRuntimeInternal<IWorld>;
		createActivityLog(runtime);
		runtime.registerImplementation(
			implementation(secret, () => {
				const error = new Error("refused") as Error & {
					Token: string;
				};
				error.Token = "abc-token";
				return Promise.reject(error);
			})
		);
		const records: IRecord[] = [];
		runtime.on("record", (record) => records.push(record));
		const readLog = (): Promise<readonly IActivityLogEntry[] | undefined> =>
			runtime.dispatch(function* readActivityLog(_draft: IWorld): IActionGenerator<readonly IActivityLogEntry[] | undefined> {
				return yield* external("ActivityLog");
			}, "root");
		return {
			runtime,
			records,
			readLog
		};
	}

	function* secretBranch(): Generator<IActionYield, void, any> {
		yield* secret();
	}

	async function expectWithheld(h: Awaited<ReturnType<typeof buildLogged>>): Promise<void> {
		const log = await h.readLog();
		const entries = log ?? [];
		const end = entries.find((entry) => entry.Kind === "branch:end");
		expect(end?.Data).toMatchObject({
			Status: "errored"
		});
		expect(end?.Data).not.toHaveProperty("Error");
		expect(JSON.stringify(entries)).not.toContain("abc-token");
		const tapped = h.records.find((record) => record.Kind === "branch:end");
		expect(JSON.stringify(tapped)).toContain("abc-token");
		h.runtime.dispose();
	}

	it("keeps it out of the log and on the record tap, for an action", async () => {
		const h = await buildLogged();
		function* root(_draft: IWorld): IActionGenerator {
			yield* parallel(secretBranch());
		}
		await expect(h.runtime.dispatch(root, "root")).rejects.toThrow("refused");

		await expectWithheld(h);
	});

	it("keeps it out of the log and on the record tap, for an r.run", async () => {
		const h = await buildLogged();
		let ctx!: {
			run<R>(effect: Generator<IActionYield, R, any>): Promise<R>;
		};
		h.runtime.registerResourceType(
			"fiberEnds/runner" as never,
			((_params: unknown, r: any) => {
				ctx = r;
			}) as never
		);
		await h.runtime.dispatch(function* open(draft: IWorld): IActionGenerator {
			yield* (openResource as any)(draft, "FiberEnds/Runner", {
				Type: "fiberEnds/runner"
			});
		}, "root");
		function* runBody(): Generator<IActionYield, void, any> {
			yield* parallel(secretBranch());
		}
		await expect(ctx.run(runBody())).rejects.toThrow("refused");

		await expectWithheld(h);
	});
});
