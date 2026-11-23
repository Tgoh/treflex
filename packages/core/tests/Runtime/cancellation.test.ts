import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it, vi } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { publish } from "../../src/Effects/publish";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { FINALLY_YIELD_LIMIT } from "../../src/Runtime/fiberMachine";
import { receiver } from "../../src/Runtime/receiver";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import * as reactive from "../reactive";
import { rootSetState, treeWrite } from "../testHelpers";

function createBarrier() {
	let resolve!: (v: any) => void;
	let signalStarted!: () => void;
	const started = new Promise<void>((r) => {
		signalStarted = r;
	});
	const promise = new Promise<any>((r) => {
		resolve = r;
	});

	return {
		started,
		resolve,
		run: () => {
			signalStarted();
			return promise;
		}
	};
}

type ChildState = {
	$Id: string;
	Data: string;
};
type ParentState = {
	$Id: string;
	Children: ChildState[];
};

describe("cancellation: prerequisites", () => {
	it("can run an action on a sliced store", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ParentState>({
					$Id: "parent",
					Children: [
						{
							$Id: "child-1",
							Data: ""
						}
					]
				});
				runtime.registerImplementation("echo", (e: any) => e.Value);

				function* simpleAction(draft: ChildState): IActionGenerator {
					const val: string = yield {
						Type: "echo",
						Value: "hello"
					};
					draft.Data = val;
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				await runtime.processAction(simpleAction, (() => runtime.state) as any, childSetState, () => runtime.state.Children[0]?.$Id ?? "");
				expect(runtime.state.Children[0].Data).toBe("hello");
			} finally {
				dispose();
			}
		});
	});
});

describe("cancellation", () => {
	it("cancels a running action when the entity is removed from the state tree", async () => {
		const b1 = createBarrier();
		const b2 = createBarrier();
		let callCount = 0;

		const onTrace = vi.fn();

		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ParentState>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "child-1",
								Data: ""
							}
						]
					},
					{
						onError: () => {}
					}
				);
				createTraceAggregator(runtime, onTrace);
				runtime.registerImplementation("cancel_test1", () => {
					callCount++;
					return callCount === 1 ? b1.run() : b2.run();
				});

				function* longAction(draft: ChildState): IActionGenerator {
					const first: string = yield {
						Type: "cancel_test1"
					};
					draft.Data = first;
					const second: string = yield {
						Type: "cancel_test1"
					};
					draft.Data = second;
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";

				const actionPromise = runtime.processAction(longAction, (() => runtime.state) as any, childSetState, idAccessor);

				await b1.started;
				b1.resolve("first-value");

				await b2.started;
				expect(runtime.state.Children[0].Data).toBe("first-value");

				treeWrite(runtime, (s: ParentState) => {
					s.Children = [];
				});

				b2.resolve("second-value");
				await actionPromise;

				const trace = onTrace.mock.calls[onTrace.mock.calls.length - 1][0];
				expect(trace.cancelled).toBe(true);
			} finally {
				dispose();
			}
		});
	});

	it("does not cancel an action when the entity remains in the tree", async () => {
		const b1 = createBarrier();
		const b2 = createBarrier();
		let callCount = 0;

		const onTrace = vi.fn();

		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ParentState>({
					$Id: "parent",
					Children: [
						{
							$Id: "child-1",
							Data: ""
						}
					]
				});
				createTraceAggregator(runtime, onTrace);
				runtime.registerImplementation("cancel_test2", () => {
					callCount++;
					return callCount === 1 ? b1.run() : b2.run();
				});

				function* twoStepAction(draft: ChildState): IActionGenerator {
					const first: string = yield {
						Type: "cancel_test2"
					};
					draft.Data = first;
					const second: string = yield {
						Type: "cancel_test2"
					};
					draft.Data = second;
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";

				const actionPromise = runtime.processAction(twoStepAction, (() => runtime.state) as any, childSetState, idAccessor);
				await b1.started;
				b1.resolve("step-1");
				await b2.started;
				b2.resolve("step-2");
				await actionPromise;

				expect(runtime.state.Children[0].Data).toBe("step-2");
				const trace = onTrace.mock.calls[onTrace.mock.calls.length - 1][0];
				expect(trace.cancelled).toBeUndefined();
			} finally {
				dispose();
			}
		});
	});

	it("cancels an action on a deeply nested entity when its parent is removed", async () => {
		type GrandchildState = {
			$Id: string;
			Value: string;
		};
		type DeepChildState = {
			$Id: string;
			Items: GrandchildState[];
		};
		type RootState = {
			$Id: string;
			Nodes: DeepChildState[];
		};

		const b1 = createBarrier();
		const b2 = createBarrier();
		let callCount = 0;

		const onTrace = vi.fn();

		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<RootState>(
					{
						$Id: "root",
						Nodes: [
							{
								$Id: "node-1",
								Items: [
									{
										$Id: "item-1",
										Value: ""
									}
								]
							}
						]
					},
					{
						onError: () => {}
					}
				);
				createTraceAggregator(runtime, onTrace);
				runtime.registerImplementation("cancel_test3", () => {
					callCount++;
					return callCount === 1 ? b1.run() : b2.run();
				});

				function* deepAction(draft: GrandchildState): IActionGenerator {
					const first: string = yield {
						Type: "cancel_test3"
					};
					draft.Value = first;
					const second: string = yield {
						Type: "cancel_test3"
					};
					draft.Value = second;
				}

				const nodeSetState = sliceSetState<DeepChildState, RootState>(rootSetState(runtime), (x) => x.Nodes[0]);
				const itemSetState = sliceSetState<GrandchildState, DeepChildState>(nodeSetState, (x) => x.Items[0]);
				const idAccessor = () => runtime.state.Nodes[0]?.Items[0]?.$Id ?? "";

				const actionPromise = runtime.processAction(deepAction, (() => runtime.state) as any, itemSetState, idAccessor);
				await b1.started;
				b1.resolve("deep-first");
				await b2.started;

				expect(runtime.state.Nodes[0].Items[0].Value).toBe("deep-first");

				treeWrite(runtime, (s: RootState) => {
					s.Nodes = [];
				});

				b2.resolve("deep-second");
				await actionPromise;

				const trace = onTrace.mock.calls[onTrace.mock.calls.length - 1][0];
				expect(trace.cancelled).toBe(true);
			} finally {
				dispose();
			}
		});
	});
});

