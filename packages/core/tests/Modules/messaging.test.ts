import type { IActionGenerator, IOpenGenerator } from "../../src/Types/IAction";
import type { IReceiver } from "../../src/Types/IReceiver";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { publish } from "../../src/Effects/publish";
import { publishToNearest } from "../../src/Effects/publishToNearest";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { settled } from "../../src/Testing/createTestRuntime";
import * as reactive from "../reactive";
import { rootSetState } from "../testHelpers";

const publishAny = publish as unknown as (topic: string) => Generator<any, void, any>;
const publishToNearestAny = publishToNearest as unknown as (
	entity: {
		$Id: string;
	},
	topic: string
) => Generator<any, void, any>;

async function withRuntime<T extends object>(
	initial: T,
	body: (runtime: ReturnType<typeof createRuntime<T>>) => Promise<void>
): Promise<void> {
	await reactive.root(async (dispose) => {
		try {
			await body(createRuntime(initial));
		} finally {
			dispose();
		}
	});
}

describe("publish", () => {
	it("populates ctx.publisher from action.entityId", async () => {
		await withRuntime(
			{
				$Id: "Sender",
				Receiver: {
					$Id: "Receiver",
					SeenPublisherId: ""
				}
			},
			async (runtime) => {
				const R = receiver<{
					$Id: string;
					SeenPublisherId: string;
				}>("R")({
					["Ping" as any]: function* (draft: any, _e: any, ctx: any) {
						draft.SeenPublisherId = ctx.publisher.Id;
					}
				});
				runtime.registerReceiver(R);

				function* setup(draft: any): IActionGenerator {
					bind(draft.Receiver, R);
				}
				function* sendFromSender(_draft: any): IActionGenerator {
					yield* publishAny("Ping");
				}

				await runtime.processAction(
					setup,
					() => runtime.state,
					rootSetState(runtime),
					() => "Sender"
				);
				await runtime.processAction(
					sendFromSender,
					() => runtime.state,
					rootSetState(runtime),
					() => "Sender"
				);
				await Promise.resolve();
				expect((runtime.state as any).Receiver.SeenPublisherId).toBe("Sender");
			}
		);
	});
});

describe("publishToNearest", () => {
	it("does not deliver to the publisher itself when the publisher is bound to the topic", async () => {
		await withRuntime(
			{
				$Id: "Parent",
				Child: {
					$Id: "Child",
					Hit: false
				}
			},
			async (runtime) => {
				const SelfReceiver = receiver<{
					$Id: string;
					Hit: boolean;
				}>("SelfReceiver")({
					["Ping" as any]: function* (draft: any) {
						draft.Hit = true;
					}
				});
				runtime.registerReceiver(SelfReceiver);

				function* setup(draft: any): IActionGenerator {
					bind(draft.Child, SelfReceiver);
					yield* publishToNearestAny(draft.Child, "Ping");
				}

				await runtime.processAction(
					setup,
					() => runtime.state,
					rootSetState(runtime),
					() => "Parent"
				);
				expect((runtime.state as any).Child.Hit).toBe(false);
			}
		);
	});

	it("delivers to the nearest bound ancestor, skipping self", async () => {
		await withRuntime(
			{
				$Id: "Parent",
				Hit: false,
				Child: {
					$Id: "Child",
					Hit: false
				}
			},
			async (runtime) => {
				const ParentReceiver = receiver<{
					$Id: string;
					Hit: boolean;
				}>("ParentReceiver")({
					["Ping" as any]: function* (draft: any) {
						draft.Hit = true;
					}
				});
				runtime.registerReceiver(ParentReceiver);

				function* setup(draft: any): IActionGenerator {
					bind(draft, ParentReceiver);
					bind(draft.Child, ParentReceiver);
					yield* publishToNearestAny(draft.Child, "Ping");
				}

				await runtime.processAction(
					setup,
					() => runtime.state,
					rootSetState(runtime),
					() => "Parent"
				);
				expect((runtime.state as any).Hit).toBe(true);
				expect((runtime.state as any).Child.Hit).toBe(false);
			}
		);
	});
});

