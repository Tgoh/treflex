import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { createActivityLog } from "../../src/Runtime/createActivityLog";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { captureSurfaced, minted, rootSetState } from "../testHelpers";

type ChildState = {
	$Id: string;
	Data: string;
	Meta?: {
		Tag: string;
	};
};
type TestState = {
	$Id: string;
	Data: string;
	Children: ChildState[];
	Backup?: {
		Tag: string;
	};
};

const initialState = (): TestState => ({
	$Id: "parent",
	Data: "",
	Children: [
		{
			$Id: "child-1",
			Data: "one"
		},
		{
			$Id: "child-2",
			Data: "two"
		}
	]
});

function createBarrier() {
	let resolve!: (v: any) => void;
	let signalStarted!: () => void;
	const started = new Promise<void>((r) => {
		signalStarted = r;
	});
	const promise = new Promise<any>((res) => {
		resolve = res;
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

function dispatch<A extends any[], R>(
	runtime: IRuntime<TestState>,
	action: (draft: TestState, ...args: A) => Generator<any, R, any>,
	entityId = "parent",
	...args: A
): Promise<R | undefined> {
	return runtime.processAction(
		action as any,
		() => runtime.state,
		rootSetState(runtime),
		() => entityId,
		...args
	);
}

function tapped(): IRuntime<TestState> {
	const runtime = createRuntime<TestState>(initialState(), {});
	runtime.on("record", () => {});
	return runtime;
}

function draftWarns(spy: {
	mock: {
		calls: unknown[][];
	};
}): string[] {
	return spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes("[treflex] draft/"));
}

describe("stale-reference tripwire", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("warns stale-path-write for a held reference to a replaced node", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = tapped();
				function* heldReplaced(draft: TestState): IActionGenerator {
					const held = draft.Children[0];
					draft.Children[0] = minted("child-other", {
						Data: "fresh"
					});
					held.Data = "stale write";
				}
				await dispatch(runtime, heldReplaced);

				const warns = draftWarns(warn);
				expect(warns).toHaveLength(1);
				expect(warns[0]).toContain("draft/stale-path-write");
				expect(warns[0]).toContain("[Children.0]");
			} finally {
				dispose();
			}
		});
	});

	it("warns orphaned-write for a held reference whose node left the tree", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = tapped();
				function* heldRemoved(draft: TestState): IActionGenerator {
					const held = draft.Children[1];
					draft.Children.pop();
					held.Data = "orphaned write";
				}
				await dispatch(runtime, heldRemoved);

				const warns = draftWarns(warn);
				expect(warns).toHaveLength(1);
				expect(warns[0]).toContain("draft/orphaned-write");
				expect(warns[0]).toContain("[Children.1]");
			} finally {
				dispose();
			}
		});
	});

	it("warns on a delete through a held reference to a replaced node", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = tapped();
				function* heldDelete(draft: TestState): IActionGenerator {
					const held = draft.Children[0];
					draft.Children[0] = minted("child-other", {
						Data: "fresh"
					});
					delete (held as Partial<ChildState>).Data;
				}
				await dispatch(runtime, heldDelete);

				const warns = draftWarns(warn);
				expect(warns).toHaveLength(1);
				expect(warns[0]).toContain("draft/stale-path-delete");
			} finally {
				dispose();
			}
		});
	});

	it("throws across a genuine park when another action replaced the held node — no warn, no write", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});
				runtime.registerImplementation("hang", () => barrier.run());

				function* hang(): IActionGenerator {
					yield {
						Type: "hang"
					};
				}
				function* parkThenWrite(draft: TestState) {
					const held = draft.Children[0];
					yield* open(hang());
					held.Data = "written after the park";
				}
				function* replaceChild(draft: TestState): IActionGenerator {
					draft.Children[0] = minted("child-other", {
						Data: "replacement"
					});
				}

				const parked = dispatch(runtime, parkThenWrite);
				await barrier.started;
				await dispatch(runtime, replaceChild);
				barrier.resolve(undefined);

				await expect(parked).rejects.toThrow(/the node left the state tree/);
				expect(draftWarns(warn)).toHaveLength(0);
				expect(runtime.state.Children[0]).toEqual({
					$Id: "~child-other",
					Data: "replacement"
				});
			} finally {
				dispose();
			}
		});
	});

	it("stays silent for a re-derived reference to a moved node", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = tapped();
				function* rederived(draft: TestState): IActionGenerator {
					const first = draft.Children[0];
					draft.Children.unshift(
						minted("child-0", {
							Data: first.Data
						})
					);
					draft.Children[1].Data = "moved and re-derived";
				}
				await dispatch(runtime, rederived);

				expect(draftWarns(warn)).toHaveLength(0);
			} finally {
				dispose();
			}
		});
	});

	it("stays silent for an unchanged held reference across a park", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const barrier = createBarrier();
				const runtime = tapped();
				runtime.registerImplementation("hang", () => barrier.run());

				function* heldUnchanged(draft: TestState): IActionGenerator {
					const held = draft.Children[0];
					yield {
						Type: "hang"
					};
					held.Data = "still here";
				}
				const parked = dispatch(runtime, heldUnchanged);
				await barrier.started;
				barrier.resolve(undefined);
				await parked;

				expect(draftWarns(warn)).toHaveLength(0);
			} finally {
				dispose();
			}
		});
	});

	it("stays silent when a node is swapped out and back (same raw object)", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = tapped();
				function* swapBack(draft: TestState): IActionGenerator {
					const held = draft.Children[0];
					const popped = draft.Children.shift()!;
					draft.Children.unshift(popped);
					held.Data = "same node, same slot";
				}
				await dispatch(runtime, swapBack);

				expect(draftWarns(warn)).toHaveLength(0);
			} finally {
				dispose();
			}
		});
	});

	const taps: Record<string, (runtime: IRuntime<TestState>) => void> = {
		"an unfiltered tap": (runtime) => {
			runtime.on("record", () => {});
		},
		"a tap of action:end only": (runtime) => {
			runtime.on("record", () => {}, {
				kinds: [
					"action:end"
				]
			});
		},
		"a tap of step only": (runtime) => {
			runtime.on("record", () => {}, {
				kinds: [
					"step"
				]
			});
		}
	};
	for (const [name, attach] of Object.entries(taps)) {
		it(`warns stale-path-write and orphaned-write under ${name}, whatever kinds it takes`, async () => {
			await createRoot(async (dispose) => {
				try {
					const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
					const runtime = createRuntime<TestState>(initialState());
					attach(runtime);
					function* heldReplacedAndRemoved(draft: TestState): IActionGenerator {
						const replaced = draft.Children[0];
						const removed = draft.Children[1];
						draft.Children[0] = minted("child-other", {
							Data: "fresh"
						});
						draft.Children.pop();
						replaced.Data = "stale write";
						removed.Meta = {
							Tag: "orphaned"
						};
					}
					await dispatch(runtime, heldReplacedAndRemoved);
					const codes = draftWarns(warn).map((message) => /draft\/[a-z-]+/.exec(message)?.[0]);
					expect(codes).toEqual([
						"draft/stale-path-write",
						"draft/orphaned-write"
					]);
				} finally {
					dispose();
				}
			});
		});
	}

	it("warns stale-path-write under the activity log's tap", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = createRuntime<TestState>(initialState());
				createActivityLog(runtime);
				function* heldReplaced(draft: TestState): IActionGenerator {
					const held = draft.Children[0];
					draft.Children[0] = minted("child-other", {
						Data: "fresh"
					});
					held.Data = "stale write";
				}
				await dispatch(runtime, heldReplaced);
				expect(draftWarns(warn).map((message) => /draft\/[a-z-]+/.exec(message)?.[0])).toEqual([
					"draft/stale-path-write"
				]);
			} finally {
				dispose();
			}
		});
	});

	it("stays silent with no tap", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = createRuntime<TestState>(initialState());
				function* heldReplaced(draft: TestState): IActionGenerator {
					const held = draft.Children[0];
					draft.Children[0] = minted("child-other", {
						Data: "fresh"
					});
					held.Data = "stale write";
				}
				await dispatch(runtime, heldReplaced);

				expect(draftWarns(warn)).toEqual([]);
			} finally {
				dispose();
			}
		});
	});

	it("warns orphaned-delete for a delete through a held reference whose node left the tree", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = tapped();
				function* heldRemovedDelete(draft: TestState): IActionGenerator {
					const held = draft.Children[1];
					draft.Children.pop();
					delete (held as Partial<ChildState>).Data;
				}
				await dispatch(runtime, heldRemovedDelete);

				const warns = draftWarns(warn);
				expect(warns).toHaveLength(1);
				expect(warns[0]).toContain("draft/orphaned-delete");
			} finally {
				dispose();
			}
		});
	});

	it("stays silent when a sibling insert moves a parked action's slice (positional accessor)", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const barrier = createBarrier();
				const runtime = tapped();
				runtime.registerImplementation("hang", () => barrier.run());

				function* childStory(draft: ChildState): IActionGenerator {
					yield {
						Type: "hang"
					};
					draft.Data = "after the park";
				}
				function* insertSibling(draft: TestState): IActionGenerator {
					draft.Children.unshift(
						minted("child-0", {
							Data: "new"
						})
					);
				}
				const parked = runtime.processAction(
					childStory as any,
					() => runtime.state.Children[1],
					sliceSetState(rootSetState(runtime), (s: TestState) => s.Children[1]),
					() => "child-2"
				);
				await barrier.started;
				await dispatch(runtime, insertSibling);
				barrier.resolve(undefined);
				await parked;

				expect(draftWarns(warn)).toHaveLength(0);
				expect(runtime.state.Children.find((c) => c.$Id === "child-2")!.Data).toBe("after the park");
			} finally {
				dispose();
			}
		});
	});

	it("stays silent for a lookup-derived ($Id-keyed) slice setter across the same move", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const barrier = createBarrier();
				const runtime = tapped() as IRuntimeInternal<TestState>;
				runtime.registerImplementation("hang", () => barrier.run());

				function* childStory(draft: ChildState): IActionGenerator {
					yield {
						Type: "hang"
					};
					draft.Data = "after the park";
				}
				function* insertSibling(draft: TestState): IActionGenerator {
					draft.Children.unshift(
						minted("child-0", {
							Data: "new"
						})
					);
				}
				const cell = runtime.get("runtime/stateIdLookup")()["child-2"];
				expect(cell).toBeDefined();
				const parked = runtime.processAction(
					childStory as any,
					() => cell.state,
					cell.setState,
					() => "child-2"
				);
				await barrier.started;
				await dispatch(runtime as IRuntime<TestState>, insertSibling);
				barrier.resolve(undefined);
				await parked;

				expect(draftWarns(warn)).toHaveLength(0);
				expect(runtime.state.Children.find((c) => c.$Id === "child-2")!.Data).toBe("after the park");
			} finally {
				dispose();
			}
		});
	});

	it("pin: a sibling branch's navigation refreshes a held reference's path — the write journals the CURRENT path, silently", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const barrier = createBarrier();
				const runtime = tapped();
				const records: IRecord[] = [];
				runtime.on("record", (r) => records.push(r as IRecord));
				runtime.registerImplementation("hangHold", () => barrier.run());

				function* holder(draft: TestState): Generator<any, void, any> {
					const held = draft.Children[1];
					yield {
						Type: "hangHold"
					};
					held.Data = "written through held";
				}
				function* mover(draft: TestState): Generator<any, void, any> {
					draft.Children.unshift(
						minted("child-0", {
							Data: "new"
						})
					);
					const rederived = draft.Children[2];
					draft.Data = rederived.Data;
				}
				function* launderStory(draft: TestState): IActionGenerator {
					yield* parallel(holder(draft), mover(draft));
				}
				const pending = dispatch(runtime, launderStory);
				await barrier.started;
				barrier.resolve(undefined);
				await pending;

				expect(draftWarns(warn)).toHaveLength(0);
				const steps = records.filter((r) => r.Kind === "step") as Extract<
					IRecord,
					{
						Kind: "step";
					}
				>[];
				const write = steps.flatMap((s) => s.Changes).find((c) => !c.Deleted && c.Value === "written through held");
				expect(write).toBeDefined();
				expect(write!.Path).toEqual([
					"Children",
					"2",
					"Data"
				]);
			} finally {
				dispose();
			}
		});
	});

	it("pin: a READ through a stale held reference neither warns nor fails — it sees the old node", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = tapped();

				function* staleRead(draft: TestState): IActionGenerator {
					const held = draft.Children[0];
					draft.Children[0] = minted("child-other", {
						Data: "fresh"
					});
					draft.Data = held.Data;
				}
				await dispatch(runtime, staleRead);

				expect(draftWarns(warn)).toHaveLength(0);
				expect(runtime.state.Data).toBe("one");
			} finally {
				dispose();
			}
		});
	});

	it("pin: an aliased node's slice is refused, and none of its writes reach the record", async () => {
		await createRoot(async (dispose) => {
			try {
				const surfaced = captureSurfaced();
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = tapped();
				const records: IRecord[] = [];
				runtime.on("record", (r) => records.push(r as IRecord));

				function* aliasStory(draft: TestState): IActionGenerator {
					draft.Children[0].Meta = {
						Tag: "original"
					};
					draft.Backup = draft.Children[0].Meta;
					const viaChild = draft.Children[0].Meta;
					const viaBackup = draft.Backup;
					expect(viaChild).toBe(viaBackup);
					viaChild.Tag = "written";
				}
				await expect(dispatch(runtime, aliasStory)).rejects.toThrow(StateAliasError);

				expect(draftWarns(warn)).toHaveLength(0);
				expect(records.filter((r) => r.Kind === "step")).toEqual([]);
				expect((runtime.state as TestState).Backup).toBeUndefined();
				expect(surfaced).toEqual([]);
			} finally {
				dispose();
			}
		});
	});
});