describe("cancellation: signal propagation", () => {
	it("the per-action signal aborts when the owning entity leaves the tree", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ParentState>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "child-1",
								Data: ""
							}
						]
					},
					{
						onError: () => {}
					}
				);

				let observedAborted = false;
				let signalCaptured: AbortSignal | undefined;

				runtime.registerImplementation("abortable", (_e, action) => {
					return new Promise((resolve, reject) => {
						signalCaptured = action?.signal;
						action?.signal.addEventListener("abort", () => {
							observedAborted = true;
							reject(new DOMException("aborted", "AbortError"));
						});
					});
				});

				function* longRunning(draft: ChildState): IActionGenerator {
					const result: string = yield {
						Type: "abortable"
					};
					draft.Data = result;
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";

				const actionPromise = runtime.processAction(longRunning, () => runtime.state as any, childSetState, idAccessor);

				await Promise.resolve();
				expect(signalCaptured?.aborted).toBe(false);

				treeWrite(runtime, (s: ParentState) => {
					s.Children = [];
				});

				await actionPromise;
				expect(observedAborted).toBe(true);
				expect(signalCaptured?.aborted).toBe(true);
			} finally {
				dispose();
			}
		});
	});

	it("an AbortError thrown by the implementation is silent at the action layer", async () => {
		await reactive.root(async (dispose) => {
			try {
				const onTrace = vi.fn();
				const runtime = createRuntime<ParentState>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "child-1",
								Data: ""
							}
						]
					},
					{
						onError: () => {}
					}
				);
				createTraceAggregator(runtime, onTrace);

				runtime.registerImplementation("abortable", (_e, action) => {
					return new Promise((_resolve, reject) => {
						action?.signal.addEventListener("abort", () => {
							reject(new DOMException("aborted", "AbortError"));
						});
					});
				});

				let userCatchSawError = false;
				let userFinallyRan = false;
				function* longRunning(_draft: ChildState): IActionGenerator {
					try {
						yield {
							Type: "abortable"
						};
					} catch {
						userCatchSawError = true;
					} finally {
						userFinallyRan = true;
					}
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";

				const actionPromise = runtime.processAction(longRunning, () => runtime.state as any, childSetState, idAccessor);
				await Promise.resolve();
				treeWrite(runtime, (s: ParentState) => {
					s.Children = [];
				});
				await actionPromise;

				expect(userCatchSawError).toBe(false);
				expect(userFinallyRan).toBe(true);
				const trace = onTrace.mock.calls[onTrace.mock.calls.length - 1][0];
				expect(trace.cancelled).toBe(true);
				expect(trace.error).toBeUndefined();

				const abortedEntries = trace.entries.filter((s: any) => s.type === "effect" && s.effect.Type === "abortable");
				expect(abortedEntries.length).toBe(1);
				expect(abortedEntries[0].aborted).toBe(true);
				expect(abortedEntries[0].result).toBeUndefined();
				expect(typeof abortedEntries[0].duration).toBe("number");
			} finally {
				dispose();
			}
		});
	});

	it("does not abort the signal on normal completion", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ParentState>({
					$Id: "parent",
					Children: [
						{
							$Id: "child-1",
							Data: ""
						}
					]
				});

				let signalCaptured: AbortSignal | undefined;
				runtime.registerImplementation("echo", (_e, action) => {
					signalCaptured = action?.signal;
					return "value";
				});

				function* simple(draft: ChildState): IActionGenerator {
					const v: string = yield {
						Type: "echo"
					};
					draft.Data = v;
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
				await runtime.processAction(simple, () => runtime.state as any, childSetState, idAccessor);

				expect(signalCaptured?.aborted).toBe(false);
			} finally {
				dispose();
			}
		});
	});

	it("sibling actions on different entities have independent signals", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ParentState>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "a",
								Data: ""
							},
							{
								$Id: "b",
								Data: ""
							}
						]
					},
					{
						onError: () => {}
					}
				);

				let aSignal: AbortSignal | undefined;
				let bSignal: AbortSignal | undefined;
				let aRejected = false;
				let bResolved = false;

				runtime.registerImplementation("a_op", (_e, action) => {
					aSignal = action?.signal;
					return new Promise((_r, reject) => {
						action?.signal.addEventListener("abort", () => {
							aRejected = true;
							reject(new DOMException("aborted", "AbortError"));
						});
					});
				});
				runtime.registerImplementation("b_op", (_e, action) => {
					bSignal = action?.signal;
					return new Promise((resolve) => {
						queueMicrotask(() => {
							bResolved = true;
							resolve("b-done");
						});
					});
				});

				function* aAction(_draft: ChildState): IActionGenerator {
					yield {
						Type: "a_op"
					};
				}
				function* bAction(draft: ChildState): IActionGenerator {
					const r: string = yield {
						Type: "b_op"
					};
					draft.Data = r;
				}

				const aSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children.find((c) => c.$Id === "a")!);
				const bSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children.find((c) => c.$Id === "b")!);
				const aPromise = runtime.processAction(
					aAction,
					() => runtime.state as any,
					aSetState,
					() => "a"
				);
				const bPromise = runtime.processAction(
					bAction,
					() => runtime.state as any,
					bSetState,
					() => "b"
				);

				await Promise.resolve();
				expect(aSignal).not.toBe(bSignal);

				treeWrite(runtime, (s: ParentState) => {
					s.Children = s.Children.filter((c) => c.$Id !== "a");
				});

				await aPromise;
				await bPromise;

				expect(aRejected).toBe(true);
				expect(bResolved).toBe(true);
				expect(aSignal?.aborted).toBe(true);
				expect(bSignal?.aborted).toBe(false);
				expect(runtime.state.Children[0].Data).toBe("b-done");
			} finally {
				dispose();
			}
		});
	});

	it("parallel children each hold their own signal, and all fire when the action's entity dies", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ParentState>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "child-1",
								Data: ""
							}
						]
					},
					{
						onError: () => {}
					}
				);

				const signalsCaptured: AbortSignal[] = [];
				let abortFireCount = 0;
				runtime.registerImplementation("abortable", (_e, action) => {
					signalsCaptured.push(action!.signal);
					return new Promise((_resolve, reject) => {
						action!.signal.addEventListener("abort", () => {
							abortFireCount++;
							reject(new DOMException("aborted", "AbortError"));
						});
					});
				});

				function* leg(_draft: ChildState): IActionGenerator {
					yield {
						Type: "abortable"
					};
				}

				function* branching(draft: ChildState): IActionGenerator {
					yield* parallel(leg(draft), leg(draft), leg(draft));
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
				const actionPromise = runtime.processAction(branching, () => runtime.state as any, childSetState, idAccessor);

				await Promise.resolve();
				await Promise.resolve();

				expect(signalsCaptured.length).toBe(3);
				expect(new Set(signalsCaptured).size).toBe(3);
				expect(signalsCaptured[0].aborted).toBe(false);

				treeWrite(runtime, (s: ParentState) => {
					s.Children = [];
				});

				await actionPromise;

				expect(abortFireCount).toBe(3);
				expect(signalsCaptured.every((signal) => signal.aborted)).toBe(true);
			} finally {
				dispose();
			}
		});
	});

	it("the branch is gone when its entity dies, whatever its effect is doing", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ParentState>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "child-1",
								Data: ""
							}
						]
					},
					{
						onError: () => {}
					}
				);

				let childSignal: AbortSignal | undefined;
				let settleGate!: () => void;
				runtime.registerImplementation("gate", (_e, action) => {
					childSignal = action!.signal;
					return new Promise<void>((resolve) => {
						settleGate = resolve;
					});
				});

				const log: string[] = [];
				// The resume slice touches no draft, so a run past the
				// disposal would log rather than throw on the detachment.
				function* worker(_draft: ChildState): IActionGenerator {
					try {
						yield {
							Type: "gate"
						};
						log.push("resumed");
					} finally {
						log.push("finally");
					}
				}
				function* parent(draft: ChildState): IActionGenerator {
					yield* parallel(worker(draft));
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
				const run = runtime.processAction(parent, () => runtime.state as any, childSetState, idAccessor);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				expect(childSignal?.aborted).toBe(false);

				treeWrite(runtime, (s: ParentState) => {
					s.Children = [];
				});
				expect(childSignal?.aborted).toBe(true);

				await expect(run).resolves.toBeUndefined();
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				expect(log).toEqual([
					"finally"
				]);

				settleGate();
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				expect(log).toEqual([
					"finally"
				]);
			} finally {
				dispose();
			}
		});
	});
});