describe("registerReceiver", () => {
	it("re-registering a receiver id replaces the handle (HMR semantics)", async () => {
		await withRuntime(
			{
				$Id: "Root",
				FirstHits: 0,
				SecondHits: 0
			},
			async (runtime) => {
				type S = {
					$Id: string;
					FirstHits: number;
					SecondHits: number;
				};
				const First = receiver<S>("SwapReceiver")({
					["Ping" as any]: function* (draft: any) {
						draft.FirstHits++;
					}
				});
				runtime.registerReceiver(First);

				function* setup(draft: any): IActionGenerator {
					bind(draft, First);
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
				await Promise.resolve();
				expect((runtime.state as any).FirstHits).toBe(1);

				const Second = receiver<S>("SwapReceiver")({
					["Ping" as any]: function* (draft: any) {
						draft.SecondHits++;
					}
				});
				runtime.registerReceiver(Second);

				await runtime.processAction(
					send,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await Promise.resolve();
				expect((runtime.state as any).FirstHits).toBe(1);
				expect((runtime.state as any).SecondHits).toBe(1);
			}
		);
	});
});

describe("Action/Error escalation", () => {
	type S = {
		$Id: string;
		SeenError: unknown;
		SeenActionName: string;
		Child: {
			$Id: string;
		};
	};
	const initial = (): S => ({
		$Id: "Parent",
		SeenError: null,
		SeenActionName: "",
		Child: {
			$Id: "Child"
		}
	});

	async function runEscalation(thrown: unknown): Promise<S> {
		let result!: S;
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<S>(initial(), {
					onError: () => {}
				});
				const ErrorBoundary = receiver<S>("ErrorBoundary")({
					["Action/Error" as any]: function* (draft: any, e: any) {
						draft.SeenError = e.Error;
						draft.SeenActionName = e.Label ?? "";
					}
				});
				runtime.registerReceiver(ErrorBoundary);

				function* bindErrorBoundary(draft: S): IActionGenerator {
					bind(draft, ErrorBoundary);
				}
				function* fails(_draft: unknown): IActionGenerator {
					throw thrown;
				}

				await runtime.processAction(
					bindErrorBoundary,
					() => runtime.state,
					rootSetState(runtime),
					() => "Parent"
				);
				const childSetState = sliceSetState(rootSetState(runtime), (s: S) => s.Child);
				await runtime
					.processAction(
						fails,
						() => runtime.state.Child,
						childSetState,
						() => "Child"
					)
					.catch(() => {});
				// The error boundary dispatches as a detached root branch.
				await Promise.resolve();
				await Promise.resolve();
				result = JSON.parse(JSON.stringify(runtime.state)) as S;
			} finally {
				dispose();
			}
		});
		return result;
	}

	it("delivers a thrown Error serialized, under a journaling runtime", async () => {
		const state = await runEscalation(new Error("boom"));
		expect(state.SeenActionName).toBe("fails");
		expect(state.SeenError).toEqual(
			expect.objectContaining({
				Thrown: "error",
				Name: "Error",
				Message: "boom"
			})
		);
	});

	it("delivers a custom Error subclass's name and message", async () => {
		const failure = new Error("The record is locked.");
		failure.name = "ApiError";
		const state = await runEscalation(failure);
		expect(state.SeenActionName).toBe("fails");
		expect(state.SeenError).toEqual(
			expect.objectContaining({
				Thrown: "error",
				Name: "ApiError",
				Message: "The record is locked."
			})
		);
	});

	it("delivers a thrown plain-data value as a value, not an error", async () => {
		const state = await runEscalation({
			Code: "LOCKED"
		});
		expect(state.SeenActionName).toBe("fails");
		expect(state.SeenError).toEqual({
			Thrown: "value",
			Data: {
				Code: "LOCKED"
			}
		});
	});
});

