import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it, vi } from "vitest";
import { publish } from "../../src/Effects/publish";
import { publishToNearest } from "../../src/Effects/publishToNearest";
import { startTimer } from "../../src/Effects/startTimer";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import * as reactive from "../reactive";
import { rootSetState } from "../testHelpers";

const publishAny = publish as any;
const publishToNearestAny = publishToNearest as any;
const startTimerAny = startTimer as any;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function bump(id: string) {
	return receiver<any>(id)({
		["Ping" as any]: function* (draft: any) {
			draft.Seen++;
		}
	});
}

describe("a fan-out that is only partly unresolved", () => {
	it("delivers to every resolvable bound entity, names only the rest, and reports the receiver once", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<any>(
					{
						$Id: "Root",
						A: {
							$Id: "A",
							Seen: 0
						},
						B: {
							$Id: "B",
							Seen: 0
						}
					},
					{}
				);
				const Broken = bump("BrokenReceiver");
				const Working = bump("WorkingReceiver");
				runtime.registerReceiver(Working);
				const records: any[] = [];
				const diags: any[] = [];
				runtime.on("record", (record) => records.push(record));
				runtime.on("diag", (event) => diags.push(event));

				function* setup(draft: any): IActionGenerator {
					bind(draft.A, Broken);
					bind(draft.B, Working);
				}
				function* send(_draft: any): IActionGenerator {
					yield* publishAny("Ping");
				}

				await runtime.processAction(
					setup,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await runtime.processAction(
					send,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await runtime.processAction(
					send,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await settle();

				expect(runtime.state.A.Seen).toBe(0);
				expect(runtime.state.B.Seen).toBe(2);

				const [fanOut] = records.filter((record) => record.Kind === "message:deliver");
				expect(fanOut.RecipientIds).toEqual([
					"B"
				]);
				expect(fanOut.UnresolvedIds).toEqual([
					"A"
				]);
				expect(diags.filter((event) => event.code === "receiver/unresolved").map((event) => event.data)).toStrictEqual([
					{
						receiverId: "BrokenReceiver",
						ownerIds: [
							"A"
						],
						count: 1,
						kind: "binding"
					}
				]);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("skips a bound entity an earlier receiver removed mid-fan-out, without a receiver:error", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<any>(
					{
						$Id: "Root",
						Seen: 0,
						Items: [
							{
								$Id: "Doomed",
								Seen: 0
							}
						]
					},
					{}
				);
				// Pruner registers first, so Root hears the publish before Doomed, and a receiver's
				// first slice runs synchronously: Doomed is gone by the time the loop reaches it.
				const Pruner = receiver<any>("PrunerReceiver")({
					["Ping" as any]: function* (draft: any) {
						draft.Seen++;
						draft.Items = [];
					}
				});
				const Victim = bump("VictimReceiver");
				runtime.registerReceiver(Pruner);
				runtime.registerReceiver(Victim);
				const records: any[] = [];
				runtime.on("record", (record) => records.push(record));

				function* setup(draft: any): IActionGenerator {
					bind(draft, Pruner);
					bind(draft.Items[0], Victim);
				}
				function* send(_draft: any): IActionGenerator {
					yield* publishAny("Ping");
				}

				await runtime.processAction(
					setup,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await runtime.processAction(
					send,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await settle();

				expect(runtime.state.Seen).toBe(1);
				expect(runtime.state.Items).toHaveLength(0);
				const [fanOut] = records.filter((record) => record.Kind === "message:deliver");
				expect(fanOut.RecipientIds).toEqual([
					"Root",
					"Doomed"
				]);
				expect(fanOut.UnresolvedIds).toBeUndefined();
				expect(records.filter((record) => record.Kind === "receiver:error")).toEqual([]);
				expect(records.filter((record) => record.Kind === "entity:dispose").map((record) => record.EntityId)).toContain("Doomed");
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});
});

describe("the timer miss path's dedupe keys", () => {
	it("do not collide across ids and receivers that share a joined spelling", async () => {
		vi.useFakeTimers();
		try {
			await reactive.root(async (dispose) => {
				try {
					// ("x y", "r") and ("x", "y r") join to the same string under a
					// space-separated key, so a naive key reports one of the two.
					const runtime = createRuntime<any>({
						$Id: "Root",
						First: {
							$Id: "x y",
							Seen: 0
						},
						Second: {
							$Id: "x",
							Seen: 0
						}
					});
					const diags: any[] = [];
					runtime.on("diag", (event) => diags.push(event));

					function* arm(draft: any): IActionGenerator {
						yield* startTimerAny(draft.First, "Ping", bump("r"), 1000);
						yield* startTimerAny(draft.Second, "Ping", bump("y r"), 1000);
					}
					await runtime.processAction(
						arm,
						() => runtime.state,
						rootSetState(runtime),
						() => "Root"
					);
					await vi.advanceTimersByTimeAsync(1100);

					expect(diags.filter((event) => event.code === "receiver/unresolved")).toHaveLength(2);
					runtime.dispose();
				} finally {
					dispose();
				}
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the timer scheduler's miss path", () => {
	it("reports once, keeps the row, appends no dispatch record, and heals on registration", async () => {
		vi.useFakeTimers();
		try {
			await reactive.root(async (dispose) => {
				try {
					const runtime = createRuntime<any>(
						{
							$Id: "Root",
							Ticks: 0
						},
						{}
					);
					const Tick = receiver<any>("TickReceiver")({
						["Beat" as any]: function* (draft: any) {
							draft.Ticks++;
						}
					});
					const records: any[] = [];
					const diags: any[] = [];
					runtime.on("record", (record) => records.push(record));
					runtime.on("diag", (event) => diags.push(event));

					function* arm(draft: any): IActionGenerator {
						yield* startTimerAny(draft, "Beat", Tick, 1000);
					}
					await runtime.processAction(
						arm,
						() => runtime.state,
						rootSetState(runtime),
						() => "Root"
					);

					await vi.advanceTimersByTimeAsync(2500);
					expect(runtime.state.Ticks).toBe(0);
					const unresolved = diags.filter((event) => event.code === "receiver/unresolved");
					expect(unresolved).toHaveLength(1);
					expect(unresolved[0].data).toEqual({
						key: "Beat",
						ownerId: "Root",
						receiverId: "TickReceiver",
						kind: "timer"
					});
					expect(records.filter((record) => record.Kind === "message:deliver")).toEqual([]);

					runtime.registerReceiver(Tick);
					await vi.advanceTimersByTimeAsync(1100);
					expect(runtime.state.Ticks).toBe(1);
					expect(records.filter((record) => record.Kind === "message:deliver")).toHaveLength(1);
					runtime.dispose();
				} finally {
					dispose();
				}
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Action/Error escalation into an unresolved ancestor", () => {
	it("is named in UnresolvedIds and passed, reaching the working error boundary above it", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<any>(
					{
						$Id: "Root",
						Seen: 0,
						Mid: {
							$Id: "Mid",
							Seen: 0,
							Leaf: {
								$Id: "Leaf"
							}
						}
					},
					{}
				);
				const errorBoundary = (id: string) =>
					receiver<any>(id)({
						["Action/Error" as any]: function* (draft: any) {
							draft.Seen++;
						}
					});
				const Working = errorBoundary("WorkingErrorBoundary");
				const Broken = errorBoundary("BrokenErrorBoundary");
				runtime.registerReceiver(Working);
				const records: any[] = [];
				const diags: any[] = [];
				runtime.on("record", (record) => records.push(record));
				runtime.on("diag", (event) => diags.push(event));

				function* setup(draft: any): IActionGenerator {
					bind(draft, Working);
					bind(draft.Mid, Broken);
				}
				function* fails(_draft: any): IActionGenerator {
					throw new Error("boom");
				}
				await runtime.processAction(
					setup,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await runtime
					.processAction(
						fails,
						() => runtime.state.Mid.Leaf,
						rootSetState(runtime) as any,
						() => "Leaf"
					)
					.catch(() => {});
				await settle();

				expect(runtime.state.Mid.Seen).toBe(0);
				expect(runtime.state.Seen).toBe(1);
				expect(diags.filter((event) => event.code === "receiver/unresolved" && event.data.kind === "publish")).toEqual([]);
				const [fanOut] = records.filter((record) => record.Kind === "message:deliver" && record.Topic === "Action/Error");
				expect(fanOut.RecipientIds).toEqual([
					"Root"
				]);
				expect(fanOut.UnresolvedIds).toEqual([
					"Mid"
				]);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});
});

describe("publishToNearest past an unresolved ancestor", () => {
	it("still does not fall through, which the shadow test in messaging.test.ts also pins", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<any>({
					$Id: "Root",
					Seen: 0,
					Mid: {
						$Id: "Mid",
						Seen: 0,
						Leaf: {
							$Id: "Leaf"
						}
					}
				});
				const Working = bump("WorkingReceiver");
				runtime.registerReceiver(Working);

				function* setup(draft: any): IActionGenerator {
					bind(draft, Working);
					bind(draft.Mid, bump("BrokenReceiver"));
				}
				function* shout(draft: any): IActionGenerator {
					yield* publishToNearestAny(draft.Mid.Leaf, "Ping");
				}
				await runtime.processAction(
					setup,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await runtime.processAction(
					shout,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await settle();

				expect(runtime.state.Seen).toBe(0);
				expect(runtime.state.Mid.Seen).toBe(0);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});
});