const publishAny = publish as unknown as (topic: string) => Generator<any, void, any>;

describe("cancellation: receiver branches cancel on bound entity dispose", () => {
	it("aborts a receiver's in-flight effect when the bound entity leaves the tree", async () => {
		const barrier = createBarrier();
		let receivedSignal: AbortSignal | undefined;
		let postBarrierWritten = false;

		await reactive.root(async (dispose) => {
			try {
				type ChildSlot = {
					$Id: string;
					Hit: boolean;
				};
				type Root = {
					$Id: string;
					Child: ChildSlot | null;
				};

				const runtime = createRuntime<Root>(
					{
						$Id: "root",
						Child: {
							$Id: "child",
							Hit: false
						}
					},
					{
						onError: () => {}
					}
				);

				runtime.registerImplementation("hang", (_e: any, action: any) => {
					receivedSignal = action?.signal;
					return barrier.run();
				});

				const Receiver = receiver<ChildSlot>("HangReceiver")({
					["Ping" as any]: function* (draft: ChildSlot): IActionGenerator {
						yield {
							Type: "hang"
						};
						draft.Hit = true;
						postBarrierWritten = true;
					}
				});
				runtime.registerReceiver(Receiver);

				function* setup(draft: Root): IActionGenerator {
					bind(draft.Child!, Receiver);
				}
				function* fire(_draft: Root): IActionGenerator {
					yield* publishAny("Ping");
				}

				await runtime.processAction(
					setup,
					() => runtime.state,
					rootSetState(runtime),
					() => "root"
				);
				const _publishPromise = runtime.processAction(
					fire,
					() => runtime.state,
					rootSetState(runtime),
					() => "root"
				);

				await barrier.started;
				expect(receivedSignal?.aborted).toBe(false);

				treeWrite(runtime, (s: Root) => {
					s.Child = null;
				});

				expect(receivedSignal?.aborted).toBe(true);

				barrier.resolve("done");
				await _publishPromise;
				await Promise.resolve();
				await Promise.resolve();

				expect(postBarrierWritten).toBe(false);
			} finally {
				dispose();
			}
		});
	});
});