describe("a binding whose receiver was never registered", () => {
	type SubState = {
		$Id: string;
		Sub: {
			$Id: string;
			Seen: number;
		};
	};

	const Unregistered = receiver<{
		$Id: string;
		Seen: number;
	}>("UnregisteredReceiver")({
		["Ping" as any]: function* (draft: any) {
			draft.Seen++;
		}
	});

	function* bindSub(draft: SubState): IActionGenerator {
		bind(draft.Sub, Unregistered);
	}

	function* send(_draft: any): IActionGenerator {
		yield* publishAny("Ping");
	}

	const seedState = (): SubState => ({
		$Id: "Root",
		Sub: {
			$Id: "Sub",
			Seen: 0
		}
	});

	it("does not report it as a receiver, names it as unresolved, and diags once, when the binding lands", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<SubState>(seedState(), {});
				const records: any[] = [];
				const diags: any[] = [];
				runtime.on("record", (record) => records.push(record));
				runtime.on("diag", (event) => diags.push(event));

				await runtime.processAction(
					bindSub,
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
				await Promise.resolve();

				expect(runtime.state.Sub.Seen).toBe(0);

				const dispatches = records.filter((record) => record.Kind === "message:deliver");
				expect(dispatches).toHaveLength(2);
				for (const dispatch of dispatches) {
					expect(dispatch.RecipientIds).toEqual([]);
					expect(dispatch.UnresolvedIds).toEqual([
						"Sub"
					]);
				}

				expect(diags.filter((event) => event.code === "receiver/unresolved")).toEqual([
					expect.objectContaining({
						severity: "warn",
						code: "receiver/unresolved",
						data: {
							receiverId: "UnregisteredReceiver",
							ownerIds: [
								"Sub"
							],
							count: 1,
							kind: "binding"
						}
					})
				]);
			} finally {
				dispose();
			}
		});
	});

	it("omits UnresolvedIds entirely when every receiver resolves", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<SubState>(seedState(), {});
				runtime.registerReceiver(Unregistered);
				const records: any[] = [];
				runtime.on("record", (record) => records.push(record));

				await runtime.processAction(
					bindSub,
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
				await Promise.resolve();

				const [dispatch] = records.filter((record) => record.Kind === "message:deliver");
				expect(dispatch.RecipientIds).toEqual([
					"Sub"
				]);
				expect("UnresolvedIds" in dispatch).toBe(false);
				expect(runtime.state.Sub.Seen).toBe(1);
			} finally {
				dispose();
			}
		});
	});

	it("keeps the binding, so a later registration heals it", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<SubState>(seedState());

				await runtime.processAction(
					bindSub,
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
				await Promise.resolve();
				expect(runtime.state.Sub.Seen).toBe(0);

				runtime.registerReceiver(Unregistered);
				await runtime.processAction(
					send,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
				await Promise.resolve();
				expect(runtime.state.Sub.Seen).toBe(1);
			} finally {
				dispose();
			}
		});
	});

	it("publishToNearest: a broken nearest ancestor shadows a working one, and the record and the diag name it", async () => {
		type ScopedState = {
			$Id: string;
			Seen: number;
			Mid: {
				$Id: string;
				Seen: number;
				Leaf: {
					$Id: string;
				};
			};
		};
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ScopedState>(
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
				const records: any[] = [];
				const diags: any[] = [];
				runtime.on("record", (record) => records.push(record));
				runtime.on("diag", (event) => diags.push(event));

				const Broken = receiver<any>("BrokenReceiver")({
					["Up" as any]: function* (draft: any) {
						draft.Seen++;
					}
				});
				const Working = receiver<any>("WorkingReceiver")({
					["Up" as any]: function* (draft: any) {
						draft.Seen++;
					}
				});
				runtime.registerReceiver(Working);

				function* setup(draft: ScopedState): IActionGenerator {
					bind(draft, Working);
					bind(draft.Mid, Broken);
				}
				function* shout(draft: ScopedState): IActionGenerator {
					yield* publishToNearestAny(draft.Mid.Leaf, "Up");
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
				await Promise.resolve();

				expect(runtime.state.Mid.Seen).toBe(0);
				expect(runtime.state.Seen).toBe(0);

				const [dispatch] = records.filter((record) => record.Kind === "message:deliver");
				expect(dispatch.RecipientIds).toEqual([]);
				expect(dispatch.UnresolvedIds).toEqual([
					"Mid"
				]);
				expect(diags.filter((event) => event.code === "receiver/unresolved" && event.data.kind === "publish")).toEqual([
					expect.objectContaining({
						data: {
							topic: "Up",
							ownerId: "Mid",
							receiverId: "BrokenReceiver",
							shadowedId: "Root",
							kind: "publish"
						}
					})
				]);
			} finally {
				dispose();
			}
		});
	});
});

