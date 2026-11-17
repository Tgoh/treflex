import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEffect } from "../../src/Types/IEffect";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { start } from "../../src/Effects/start";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { settled } from "../../src/Testing/createTestRuntime";
import { rootSetState, treeWrite } from "../testHelpers";

type Child = {
	$Id: string;
	Data: string;
};
type Parent = {
	$Id: string;
	Children: Child[];
};

describe("start", () => {
	it("spawns a detached action that runs against the target entity", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<Parent>({
					$Id: "parent",
					Children: [
						{
							$Id: "child-1",
							Data: ""
						}
					]
				});

				function* childWrite(draft: Child): IActionGenerator {
					draft.Data = "written by start";
				}
				function* parentStarts(_draft: Parent): IActionGenerator {
					yield* start(childWrite, "child-1");
				}

				await runtime.processAction(
					parentStarts,
					() => runtime.state,
					rootSetState(runtime),
					() => "parent"
				);
				await Promise.resolve();

				expect(runtime.state.Children[0].Data).toBe("written by start");
			} finally {
				dispose();
			}
		});
	});

	it("starts against the $Id of a target given as a node", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<Parent>({
					$Id: "parent",
					Children: [
						{
							$Id: "child-1",
							Data: ""
						},
						{
							$Id: "child-2",
							Data: ""
						}
					]
				});

				let entityId: unknown;
				function* childWrite(draft: Child, data: string): IActionGenerator {
					draft.Data = data;
				}
				function* parentStarts(draft: Parent): IActionGenerator {
					const effects = start(childWrite, draft.Children[1], "by node");
					const descriptor = effects.next().value;
					entityId = descriptor?.EntityId;
					yield descriptor as IEffect;
				}

				await runtime.processAction(
					parentStarts,
					() => runtime.state,
					rootSetState(runtime),
					() => "parent"
				);
				await Promise.resolve();

				expect(entityId).toBe("child-2");
				expect(runtime.state.Children[0].Data).toBe("");
				expect(runtime.state.Children[1].Data).toBe("by node");
			} finally {
				dispose();
			}
		});
	});

	it("returns immediately — the caller does not await the started action", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<Parent>({
					$Id: "parent",
					Children: [
						{
							$Id: "child-1",
							Data: ""
						}
					]
				});
				runtime.registerImplementation("slow", () => new Promise((r) => setTimeout(() => r("done"), 30)));

				const order: string[] = [];
				function* childSlow(draft: Child): IActionGenerator {
					const result: string = yield {
						Type: "slow"
					};
					draft.Data = result;
					order.push("start-finished");
				}
				function* parentStarts(_draft: Parent): IActionGenerator {
					yield* start(childSlow, "child-1");
					order.push("caller-finished");
				}

				await runtime.processAction(
					parentStarts,
					() => runtime.state,
					rootSetState(runtime),
					() => "parent"
				);

				expect(order).toEqual([
					"caller-finished"
				]);
				expect(runtime.state.Children[0].Data).toBe("");

				await new Promise((r) => setTimeout(r, 60));

				expect(order).toEqual([
					"caller-finished",
					"start-finished"
				]);
				expect(runtime.state.Children[0].Data).toBe("done");
			} finally {
				dispose();
			}
		});
	});

	it("cancels the started action when its target leaves the state tree", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<Parent>(
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

				let startedSignal: AbortSignal | undefined;
				runtime.registerImplementation("abortable", (_e, action) => {
					startedSignal = action?.signal;
					return new Promise((_resolve, reject) => {
						action?.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
					});
				});

				function* childLoop(draft: Child): IActionGenerator {
					yield {
						Type: "abortable"
					};
					draft.Data = "unreachable — silent-cancelled before this runs";
				}
				function* parentStarts(_draft: Parent): IActionGenerator {
					yield* start(childLoop, "child-1");
				}

				await runtime.processAction(
					parentStarts,
					() => runtime.state,
					rootSetState(runtime),
					() => "parent"
				);
				await Promise.resolve();

				expect(startedSignal).toBeDefined();
				expect(startedSignal?.aborted).toBe(false);

				treeWrite(runtime, (s: Parent) => {
					s.Children = [];
				});
				await settled();

				expect(startedSignal?.aborted).toBe(true);
			} finally {
				dispose();
			}
		});
	});

	it("leaves a started action running when a different entity is disposed", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<Parent>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "child-1",
								Data: ""
							},
							{
								$Id: "child-2",
								Data: ""
							}
						]
					},
					{
						onError: () => {}
					}
				);

				let startedSignal: AbortSignal | undefined;
				runtime.registerImplementation("abortable", (_e, action) => {
					startedSignal = action?.signal;
					return new Promise((_resolve, reject) => {
						action?.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
					});
				});

				function* childLoop(_draft: Child): IActionGenerator {
					yield {
						Type: "abortable"
					};
				}
				function* parentStarts(_draft: Parent): IActionGenerator {
					yield* start(childLoop, "child-1");
				}

				await runtime.processAction(
					parentStarts,
					() => runtime.state,
					rootSetState(runtime),
					() => "parent"
				);
				await Promise.resolve();
				expect(startedSignal?.aborted).toBe(false);

				treeWrite(runtime, (s: Parent) => {
					s.Children = s.Children.filter((c) => c.$Id !== "child-2");
				});
				await settled();

				expect(startedSignal?.aborted).toBe(false);
			} finally {
				dispose();
			}
		});
	});

	it("raises a diag and is a no-op when the target $Id is not in the state tree", async () => {
		await createRoot(async (dispose) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const runtime = createRuntime<Parent>({
					$Id: "parent",
					Children: []
				});
				const diags: unknown[] = [];
				runtime.on("diag", (event) => diags.push(event));

				let ran = false;
				function* orphan(_draft: Child): IActionGenerator {
					ran = true;
				}
				function* parentStarts(_draft: Parent): IActionGenerator {
					yield* start(orphan, "ghost");
				}

				await runtime.processAction(
					parentStarts,
					() => runtime.state,
					rootSetState(runtime),
					() => "parent"
				);
				await Promise.resolve();

				expect(diags).toMatchObject([
					{
						severity: "warn",
						code: "dispatch/unresolved-entity",
						data: {
							entityId: "ghost"
						}
					}
				]);
				expect(ran).toBe(false);
			} finally {
				warn.mockRestore();
				dispose();
			}
		});
	});

	it("stamps a started action's start record with StartedBy, and leaves other dispatches unstamped", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<Parent>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "child-1",
								Data: ""
							}
						]
					},
					{}
				);

				const starts: {
					Name: string | null;
					StartedBy: string | undefined;
					ActionId: string;
				}[] = [];
				runtime.on("record", (record) => {
					if (record.Kind !== "action:start") return;
					starts.push({
						Name: record.Name,
						StartedBy: record.StartedBy,
						ActionId: record.ActionId
					});
				});

				function* grandchildWrite(draft: Child): IActionGenerator {
					draft.Data = "deep";
				}
				function* childWrite(draft: Child): IActionGenerator {
					draft.Data = "started";
					yield* start(grandchildWrite, "child-1");
				}
				function* parentStarts(_draft: Parent): IActionGenerator {
					yield* start(childWrite, "child-1");
				}

				await runtime.processAction(
					parentStarts,
					() => runtime.state,
					rootSetState(runtime),
					() => "parent"
				);
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();

				const byName = (name: string) => starts.find((s) => s.Name === name);
				const root = byName("parentStarts");
				const child = byName("childWrite");
				const grandchild = byName("grandchildWrite");

				// A user dispatch is unattributed; each start names its starter,
				// and the chain nests (a nested start's dispatch lands after the
				// outer clear, so it must NOT inherit the outer origin).
				expect(root?.StartedBy).toBeUndefined();
				expect(child?.StartedBy).toBe(root?.ActionId);
				expect(grandchild?.StartedBy).toBe(child?.ActionId);

				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});
});