describe("cancellation: the close", () => {
	function abortableRuntime() {
		const runtime = createRuntime<ParentState>({
			$Id: "parent",
			Children: [
				{
					$Id: "child-1",
					Data: ""
				}
			]
		});
		runtime.registerImplementation("abortable", (_e, action) => {
			return new Promise((_resolve, reject) => {
				action?.signal.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		});
		return runtime;
	}

	function cancelChild(runtime: ReturnType<typeof abortableRuntime>) {
		treeWrite(runtime, (s: ParentState) => {
			s.Children = [];
		});
	}

	it("warns via diag and skips the rest of a finally that yields an effect, while outer finallys still run", async () => {
		await reactive.root(async (dispose) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const runtime = abortableRuntime();
				let echoDispatched = false;
				runtime.registerImplementation("echo", () => {
					echoDispatched = true;
					return "x";
				});
				const diags: any[] = [];
				runtime.on("diag", (e) => {
					diags.push(e);
				});

				let afterYieldRan = false;
				let outerFinallyRan = false;
				function* leakyCleanup(_draft: ChildState): IActionGenerator {
					try {
						try {
							yield {
								Type: "abortable"
							};
						} finally {
							yield {
								Type: "echo"
							};
							afterYieldRan = true;
						}
					} finally {
						outerFinallyRan = true;
					}
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
				const actionPromise = runtime.processAction(leakyCleanup, () => runtime.state as any, childSetState, idAccessor);
				await Promise.resolve();
				cancelChild(runtime);
				await actionPromise;

				expect(echoDispatched).toBe(false);
				expect(afterYieldRan).toBe(false);
				expect(outerFinallyRan).toBe(true);
				const finallyYieldDiags = diags.filter((d) => d.code === "cancel/finally-yield");
				expect(finallyYieldDiags.length).toBe(1);
				expect(finallyYieldDiags[0].data.yieldedType).toBe("echo");
			} finally {
				warn.mockRestore();
				dispose();
			}
		});
	});

	it("reports a finally that throws during the close to the failure event, as a close throw", async () => {
		await reactive.root(async (dispose) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const runtime = abortableRuntime();
				const failures: IRuntimeEventOf<"failure">[] = [];
				runtime.on("failure", (e) => {
					failures.push(e);
				});

				let outerFinallyRan = false;
				function* throwingCleanup(_draft: ChildState): IActionGenerator {
					try {
						try {
							yield {
								Type: "abortable"
							};
						} finally {
							// biome-ignore lint/correctness/noUnsafeFinally: the throw from a finally is the subject.
							throw new Error("cleanup blew up");
						}
					} finally {
						outerFinallyRan = true;
					}
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
				const actionPromise = runtime.processAction(throwingCleanup, () => runtime.state as any, childSetState, idAccessor);
				await Promise.resolve();
				cancelChild(runtime);

				await expect(actionPromise).resolves.toBeUndefined();
				expect(outerFinallyRan).toBe(true);

				expect(
					failures.map((failure) => [
						failure.Label,
						String(failure.Error),
						failure.Status,
						failure.Close
					])
				).toEqual([
					[
						"throwingCleanup",
						"Error: cleanup blew up",
						"cancelled",
						true
					]
				]);
			} finally {
				warn.mockRestore();
				dispose();
			}
		});
	});

	it("abandons a generator that keeps yielding in its close at the limit, and reports cancel/finally-yield-limit", async () => {
		await reactive.root(async (dispose) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const runtime = abortableRuntime();
				const diags: any[] = [];
				runtime.on("diag", (e) => {
					diags.push(e);
				});

				let yields = 0;
				function* runaway(_draft: ChildState): IActionGenerator {
					for (;;) {
						try {
							yields++;
							yield {
								Type: "abortable"
							};
						} finally {
							// biome-ignore lint/correctness/noUnsafeFinally lint/complexity/noUselessContinue: the continue overrides the close's return(), which is the subject.
							continue;
						}
					}
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
				const actionPromise = runtime.processAction(runaway, () => runtime.state as any, childSetState, idAccessor);
				await Promise.resolve();
				cancelChild(runtime);
				await expect(actionPromise).resolves.toBeUndefined();

				expect(yields).toBe(102);
				const hits = diags.filter((d) => d.code === "cancel/finally-yield-limit");
				expect(hits.length).toBe(1);
				expect(hits[0].data.actionName).toBe("runaway");
				expect(diags.filter((d) => d.code === "cancel/finally-yield").length).toBe(100);
				await Promise.resolve();
				expect(yields).toBe(102);
			} finally {
				warn.mockRestore();
				dispose();
			}
		});
	});

	describe("close writes journal as Cancelling-stamped steps", () => {
		const stepsOf = (records: IRecord[]) =>
			records.filter((r) => r.Kind === "step") as Extract<
				IRecord,
				{
					Kind: "step";
				}
			>[];

		function tapped(runtime: ReturnType<typeof abortableRuntime>): IRecord[] {
			const records: IRecord[] = [];
			runtime.on("record", (record) => records.push(record));
			return records;
		}

		it("journals a cancelled action's finally writes as one Cancelling-stamped step on its own branch", async () => {
			await reactive.root(async (dispose) => {
				try {
					const runtime = abortableRuntime();
					const records = tapped(runtime);

					function* writesOnClose(draft: ChildState): IActionGenerator {
						try {
							yield {
								Type: "abortable"
							};
						} finally {
							draft.Data = "cleaned";
						}
					}

					const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
					const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
					const actionPromise = runtime.processAction(writesOnClose, () => runtime.state as any, childSetState, idAccessor);
					await Promise.resolve();
					cancelChild(runtime);
					await actionPromise;

					const start = records.find((r) => r.Kind === "action:start")!;
					const effect = records.find((r) => r.Kind === "effect")!;
					const steps = stepsOf(records).filter((step) => step.ActionId === start.ActionId);
					expect(steps.length).toBe(1);
					expect(steps[0].Cancelling).toBe(true);
					expect(steps[0].ActionId).toBe(start.ActionId);
					expect(steps[0].BranchId).toBe(effect.BranchId);
					expect(steps[0].Changes).toEqual([
						{
							Path: [
								"Data"
							],
							Prev: "",
							Value: "cleaned"
						}
					]);
					const end = records.find((r) => r.Kind === "action:end")!;
					expect(steps[0].Seq).toBeLessThan(end.Seq);
				} finally {
					dispose();
				}
			});
		});

		it("appends nothing when the close writes nothing", async () => {
			await reactive.root(async (dispose) => {
				try {
					const runtime = abortableRuntime();
					const records = tapped(runtime);
					let finallyRan = false;

					function* silentClose(_draft: ChildState): IActionGenerator {
						try {
							yield {
								Type: "abortable"
							};
						} finally {
							finallyRan = true;
						}
					}

					const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
					const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
					const actionPromise = runtime.processAction(silentClose, () => runtime.state as any, childSetState, idAccessor);
					await Promise.resolve();
					cancelChild(runtime);
					await actionPromise;

					expect(finallyRan).toBe(true);
					const start = records.find((r) => r.Kind === "action:start")!;
					expect(stepsOf(records).filter((step) => step.ActionId === start.ActionId)).toEqual([]);
				} finally {
					dispose();
				}
			});
		});

		it("leaves an ordinary step unstamped — the flag marks the close and nothing else", async () => {
			await reactive.root(async (dispose) => {
				try {
					const runtime = abortableRuntime();
					runtime.registerImplementation("echo", () => "ok");
					const records = tapped(runtime);

					function* writes(draft: ChildState): IActionGenerator {
						draft.Data = "before";
						yield {
							Type: "echo"
						};
						draft.Data = "after";
					}

					const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
					const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
					await runtime.processAction(writes, () => runtime.state as any, childSetState, idAccessor);

					const steps = stepsOf(records);
					expect(steps.length).toBe(2);
					expect(steps.every((s) => !("Cancelling" in s))).toBe(true);
				} finally {
					dispose();
				}
			});
		});

		it("stamps the close writes of a branch its sibling's failure stopped and attributes them to that branch", async () => {
			await reactive.root(async (dispose) => {
				try {
					const runtime = abortableRuntime();
					const records = tapped(runtime);

					function* worker(draft: ChildState): IActionGenerator {
						try {
							yield {
								Type: "abortable"
							};
						} finally {
							draft.Data = "worker-cleanup";
						}
					}
					function* failer(): IActionGenerator {
						throw new Error("sibling");
					}
					function* orchestrate(draft: ChildState): IActionGenerator {
						try {
							yield* parallel(worker(draft), failer());
						} catch {}
					}

					const childSetState = sliceSetState(rootSetState(runtime), (x: ParentState) => x.Children[0]);
					const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
					await runtime.processAction(orchestrate, () => runtime.state as any, childSetState, idAccessor);

					const spawned = records.find((r) => r.Kind === "branch:start")!;
					const steps = stepsOf(records);
					expect(steps.length).toBe(1);
					expect(steps[0].Cancelling).toBe(true);
					expect(steps[0].ActionId).toBe(spawned.ActionId);
					expect(steps[0].BranchId).toBe(spawned.BranchId);
					expect(steps[0].BranchId).not.toBe(spawned.ParentBranchId);
					expect(steps[0].Changes[0].Value).toBe("worker-cleanup");
					expect(runtime.state.Children[0].Data).toBe("worker-cleanup");
				} finally {
					dispose();
				}
			});
		});
	});

	describe("on a slice's flush throw", () => {
		type IFlushState = {
			$Id: string;
			Note: string;
			IsLoading: number;
		};

		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

		function flushWorld(trips: (note: string) => boolean = (note) => note === "boom") {
			const runtime = createRuntime<IFlushState>(
				{
					$Id: "root",
					Note: "",
					IsLoading: 0
				},
				{
					onError: () => {}
				}
			);
			runtime.registerImplementation("echo", () => "ok");
			runtime.registerImplementation("park", () => new Promise(() => {}));
			const records: IRecord[] = [];
			runtime.on("record", (record) => records.push(record));
			const diags: any[] = [];
			runtime.on("diag", (event) => {
				diags.push(event);
			});
			const failures: IRuntimeEventOf<"failure">[] = [];
			runtime.on("failure", (event) => {
				failures.push(event);
			});
			reactive.effect(() => {
				const note = runtime.state.Note;
				if (trips(note)) {
					throw new Error(`flush failed: ${note}`);
				}
			});
			return {
				runtime,
				records,
				diags,
				failures
			};
		}

		const closeSteps = (records: IRecord[]) =>
			records.filter((r) => r.Kind === "step" && r.Cancelling === true) as Extract<
				IRecord,
				{
					Kind: "step";
				}
			>[];

		function* echo(): IActionGenerator {
			yield {
				Type: "echo"
			};
		}

		function* park(): IActionGenerator {
			yield {
				Type: "park"
			};
		}

		for (const shape of [
			"root",
			"child"
		] as const) {
			const asShape = (body: (draft: IFlushState) => IActionGenerator) =>
				shape === "root"
					? body
					: function* (draft: IFlushState): IActionGenerator {
							yield* parallel(body(draft));
						};
			const terminalKind = shape === "root" ? "action:end" : "branch:end";

			describe(`a ${shape} branch`, () => {
				it("runs a suspended generator's finally, not its catch, and journals the finally's writes", async () => {
					await reactive.root(async (dispose) => {
						try {
							const w = flushWorld();
							await settle();
							let caught = false;
							let finallyRuns = 0;
							const load = asShape(function* (draft) {
								draft.IsLoading++;
								try {
									yield* echo();
									draft.Note = "boom";
									yield* park();
								} catch {
									caught = true;
								} finally {
									finallyRuns++;
									draft.IsLoading--;
								}
							});

							await expect(w.runtime.dispatch(load, "root")).rejects.toThrow("flush failed: boom");

							expect(caught).toBe(false);
							expect(finallyRuns).toBe(1);
							expect(w.runtime.state.IsLoading).toBe(0);
							const steps = closeSteps(w.records);
							expect(steps.length).toBe(1);
							expect(steps[0].Changes).toEqual([
								{
									Path: [
										"IsLoading"
									],
									Prev: 1,
									Value: 0
								}
							]);
							const terminal = w.records.find((r) => r.Kind === terminalKind)!;
							expect(steps[0].Seq).toBeLessThan(terminal.Seq);
							expect((terminal as Record<string, unknown>).Status).toBe("errored");
						} finally {
							dispose();
						}
					});
				});

				it("keeps a throw from the body as it is: catch runs, finally runs once, and nothing is Cancelling-stamped", async () => {
					const w = flushWorld();
					let caught: unknown;
					let finallyRuns = 0;
					const load = asShape(function* (draft) {
						draft.IsLoading++;
						try {
							yield* echo();
							draft.Note = "written";
							throw new Error("body failed");
						} catch (error) {
							caught = error;
							throw error;
						} finally {
							finallyRuns++;
							draft.IsLoading--;
						}
					});

					await expect(w.runtime.dispatch(load, "root")).rejects.toThrow("body failed");

					expect((caught as Error).message).toBe("body failed");
					expect(finallyRuns).toBe(1);
					expect(w.runtime.state.IsLoading).toBe(0);
					expect(closeSteps(w.records)).toEqual([]);
				});

				it("keeps the original error when a finally write trips the effect again, and surfaces the second throw", async () => {
					await reactive.root(async (dispose) => {
						const deferred: (() => void)[] = [];
						const microtask = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
							deferred.push(callback);
						});
						try {
							const w = flushWorld((note) => note.startsWith("boom"));
							await settle();
							const load = asShape(function* (draft) {
								try {
									yield* echo();
									draft.Note = "boom";
									yield* park();
								} finally {
									draft.Note = "boom again";
								}
							});

							await expect(w.runtime.dispatch(load, "root")).rejects.toThrow(/^flush failed: boom$/);
							microtask.mockRestore();

							expect(w.runtime.state.Note).toBe("boom again");
							const steps = closeSteps(w.records);
							expect(steps.length).toBe(1);
							expect(steps[0].Changes[0].Value).toBe("boom again");
							const terminal = w.records.find((r) => r.Kind === terminalKind)!;
							expect(steps[0].Seq).toBeLessThan(terminal.Seq);
							const surfaced: string[] = [];
							for (const callback of deferred) {
								try {
									callback();
								} catch (error) {
									surfaced.push((error as Error).message);
								}
							}
							expect(surfaced).toEqual([
								"flush failed: boom again"
							]);
						} finally {
							microtask.mockRestore();
							dispose();
						}
					});
				});

				it("runs an outer finally when the throw is from the flush of a slice inside a nested generator", async () => {
					await reactive.root(async (dispose) => {
						try {
							const w = flushWorld();
							await settle();
							const load = asShape(function* (draft) {
								draft.IsLoading++;
								try {
									yield* (function* (): IActionGenerator {
										draft.Note = "boom";
										yield* park();
									})();
								} finally {
									draft.IsLoading--;
								}
							});

							await expect(w.runtime.dispatch(load, "root")).rejects.toThrow("flush failed: boom");

							expect(w.runtime.state.IsLoading).toBe(0);
							expect(closeSteps(w.records).length).toBe(1);
						} finally {
							dispose();
						}
					});
				});

				it("skips the rest of a finally that yields and reports both close diags without saying cancelled", async () => {
					await reactive.root(async (dispose) => {
						const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
						try {
							const w = flushWorld();
							await settle();
							const log: string[] = [];
							const load = asShape(function* (draft) {
								try {
									try {
										try {
											yield* echo();
											draft.Note = "boom";
											yield* park();
										} finally {
											log.push("yielding finally");
											yield* echo();
											log.push("after the yield");
										}
									} finally {
										log.push("throwing finally");
										// biome-ignore lint/correctness/noUnsafeFinally: the throw from a finally is the subject.
										throw new Error("cleanup blew up");
									}
								} finally {
									log.push("outer finally");
								}
							});

							await expect(w.runtime.dispatch(load, "root")).rejects.toThrow("flush failed: boom");

							expect(log).toEqual([
								"yielding finally",
								"throwing finally",
								"outer finally"
							]);
							const closeDiags = w.diags.filter((d) => d.code.startsWith("cancel/"));
							expect(closeDiags.map((d) => d.code)).toEqual([
								"cancel/finally-yield"
							]);
							for (const diag of closeDiags) {
								expect(diag.message).toContain("closed");
								expect(diag.message).not.toMatch(/cancel/i);
							}
							expect(
								w.failures.map((failure) => [
									String(failure.Error),
									failure.Status,
									failure.Close
								])
							).toEqual([
								[
									"Error: flush failed: boom",
									"errored",
									false
								],
								[
									"Error: cleanup blew up",
									"errored",
									true
								]
							]);
						} finally {
							warn.mockRestore();
							dispose();
						}
					});
				});

				it("abandons a runaway finally chain at the limit without saying cancelled", async () => {
					await reactive.root(async (dispose) => {
						const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
						try {
							const w = flushWorld();
							await settle();
							function* chain(depth: number): IActionGenerator {
								if (depth === 0) {
									return;
								}
								try {
									yield* echo();
								} finally {
									yield* chain(depth - 1);
								}
							}
							const load = asShape(function* (draft) {
								try {
									yield* echo();
									draft.Note = "boom";
									yield* park();
								} finally {
									yield* chain(FINALLY_YIELD_LIMIT + 5);
								}
							});

							await expect(w.runtime.dispatch(load, "root")).rejects.toThrow("flush failed: boom");

							const hits = w.diags.filter((d) => d.code === "cancel/finally-yield-limit");
							expect(hits.length).toBe(1);
							expect(hits[0].message).toContain("closed");
							expect(hits[0].message).not.toMatch(/cancel/i);
						} finally {
							warn.mockRestore();
							dispose();
						}
					});
				});
			});
		}

		it("journals a cancelled branch's close writes when the close's own flush throws", async () => {
			await reactive.root(async (dispose) => {
				try {
					const w = flushWorld();
					await settle();
					w.runtime.registerImplementation("abortable", (_e, action) => {
						return new Promise((_resolve, reject) => {
							action?.signal.addEventListener("abort", () => {
								reject(new DOMException("aborted", "AbortError"));
							});
						});
					});
					function* worker(draft: IFlushState): IActionGenerator {
						try {
							yield {
								Type: "abortable"
							};
						} finally {
							draft.Note = "boom";
						}
					}
					function* failer(): IActionGenerator {
						throw new Error("sibling");
					}
					function* load(draft: IFlushState): IActionGenerator {
						try {
							yield* parallel(worker(draft), failer());
						} catch {}
					}
					await w.runtime.dispatch(load, "root");
					await settle();

					expect(w.runtime.state.Note).toBe("boom");
					const steps = closeSteps(w.records);
					expect(steps.length).toBe(1);
					expect(steps[0].Changes[0].Value).toBe("boom");
				} finally {
					dispose();
				}
			});
		});
	});
});