describe("a publish's deliveries", () => {
	interface IItem {
		$Id: string;
	}

	interface IWorld {
		$Id: string;
		Items: IItem[];
	}

	type IReceiverOf = IReceiver<any, never>;

	function build(items: IItem[]) {
		const runtime = createRuntime<IWorld>(
			{
				$Id: "root",
				Items: items
			},
			{
				onError: () => {}
			}
		);
		const heard: string[] = [];
		const records: IRecord[] = [];
		runtime.on("record", (record) => records.push(record));
		const releases = new Map<string, () => void>();
		runtime.registerImplementation(
			"deliveries/wait",
			(effect: { Type: string; Name: string }) =>
				new Promise<void>((resolve) => {
					releases.set(effect.Name, resolve);
				})
		);
		function* wait(name: string): IActionGenerator {
			yield {
				Type: "deliveries/wait",
				Name: name
			};
		}
		const hears = (id: string, then?: (draft: any) => void): IReceiverOf =>
			receiver<any>(id)({
				["Order" as any]: function* (draft: any) {
					heard.push(`${id}:${draft.$Id}`);
					then?.(draft);
				}
			});
		const bindAll = (
			pairs: [
				string,
				IReceiverOf
			][]
		) =>
			runtime.dispatch(function* binds(draft: IWorld): IActionGenerator {
				for (const [id, R] of pairs) {
					bind(id === "root" ? draft : draft.Items.find((item) => item.$Id === id)!, R);
				}
			}, "root");
		return {
			runtime,
			heard,
			records,
			wait,
			hears,
			bindAll,
			release: (name: string) => releases.get(name)!()
		};
	}

	const abc = () => [
		{
			$Id: "a"
		},
		{
			$Id: "b"
		},
		{
			$Id: "c"
		}
	];

	it("runs the publisher's code after the publish before any receiver starts", async () => {
		const w = build(abc());
		const R = w.hears("R");
		w.runtime.registerReceiver(R);
		await w.bindAll([
			[
				"a",
				R
			]
		]);
		let seen: string[] | undefined;
		await w.runtime.dispatch(function* publisher(): IActionGenerator {
			yield* publishAny("Order");
			seen = [
				...w.heard
			];
		}, "root");
		await settled();
		expect(seen).toEqual([]);
		expect(w.heard).toEqual([
			"R:a"
		]);
	});

	it("delivers to a publisher that is itself a recipient in its place, once it has ended", async () => {
		const w = build(abc());
		const R = w.hears("R");
		w.runtime.registerReceiver(R);
		await w.bindAll([
			[
				"a",
				R
			],
			[
				"b",
				R
			],
			[
				"c",
				R
			]
		]);
		await w.runtime.dispatch(function* publisher(): IActionGenerator {
			yield* publishAny("Order");
		}, "b");
		await settled();
		expect(w.heard).toEqual([
			"R:a",
			"R:b",
			"R:c"
		]);
	});

	it("delivers to a publisher still running when the others start once its hold ends", async () => {
		const w = build(abc());
		const R = w.hears("R");
		w.runtime.registerReceiver(R);
		await w.bindAll([
			[
				"a",
				R
			],
			[
				"b",
				R
			],
			[
				"c",
				R
			]
		]);
		const publishing = w.runtime.dispatch(function* publisher(): IActionGenerator {
			yield* publishAny("Order");
			yield* w.wait("after");
		}, "b");
		await settled();
		expect(w.heard).toEqual([
			"R:a",
			"R:c"
		]);
		w.release("after");
		await publishing;
		await settled();
		expect(w.heard).toEqual([
			"R:a",
			"R:c",
			"R:b"
		]);
	});

	it("keeps a publisher inside open(...) that is itself a recipient from seeing its own receiver, and starts the receivers in tree order", async () => {
		const w = build(abc());
		const R = w.hears("R");
		w.runtime.registerReceiver(R);
		await w.bindAll([
			[
				"a",
				R
			],
			[
				"b",
				R
			],
			[
				"c",
				R
			]
		]);
		let seen: string[] | undefined;
		const publishing = w.runtime.dispatch(function* publisher(): IOpenGenerator {
			yield* open(
				(function* (): IActionGenerator {
					yield* publishAny("Order");
					seen = [
						...w.heard
					];
					yield* w.wait("after");
				})()
			);
		}, "b");
		await settled();
		w.release("after");
		await publishing;
		await settled();
		expect(seen).toEqual([]);
		expect(w.heard).toEqual([
			"R:a",
			"R:b",
			"R:c"
		]);
	});

	it("keeps a second publish's receiver from starting while its publisher is parked on it", async () => {
		const w = build([
			{
				$Id: "dialog"
			}
		]);
		const topics: string[] = [];
		const Shell = receiver<any>("Shell")({
			["Close" as any]: function* () {
				topics.push("Close");
			},
			["Saved" as any]: function* () {
				topics.push("Saved");
			}
		});
		w.runtime.registerReceiver(Shell);
		await w.bindAll([
			[
				"root",
				Shell
			]
		]);
		let afterClose: string[] | undefined;
		let afterSaved: string[] | undefined;
		await w.runtime.dispatch(function* save(): IActionGenerator {
			yield* publishAny("Close");
			afterClose = [
				...topics
			];
			yield* publishAny("Saved");
			afterSaved = [
				...topics
			];
		}, "dialog");
		await settled();
		expect(afterClose).toEqual([]);
		expect(afterSaved).toEqual([
			"Close"
		]);
		expect(topics).toEqual([
			"Close",
			"Saved"
		]);
	});

	it("runs a publishToNearest publisher's code after the yield before the ancestor's receiver writes", async () => {
		const w = build(abc());
		const R = w.hears("R", (draft: any) => {
			draft.Heard = true;
		});
		w.runtime.registerReceiver(R);
		await w.bindAll([
			[
				"root",
				R
			]
		]);
		let seen: unknown;
		await w.runtime.dispatch(function* publisher(draft: IItem): IActionGenerator {
			yield* publishToNearestAny(draft, "Order");
			seen = (w.runtime.state as any).Heard;
		}, "a");
		await settled();
		expect(seen).toBeUndefined();
		expect((w.runtime.state as any).Heard).toBe(true);
	});

	it("delivers to an entity a receiver rebinds during the fan-out through the receiver it was bound to at the publish", async () => {
		const w = build([
			{
				$Id: "b"
			}
		]);
		const Second = w.hears("Second");
		const First = w.hears("First", (draft: IWorld) => {
			if (draft.$Id === "root") {
				bind(draft.Items[0]!, Second);
			}
		});
		w.runtime.registerReceiver(First);
		w.runtime.registerReceiver(Second);
		await w.bindAll([
			[
				"root",
				First
			],
			[
				"b",
				First
			]
		]);
		await w.runtime.dispatch(function* publisher(): IActionGenerator {
			yield* publishAny("Order");
		}, "root");
		await settled();
		expect(w.heard).toEqual([
			"First:root",
			"First:b"
		]);
		w.heard.length = 0;
		await w.runtime.dispatch(function* publisher(): IActionGenerator {
			yield* publishAny("Order");
		}, "root");
		await settled();
		expect(w.heard).toEqual([
			"First:root",
			"Second:b"
		]);
	});

	it("starts every listed receiver, ending cancelled one whose entity an earlier receiver removed", async () => {
		const w = build([
			{
				$Id: "c"
			}
		]);
		const Child = w.hears("Child");
		const Parent = w.hears("Parent", (draft: IWorld) => {
			draft.Items = [];
		});
		w.runtime.registerReceiver(Parent);
		w.runtime.registerReceiver(Child);
		await w.bindAll([
			[
				"root",
				Parent
			],
			[
				"c",
				Child
			]
		]);
		await w.runtime.dispatch(function* publisher(): IActionGenerator {
			yield* publishAny("Order");
		}, "root");
		await settled();
		expect(w.heard).toEqual([
			"Parent:root"
		]);
		expect(w.records.find((record) => record.Kind === "message:deliver")).toMatchObject({
			RecipientIds: [
				"root",
				"c"
			]
		});
		const childStart = w.records.find((record) => record.Kind === "action:start" && record.EntityId === "c") as
			| {
					ActionId: string;
			  }
			| undefined;
		expect(childStart).toBeDefined();
		expect(w.records.find((record) => record.Kind === "action:end" && record.ActionId === childStart!.ActionId)).toMatchObject({
			Status: "cancelled"
		});
	});

	it.each([
		"free",
		"busy"
	])("lets a dialog that tells the shell to close it publish its result, with the shell %s", async (shell) => {
		const w = build([
			{
				$Id: "dialog"
			}
		]);
		const Shell = receiver<any>("Shell")({
			["Close" as any]: function* (draft: IWorld) {
				draft.Items = [];
			}
		});
		w.runtime.registerReceiver(Shell);
		await w.bindAll([
			[
				"root",
				Shell
			]
		]);
		const busy =
			shell === "busy"
				? w.runtime.dispatch(function* unrelated(): IActionGenerator {
						yield* w.wait("unrelated");
					}, "root")
				: undefined;
		await w.runtime.dispatch(function* save(): IActionGenerator {
			yield* publishAny("Close");
			yield* publishAny("Saved");
		}, "dialog");
		if (busy) {
			w.release("unrelated");
			await busy;
		}
		await settled();
		expect(
			w.records.flatMap((record) =>
				record.Kind === "message:deliver"
					? [
							record.Topic
						]
					: []
			)
		).toEqual([
			"Close",
			"Saved"
		]);
		expect(w.runtime.state.Items).toEqual([]);
	});

	it("names the entities bound to unregistered receivers in tree order, whatever order they were bound in", async () => {
		const w = build([
			{
				$Id: "items0"
			},
			{
				$Id: "items1"
			}
		]);
		await w.bindAll([
			[
				"items1",
				w.hears("UnregisteredLater")
			]
		]);
		await w.bindAll([
			[
				"items0",
				w.hears("UnregisteredEarlier")
			]
		]);
		await w.runtime.dispatch(function* publisher(): IActionGenerator {
			yield* publishAny("Order");
		}, "root");
		expect(w.records.find((record) => record.Kind === "message:deliver")).toMatchObject({
			UnresolvedIds: [
				"items0",
				"items1"
			]
		});
	});
});
