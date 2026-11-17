import type { IResourceDeliveryOf } from "../../src/Registries/IResourceRegistry";
import type { IResourceManager } from "../../src/Runtime/createResourceManager";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IAskId } from "../../src/Types/IAskId";
import type { IReceiver } from "../../src/Types/IReceiver";
import type { IRecord } from "../../src/Types/IRecord";
import type { IResourceContext, IResourceStatus } from "../../src/Types/IResource";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { closeResource } from "../../src/Effects/closeResource";
import { defineEffect } from "../../src/Effects/defineEffect";
import { openResource } from "../../src/Effects/openResource";
import { parallel } from "../../src/Effects/parallel";
import { resource } from "../../src/Effects/resource";
import { start } from "../../src/Effects/start";
import { startTimer } from "../../src/Effects/startTimer";
import { leading } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { seat } from "../../src/Runtime/draftNode";
import { EntityGoneError } from "../../src/Runtime/entityGoneError";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open as openRegion } from "../../src/Runtime/open";
import { pendingAsks } from "../../src/Runtime/pendingAsks";
import { receiver } from "../../src/Runtime/receiver";
import { isEnded } from "../../src/Types/IResource";
import { rawWrite, treeWrite } from "../testHelpers";

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"test/feed": {
			Message: {
				N: number;
			};
			Value: string;
			Methods: {
				echo(text: string): string;
				fail(): void;
				slow(): string;
			};
			Supply: readonly string[];
			SupplyResponse: {
				Count: number;
			};
		};
		"test/quiet": {
			Params: {
				Label: string;
			};
			Methods: {
				ping(): string;
			};
		};
		"test/stream": {
			Params: {
				Endpoint: string;
			};
			Message: unknown;
			ResumeFrom: "required";
		};
		"test/acked": {
			Message: {
				N: number;
			};
			Methods: {
				send(text: string): string;
				ack(n: number): void;
			};
		};
	}
	interface IResourceRegistry {
		"Test/Feed": {
			Type: "test/feed";
		};
		"Test/Silent": {
			Type: "test/feed";
			Message: never;
		};
		"Test/Quiet": {
			Type: "test/quiet";
		};
		"Test/Acked": {
			Type: "test/acked";
		};
		"Test/Stream": {
			Type: "test/stream";
			Message: {
				Events: number[];
				Last: number;
			};
			Params: {
				UserId: string;
			};
		};
	}
}

type IChild = {
	$Id: string;
	Log: unknown[];
	Cursor: number | null;
};
type IRoot = {
	$Id: string;
	Log: unknown[];
	Cursor: number | null;
	Children: IChild[];
};

const initialState = (): IRoot => ({
	$Id: "root",
	Log: [],
	Cursor: null,
	Children: [
		{
			$Id: "child-1",
			Log: [],
			Cursor: null
		}
	]
});

class AppError extends Error {}

function build(options?: { pauseResources?: boolean; onError?: (error: unknown) => void }) {
	const runtime = createRuntime<IRoot>(initialState(), {
		...options
	});
	const internal = runtime as IRuntimeInternal<IRoot>;
	const manager: IResourceManager = internal.get("runtime/resources");
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (d) => diags.push(d));
	const records: IRecord[] = [];
	runtime.on("record", (r) => records.push(r));
	const codes = () => diags.map((d) => d.code);
	const dispatch = <A extends any[], R>(action: (draft: IRoot, ...args: A) => Generator<any, R, any>, ...args: A): Promise<R | undefined> =>
		runtime.dispatch(action as any, "root", ...args) as Promise<R | undefined>;
	const status = (key: string, ownerId = "root"): IResourceStatus => manager.status(key, ownerId);
	return {
		runtime,
		internal,
		manager,
		diags,
		records,
		codes,
		dispatch,
		status
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function* testGate(): IActionGenerator {
	yield {
		Type: "test/gate"
	};
}

const FeedReceiver = receiver<IRoot>("FeedReceiver")({
	*"Test/Feed"(draft, e) {
		if (isEnded(e)) {
			draft.Log.push({
				ended: e.$Ended.Reason,
				error: e.$Ended.Error?.Thrown ?? null
			});
			return;
		}
		draft.Log.push(e.N);
	}
});

function* openFeed(draft: IRoot): IActionGenerator {
	yield* openResource(draft, "Test/Feed", FeedReceiver, {
		Type: "test/feed"
	});
}

function* closeFeed(draft: IRoot): IActionGenerator {
	yield* closeResource(draft, "Test/Feed");
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resources: opening", () => {
	it("records the row and sets the instance up in the drain, before the opening action's next step", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let setups = 0;
		world.runtime.registerResourceType("test/feed", () => {
			setups++;
		});
		let seenAfterYield = -1;
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", FeedReceiver, {
				Type: "test/feed"
			});
			seenAfterYield = setups;
		}
		await world.dispatch(open);
		expect(seenAfterYield).toBe(1);
		expect(world.runtime.resources(world.runtime.state)).toEqual([
			{
				Key: "Test/Feed",
				OwnerId: "root",
				Params: {
					Type: "test/feed"
				},
				ReceiverId: "FeedReceiver",
				ResumeFrom: null
			}
		]);
		expect(world.status("Test/Feed")).toEqual({
			State: "live"
		});
		expect(world.records.some((r) => r.Kind === "table" && r.Table === "resources" && r.Value !== null)).toBe(true);
		world.runtime.dispose();
	});

	it("is a no-op on an equal reopen and replaces on any difference, aborting the old instance before the new setup", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const order: string[] = [];
		const signals: AbortSignal[] = [];
		world.runtime.registerResourceType("test/quiet", (params, r) => {
			order.push(`setup:${params.Label}`);
			signals.push(r.signal);
			r.signal.addEventListener("abort", () => order.push(`abort:${params.Label}:${r.signal.reason.message}`));
		});
		function* open(draft: IRoot, label: string): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: label
			});
		}
		await world.dispatch(open, "a");
		await world.dispatch(open, "a");
		function* twice(draft: IRoot): IActionGenerator {
			yield* open(draft, "a");
			yield* open(draft, "a");
		}
		await world.dispatch(twice);
		expect(order).toEqual([
			"setup:a"
		]);
		await world.dispatch(open, "b");
		await settle();
		expect(order).toEqual([
			"setup:a",
			"abort:a:replaced",
			"setup:b"
		]);
		world.runtime.dispose();
	});

	it("refuses an owner that is not in the tree before writing any row", async () => {
		const world = build();
		function* openForGhost(_draft: IRoot): IActionGenerator {
			yield* openResource(
				{
					$Id: "ghost"
				},
				"Test/Quiet",
				{
					Type: "test/quiet",
					Label: "x"
				}
			);
		}
		const opening = world.dispatch(openForGhost);
		await expect(opening).rejects.toBeInstanceOf(EntityGoneError);
		await expect(opening).rejects.toThrow(/not in the state tree/);
		expect(world.runtime.resources()).toEqual([]);
		world.runtime.dispose();
	});

	it("records a row of an unregistered type as pending, and opens it when the type registers", async () => {
		const world = build();
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "late"
			});
		}
		await world.dispatch(open);
		await settle();
		expect(world.status("Test/Quiet")).toEqual({
			State: "pending",
			Waiting: "type"
		});
		expect(world.codes()).toContain("resource/unregistered-type");
		let setUp = false;
		world.runtime.registerResourceType("test/quiet", () => {
			setUp = true;
		});
		await settle();
		expect(setUp).toBe(true);
		expect(world.status("Test/Quiet").State).toBe("live");
		world.runtime.dispose();
	});

	it("waits on an unregistered receiver and connects when it registers", async () => {
		const world = build();
		const r: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (_params, ctx) => {
			r.push(ctx);
		});
		await world.dispatch(openFeed);
		await settle();
		expect(world.status("Test/Feed")).toEqual({
			State: "pending",
			Waiting: "receiver"
		});
		expect(world.codes()).toContain("receiver/unresolved");
		expect(r).toHaveLength(0);
		world.runtime.registerReceiver(FeedReceiver);
		await settle();
		expect(r).toHaveLength(1);
		await r[0].emit({
			N: 1
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			1
		]);
		world.runtime.dispose();
	});

	it("retires every instance of a re-registered type with replaced and sets them up again", async () => {
		const world = build();
		const reasons: unknown[] = [];
		world.runtime.registerResourceType("test/quiet", (_params, r) => {
			r.signal.addEventListener("abort", () => reasons.push(r.signal.reason.message));
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "x"
			});
		}
		await world.dispatch(open);
		let second = 0;
		world.runtime.registerResourceType("test/quiet", () => {
			second++;
		});
		await settle();
		expect(reasons).toEqual([
			"replaced"
		]);
		expect(second).toBe(1);
		world.runtime.dispose();
	});

	it("reads the owner's ResumeFrom field at setup", async () => {
		const world = build();
		const seen: unknown[] = [];
		world.runtime.registerResourceType("test/stream", (params, r) => {
			seen.push([
				params.Endpoint,
				r.resumeFrom
			]);
		});
		const StreamReceiver = receiver<IRoot>("StreamReceiver")({
			*"Test/Stream"(draft, e) {
				if (!isEnded(e)) {
					draft.Log.push(...e.Events);
					draft.Cursor = e.Last;
				}
			}
		});
		world.runtime.registerReceiver(StreamReceiver);
		function* open(draft: IRoot): IActionGenerator {
			draft.Cursor = 41;
			yield* openResource(
				draft,
				"Test/Stream",
				StreamReceiver,
				{
					Type: "test/stream",
					Endpoint: "/events",
					UserId: "u1"
				},
				{
					ResumeFrom: "Cursor"
				}
			);
		}
		await world.dispatch(open);
		expect(seen).toEqual([
			[
				"/events",
				41
			]
		]);
		world.runtime.dispose();
	});
});

describe("resources: emit and delivery", () => {
	it("resolves an emit on acceptance, queues its delivery behind an action holding the owner, and delivers it when the hold ends", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		await world.dispatch(openFeed);
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		function* holds(draft: IRoot): IActionGenerator {
			draft.Log.push("hold");
			yield* testGate();
			draft.Log.push("let go");
		}
		const holding = world.dispatch(holds);
		await expect(
			ctx.emit({
				N: 1
			})
		).resolves.toBeUndefined();
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"hold"
		]);
		release();
		await holding;
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"hold",
			"let go",
			1
		]);
		world.runtime.dispose();
	});

	it("drops a delivery queued behind a hold when the key closes before it starts, and runs none of it", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		await world.dispatch(openFeed);
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		function* holdsThenCloses(draft: IRoot): IActionGenerator {
			yield* testGate();
			yield* closeResource(draft, "Test/Feed");
		}
		const holding = world.dispatch(holdsThenCloses);
		void ctx.emit({
			N: 1
		});
		await settle();
		release();
		await holding;
		await settle();
		expect(world.runtime.state.Log).toEqual([]);
		const delivery = world.records.find((r) => r.Kind === "action:start" && r.Origin?.Kind === "resource:deliver");
		const deliveryId = delivery?.Kind === "action:start" ? delivery.ActionId : null;
		expect(world.records.find((r) => r.Kind === "action:end" && r.ActionId === deliveryId)).toMatchObject({
			Status: "dropped"
		});
		world.runtime.dispose();
	});

	it("delivers { Type: key, ...message } to the owner's receiver, from the drain, with a resource:deliver origin", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let ctx!: IResourceContext<"test/feed">;
		let deliveredInsideSetup = false;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			void r.emit({
				N: 0
			});
			deliveredInsideSetup = world.runtime.state.Log.length > 0;
		});
		await world.dispatch(openFeed);
		await settle();
		expect(deliveredInsideSetup).toBe(false);
		await ctx.emit({
			N: 1
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			0,
			1
		]);
		const start = world.records.find((r) => r.Kind === "action:start" && r.Origin?.Kind === "resource:deliver");
		expect(start).toMatchObject({
			Name: "FeedReceiver",
			EntityId: "root",
			Origin: {
				Kind: "resource:deliver",
				Key: "Test/Feed",
				OwnerId: "root"
			}
		});
		expect(
			world.records.some(
				(r) => r.Kind === "message:deliver" && r.Topic === "Test/Feed" && r.PublisherId === "root" && r.RecipientIds[0] === "root"
			)
		).toBe(true);
		world.runtime.dispose();
	});

	it("starts delivery N+1 only after N settles", async () => {
		const world = build();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		world.runtime.registerImplementation("test/gate", () => gate);
		const Slow = receiver<IRoot>("SlowReceiver")({
			*"Test/Feed"(_draft, e) {
				if (isEnded(e)) return;
				order.push(`start:${e.N}`);
				if (e.N === 1) {
					yield {
						Type: "test/gate"
					};
				}
				order.push(`end:${e.N}`);
			}
		});
		world.runtime.registerReceiver(Slow);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Slow, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		void ctx.emit({
			N: 1
		});
		void ctx.emit({
			N: 2
		});
		await settle();
		expect(order).toEqual([
			"start:1"
		]);
		releaseFirst();
		await settle();
		expect(order).toEqual([
			"start:1",
			"end:1",
			"start:2",
			"end:2"
		]);
		world.runtime.dispose();
	});

	it("refuses an invalid message without delivering it, in every build", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		await world.dispatch(openFeed);
		const emitAny = (m: unknown) => ctx.emit(m as never);
		await emitAny([
			1
		]);
		await emitAny({
			Type: "x",
			N: 1
		});
		await emitAny({
			$Ended: {},
			N: 1
		});
		await emitAny({
			N: new Map()
		});
		await emitAny("text");
		await settle();
		expect(world.runtime.state.Log).toEqual([]);
		expect(world.codes().filter((c) => c === "resource/invalid-message")).toHaveLength(5);
		world.runtime.dispose();
	});

	it("fails the one message a receiver throws on, through the ordinary action-error path, and delivers the next, by default", async () => {
		const errors: unknown[] = [];
		const world = build({
			onError: (e) => errors.push(e)
		});
		const Throwing = receiver<IRoot>("ThrowingReceiver")({
			*"Test/Feed"(draft, e) {
				if (isEnded(e)) return;
				if (e.N === 1) {
					throw new AppError("bad batch");
				}
				draft.Log.push(e.N);
			}
		});
		world.runtime.registerReceiver(Throwing);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Throwing, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		void ctx.emit({
			N: 1
		});
		void ctx.emit({
			N: 2
		});
		await settle();
		expect(errors[0]).toBeInstanceOf(AppError);
		expect(world.runtime.state.Log).toEqual([
			2
		]);
		expect(world.records.some((r) => r.Kind === "receiver:error" && r.Topic === "Test/Feed")).toBe(true);
		expect(world.status("Test/Feed")).toEqual({
			State: "live"
		});
		world.runtime.dispose();
	});

	it("ends the instance with receiver-failed when its type opts in, dropping the messages queued behind the failed one", async () => {
		const errors: unknown[] = [];
		const world = build({
			onError: (e) => errors.push(e)
		});
		const Throwing = receiver<IRoot>("EndingThrowingReceiver")({
			*"Test/Feed"(draft, e) {
				if (isEnded(e)) {
					draft.Log.push(`ended:${e.$Ended.Reason}`);
					return;
				}
				if (e.N === 1) {
					throw new AppError("bad batch");
				}
				draft.Log.push(e.N);
			}
		});
		world.runtime.registerReceiver(Throwing);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType(
			"test/feed",
			(_params, r) => {
				ctx = r;
			},
			{
				endOnReceiverFailure: true
			}
		);
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Throwing, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		void ctx.emit({
			N: 1
		});
		void ctx.emit({
			N: 2
		});
		await settle();
		expect(errors[0]).toBeInstanceOf(AppError);
		expect(world.runtime.state.Log).toEqual([
			"ended:receiver-failed"
		]);
		expect(ctx.signal.aborted).toBe(true);
		expect(world.status("Test/Feed")).toEqual({
			State: "ended",
			Reason: "receiver-failed"
		});
		expect(world.runtime.resources()).toEqual([]);
		world.runtime.dispose();
	});

	it("accepts an emit for a key that opened without a receiver, and delivers nothing", async () => {
		const world = build();
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Silent", {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		await ctx.emit({
			N: 1
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([]);
		expect(world.codes()).toEqual([]);
		world.runtime.dispose();
	});

	it("waits for the cell's in-flight delivery before setting up a replacement", async () => {
		const world = build();
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		world.runtime.registerImplementation("test/gate", () => gate);
		const Slow = receiver<IRoot>("SlowCursor")({
			*"Test/Feed"(draft, e: IResourceDeliveryOf<"Test/Feed">) {
				if (isEnded(e)) return;
				yield* openRegion(testGate());
				draft.Cursor = e.N;
				order.push(`applied:${e.N}`);
			}
		});
		world.runtime.registerReceiver(Slow);
		let first = true;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			order.push("setup");
			if (first) {
				first = false;
				void r.emit({
					N: 7
				});
			}
		});
		function* open(draft: IRoot, extra: string): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Slow, {
				Type: "test/feed",
				Extra: extra
			} as never);
		}
		await world.dispatch(open, "a");
		await settle();
		await world.dispatch(open, "b");
		await settle();
		expect(order).toEqual([
			"setup"
		]);
		release();
		await settle();
		expect(order).toEqual([
			"setup",
			"applied:7",
			"setup"
		]);
		world.runtime.dispose();
	});

	it("names a delivered receiver that parks on an ask, or on a method of its own cell, which answers", async () => {
		const world = build();
		function* answers(draft: IChild): IActionGenerator {
			yield* answer((yield* pendingAsks(draft))[0]!.Id as IAskId<string>, "answered");
		}
		const Parker = receiver<IRoot>("ParkingReceiver")({
			*"Test/Feed"(draft, e) {
				if (isEnded(e)) return;
				if (e.N === 1) {
					const answered = yield* openRegion(
						ask<string>(draft.Children[0]!, {
							Path: "Parked"
						})
					);
					draft.Log.push(answered ?? "none");
				} else {
					draft.Log.push((yield* resource(draft, "Test/Feed").echo("echoed")) ?? "none");
				}
			}
		});
		world.runtime.registerReceiver(Parker);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			r.methods({
				echo: (_c, text) => text,
				fail: () => {},
				slow: () => ""
			});
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Parker, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		void ctx.emit({
			N: 1
		});
		void ctx.emit({
			N: 2
		});
		await settle();
		await world.runtime.dispatch(answers, "child-1");
		await settle();
		expect(
			world.diags
				.filter((d) => d.code === "resource/receiver-waiting")
				.map(
					(d) =>
						(
							d.data as
								| {
										effectType?: string;
								  }
								| undefined
						)?.effectType
				)
		).toEqual([
			"ask",
			"resource"
		]);
		expect(world.runtime.state.Log).toEqual([
			"answered",
			"echoed"
		]);
		world.runtime.dispose();
	});

	it("allows the receiver to reach its own cell's methods through start", async () => {
		const world = build();
		function* callEcho(draft: IRoot): IActionGenerator {
			const echoed = yield* resource(draft, "Test/Feed").echo("pong");
			draft.Log.push(echoed ?? "none");
		}
		const Starting = receiver<IRoot>("StartingReceiver")({
			*"Test/Feed"(draft, e) {
				if (isEnded(e)) return;
				yield* start(callEcho, draft.$Id);
			}
		});
		world.runtime.registerReceiver(Starting);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			r.methods({
				echo: (_c, text) => text,
				fail: () => {},
				slow: () => ""
			});
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Starting, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		await ctx.emit({
			N: 1
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"pong"
		]);
		world.runtime.dispose();
	});

	it("completes a method whose handler awaits its own emit, called by an action holding the owner", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			r.methods({
				echo: async (_c, text) => {
					await r.emit({
						N: 1
					});
					return `${text}!`;
				},
				fail: () => {},
				slow: () => "slow"
			});
		});
		await world.dispatch(openFeed);
		await world.dispatch(function* callsEcho(draft: IRoot): IActionGenerator {
			draft.Log.push((yield* resource(draft, "Test/Feed").echo("hi")) ?? "none");
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"hi!",
			1
		]);
		expect(world.codes()).toEqual([]);
		world.runtime.dispose();
	});

	it("completes a method whose handler awaits its own emit, called from an action the receiver started", async () => {
		const world = build();
		function* callsEcho(draft: IRoot): IActionGenerator {
			draft.Log.push((yield* resource(draft, "Test/Feed").echo("hi")) ?? "none");
		}
		const Starting = receiver<IRoot>("StartingEchoReceiver")({
			*"Test/Feed"(draft, e) {
				if (isEnded(e)) return;
				draft.Log.push(e.N);
				if (e.N === 1) {
					yield* start(callsEcho, draft.$Id);
				}
			}
		});
		world.runtime.registerReceiver(Starting);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			r.methods({
				echo: async (_c, text) => {
					await r.emit({
						N: 2
					});
					return `${text}!`;
				},
				fail: () => {},
				slow: () => "slow"
			});
		});
		await world.dispatch(function* openStarting(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Starting, {
				Type: "test/feed"
			});
		});
		await ctx.emit({
			N: 1
		});
		await settle();
		await settle();
		expect(world.runtime.state.Log).toEqual([
			1,
			"hi!",
			2
		]);
		world.runtime.dispose();
	});

	it("needs open(...) around a wait on an ack the receiver sends after applying, which it starts", async () => {
		const world = build();
		const sent: string[] = [];
		world.runtime.registerResourceType("test/acked", (_params, r) => {
			const unacked = new Map<number, () => void>();
			let next = 0;
			r.methods({
				send: (_c, text) => {
					const n = ++next;
					sent.push(text);
					void r.emit({
						N: n
					});
					return new Promise<string>((resolve) => unacked.set(n, () => resolve(`${text}:acked`)));
				},
				ack: (_c, n) => {
					unacked.get(n)?.();
					unacked.delete(n);
				}
			});
		});
		function* acks(draft: IRoot, n: number): IActionGenerator {
			yield* resource(draft, "Test/Acked").ack(n);
		}
		const Applying = receiver<IRoot>("ApplyingReceiver")({
			*"Test/Acked"(draft, e) {
				if (isEnded(e)) return;
				draft.Log.push(e.N);
				yield* start(acks, draft.$Id, e.N);
			}
		});
		world.runtime.registerReceiver(Applying);
		await world.dispatch(function* openAcked(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Acked", Applying, {
				Type: "test/acked"
			});
		});
		await world.dispatch(function* sendsOpen(draft: IRoot) {
			draft.Log.push((yield* openRegion(resource(draft, "Test/Acked").send("a"))) ?? "none");
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			1,
			"a:acked"
		]);
		const held = world.dispatch(function* sendsHeld(draft: IRoot): IActionGenerator {
			draft.Log.push((yield* resource(draft, "Test/Acked").send("b")) ?? "none");
		});
		await settle();
		await settle();
		expect(sent).toEqual([
			"a",
			"b"
		]);
		expect(world.runtime.state.Log).toEqual([
			1,
			"a:acked"
		]);
		expect(world.codes()).not.toContain("resource/receiver-waiting");
		world.runtime.dispose();
		await held;
	});

	it("doesn't replay messages on a reconnect during a long hold, because the type's own cursor advances on acceptance", async () => {
		const world = build();
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const server = [
			1,
			2,
			3,
			4
		];
		const connects: number[] = [];
		let connect!: (upTo: number) => void;
		world.runtime.registerResourceType("test/stream", (_params, r) => {
			let cursor = (r.resumeFrom as number | undefined) ?? 0;
			connect = (upTo) => {
				connects.push(cursor);
				for (const n of server) {
					if (n > cursor && n <= upTo) {
						void r.emit({
							Events: [
								n
							],
							Last: n
						});
						cursor = n;
					}
				}
			};
		});
		const StreamReceiver = receiver<IRoot>("CursorStreamReceiver")({
			*"Test/Stream"(draft, e) {
				if (!isEnded(e)) {
					draft.Log.push(...e.Events);
					draft.Cursor = e.Last;
				}
			}
		});
		world.runtime.registerReceiver(StreamReceiver);
		await world.dispatch(function* openStream(draft: IRoot): IActionGenerator {
			draft.Cursor = 0;
			yield* openResource(
				draft,
				"Test/Stream",
				StreamReceiver,
				{
					Type: "test/stream",
					Endpoint: "/events",
					UserId: "u1"
				},
				{
					ResumeFrom: "Cursor"
				}
			);
		});
		const holding = world.dispatch(function* longSave(): IActionGenerator {
			yield* testGate();
		});
		await settle();
		connect(3);
		connect(4);
		await settle();
		expect(world.runtime.state.Log).toEqual([]);
		expect(world.runtime.state.Cursor).toBe(0);
		release();
		await holding;
		await settle();
		expect(connects).toEqual([
			0,
			3
		]);
		expect(world.runtime.state.Log).toEqual([
			1,
			2,
			3,
			4
		]);
		expect(world.runtime.state.Cursor).toBe(4);
		world.runtime.dispose();
	});

	it("batches what a type receives while its owner is held, through onIdle", async () => {
		const world = build();
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		let push!: (n: number) => void;
		world.runtime.registerResourceType("test/stream", (_params, r) => {
			let buffer: number[] = [];
			let flushing = false;
			const flush = () => {
				flushing = false;
				const events = buffer;
				buffer = [];
				void r.emit({
					Events: events,
					Last: events.at(-1)!
				});
			};
			push = (n) => {
				buffer.push(n);
				if (!flushing) {
					flushing = true;
					r.onIdle(flush);
				}
			};
		});
		const batches: number[][] = [];
		const BatchReceiver = receiver<IRoot>("BatchReceiver")({
			*"Test/Stream"(draft, e) {
				if (!isEnded(e)) {
					batches.push(e.Events);
					draft.Cursor = e.Last;
				}
			}
		});
		world.runtime.registerReceiver(BatchReceiver);
		await world.dispatch(function* openStream(draft: IRoot): IActionGenerator {
			yield* openResource(
				draft,
				"Test/Stream",
				BatchReceiver,
				{
					Type: "test/stream",
					Endpoint: "/events",
					UserId: "u1"
				},
				{
					ResumeFrom: "Cursor"
				}
			);
		});
		const holding = world.dispatch(function* longSave(): IActionGenerator {
			yield* testGate();
		});
		await settle();
		for (let n = 1; n <= 50; n++) {
			push(n);
			await settle();
		}
		expect(batches).toEqual([]);
		release();
		await holding;
		await settle();
		await settle();
		expect(batches).toEqual([
			[
				1
			],
			Array.from(
				{
					length: 49
				},
				(_, i) => i + 2
			)
		]);
		expect(world.runtime.state.Cursor).toBe(50);
		world.runtime.dispose();
	});

	it("reports a deep queue once", async () => {
		const world = build();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		world.runtime.registerImplementation("test/gate", () => gate);
		const Slow = receiver<IRoot>("SlowestReceiver")({
			*"Test/Feed"(_draft, e) {
				if (isEnded(e)) return;
				if (e.N === 0) {
					yield {
						Type: "test/gate"
					};
				}
			}
		});
		world.runtime.registerReceiver(Slow);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Slow, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		for (let i = 0; i <= 101; i++) {
			void ctx.emit({
				N: i
			});
		}
		await settle();
		release();
		await settle();
		expect(world.codes().filter((c) => c === "resource/queue-depth")).toHaveLength(1);
		world.runtime.dispose();
	});
});

describe("resources: ending", () => {
	it("flushes queued emits, then delivers $Ended, then retracts the row, keeping the ended status", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		await world.dispatch(openFeed);
		void ctx.emit({
			N: 1
		});
		void ctx.emit({
			N: 2
		});
		ctx.end("done");
		void ctx.emit({
			N: 3
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			1,
			2,
			{
				ended: "done",
				error: null
			}
		]);
		expect(world.runtime.resources()).toEqual([]);
		expect(world.status("Test/Feed")).toEqual({
			State: "ended",
			Reason: "done"
		});
		const retraction = world.records.filter((r) => r.Kind === "table" && r.Table === "resources").at(-1);
		expect(retraction).toMatchObject({
			Value: null
		});
		world.runtime.dispose();
	});

	it("ends with failed and the error when setup throws, and raises resource/ended", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		world.runtime.registerResourceType("test/feed", () => {
			throw new Error("no socket");
		});
		await world.dispatch(openFeed);
		await settle();
		expect(world.runtime.state.Log).toEqual([
			{
				ended: "failed",
				error: "error"
			}
		]);
		expect(world.codes()).toContain("resource/ended");
		expect(world.status("Test/Feed")).toMatchObject({
			State: "ended",
			Reason: "failed",
			Error: {
				Message: "no socket"
			}
		});
		world.runtime.dispose();
	});

	it("ends with failed on a rejection, and ignores one that settles after retirement", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const rejecters: ((error: unknown) => void)[] = [];
		world.runtime.registerResourceType("test/feed", () => {
			return new Promise((_resolve, reject) => {
				rejecters.push(reject);
			});
		});
		await world.dispatch(openFeed);
		rejecters[0](new Error("lost"));
		await settle();
		expect(world.runtime.state.Log).toEqual([
			{
				ended: "failed",
				error: "error"
			}
		]);
		treeWrite(world.runtime, (s) => {
			s.Log = [];
		});
		await world.dispatch(openFeed);
		await world.dispatch(closeFeed);
		rejecters[1](new Error("AbortError"));
		await settle();
		expect(world.runtime.state.Log).toEqual([]);
		expect(world.codes().filter((c) => c === "resource/ended")).toHaveLength(1);
		world.runtime.dispose();
	});

	it("lets the $Ended case reconnect with an equal reopen, and the reopened row stands", async () => {
		const world = build();
		const Reconnecting: IReceiver<IRoot, "Test/Feed"> = receiver<IRoot>("ReconnectingReceiver")({
			*"Test/Feed"(draft: IRoot, e: IResourceDeliveryOf<"Test/Feed">): IActionGenerator {
				if (isEnded(e)) {
					draft.Log.push(`ended:${e.$Ended.Reason}`);
					yield* openResource(draft, "Test/Feed", Reconnecting, {
						Type: "test/feed"
					});
				}
			}
		});
		world.runtime.registerReceiver(Reconnecting);
		const contexts: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			contexts.push(r);
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Reconnecting, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		contexts[0].end("lost");
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"ended:lost"
		]);
		expect(contexts).toHaveLength(2);
		expect(world.runtime.resources()).toHaveLength(1);
		expect(world.status("Test/Feed").State).toBe("live");
		world.runtime.dispose();
	});

	it("lets an action holding the owner reopen and call a method after the stream ended under it, with no $Ended", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const contexts: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			contexts.push(r);
			r.methods({
				echo: (_c, text) => `${text}!`,
				fail: () => {},
				slow: () => "slow"
			});
		});
		await world.dispatch(openFeed);
		function* holdsThenReopens(draft: IRoot): IActionGenerator {
			yield* testGate();
			yield* openResource(draft, "Test/Feed", FeedReceiver, {
				Type: "test/feed"
			});
			draft.Log.push((yield* resource(draft, "Test/Feed").echo("hi")) ?? "none");
		}
		const holding = world.dispatch(holdsThenReopens);
		await settle();
		contexts[0].end("lost");
		await settle();
		release();
		await settle();
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"hi!"
		]);
		await holding;
		expect(contexts).toHaveLength(2);
		expect(world.status("Test/Feed").State).toBe("live");
		world.runtime.dispose();
	});

	it("resumes a stream reopened during a hold from the cursor before the delivery that ending dropped", async () => {
		const world = build();
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const contexts: IResourceContext<"test/stream">[] = [];
		world.runtime.registerResourceType("test/stream", (_params, r) => {
			contexts.push(r);
		});
		const StreamReceiver = receiver<IRoot>("ResumingStreamReceiver")({
			*"Test/Stream"(draft, e) {
				if (!isEnded(e)) {
					draft.Log.push(...e.Events);
					draft.Cursor = e.Last;
				}
			}
		});
		world.runtime.registerReceiver(StreamReceiver);
		function* openStream(draft: IRoot): IActionGenerator {
			yield* openResource(
				draft,
				"Test/Stream",
				StreamReceiver,
				{
					Type: "test/stream",
					Endpoint: "/events",
					UserId: "u1"
				},
				{
					ResumeFrom: "Cursor"
				}
			);
		}
		await world.dispatch(function* seed(draft: IRoot): IActionGenerator {
			draft.Cursor = 41;
			yield* openStream(draft);
		});
		const holding = world.dispatch(function* holdsThenReopens(draft: IRoot): IActionGenerator {
			yield* testGate();
			yield* openStream(draft);
		});
		await settle();
		void contexts[0].emit({
			Events: [
				42
			],
			Last: 42
		});
		contexts[0].end("lost");
		await settle();
		release();
		await holding;
		await settle();
		expect(contexts).toHaveLength(2);
		expect(contexts[1].resumeFrom).toBe(41);
		expect(world.runtime.state.Log).toEqual([]);
		world.runtime.dispose();
	});

	it.fails("lets an action that got in during a delivery's open wait replace the resource and call a method", async () => {
		const world = build();
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const contexts: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			contexts.push(r);
			r.methods({
				echo: (_c, text) => `${text}!`,
				fail: () => {},
				slow: () => "slow"
			});
		});
		const Waiting = receiver<IRoot>("OpenWaitReceiver")({
			*"Test/Feed"(draft, e: IResourceDeliveryOf<"Test/Feed">) {
				if (isEnded(e)) {
					return;
				}
				yield* openRegion(testGate());
				draft.Log.push(e.N);
			}
		});
		world.runtime.registerReceiver(Waiting);
		await world.dispatch(function* openWaiting(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Waiting, {
				Type: "test/feed"
			});
		});
		const delivering = contexts[0].emit({
			N: 1
		});
		await settle();
		const replacing = world.dispatch(function* replaceAndCall(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Waiting, {
				Type: "test/feed",
				Version: 2
			} as never);
			draft.Log.push((yield* resource(draft, "Test/Feed").echo("hi")) ?? "none");
		});
		await settle();
		release();
		await settle();
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"hi!",
			1
		]);
		await Promise.all([
			delivering,
			replacing
		]);
		world.runtime.dispose();
	});

	it("lets an action that got in during a delivery's open wait replace the resource and call a method inside open", async () => {
		const world = build();
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const contexts: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			contexts.push(r);
			r.methods({
				echo: (_c, text) => `${text}!`,
				fail: () => {},
				slow: () => "slow"
			});
		});
		const Waiting = receiver<IRoot>("OpenWaitReceiverOpenCall")({
			*"Test/Feed"(draft, e: IResourceDeliveryOf<"Test/Feed">) {
				if (isEnded(e)) {
					return;
				}
				yield* openRegion(testGate());
				draft.Log.push(e.N);
			}
		});
		world.runtime.registerReceiver(Waiting);
		await world.dispatch(function* openWaiting(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Waiting, {
				Type: "test/feed"
			});
		});
		const delivering = contexts[0].emit({
			N: 1
		});
		await settle();
		const replacing = world.dispatch(function* replaceAndCall(draft: IRoot) {
			yield* openResource(draft, "Test/Feed", Waiting, {
				Type: "test/feed",
				Version: 2
			} as never);
			draft.Log.push((yield* openRegion(resource(draft, "Test/Feed").echo("hi"))) ?? "none");
		});
		await settle();
		release();
		await Promise.all([
			delivering,
			replacing
		]);
		expect(world.runtime.state.Log).toEqual([
			1,
			"hi!"
		]);
		expect(contexts).toHaveLength(2);
		world.runtime.dispose();
	});

	it("drops the ending's queue and sends no $Ended when the app closes the key during the flush", async () => {
		const world = build();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		world.runtime.registerImplementation("test/gate", () => gate);
		const Gated = receiver<IRoot>("GatedReceiver")({
			*"Test/Feed"(draft, e: IResourceDeliveryOf<"Test/Feed">) {
				if (isEnded(e)) {
					draft.Log.push("ended");
					return;
				}
				yield* openRegion(testGate());
				draft.Log.push(e.N);
			}
		});
		world.runtime.registerReceiver(Gated);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Gated, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		void ctx.emit({
			N: 1
		});
		void ctx.emit({
			N: 2
		});
		ctx.end("done");
		await settle();
		await world.dispatch(closeFeed);
		release();
		await settle();
		expect(world.runtime.state.Log).toEqual([
			1
		]);
		expect(world.status("Test/Feed")).toEqual({
			State: "none"
		});
		world.runtime.dispose();
	});
});

describe("resources: retirement", () => {
	it("closes: the instance retires closed, queued emits drop, the value releases before the abort, and later r.* calls do nothing", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const order: string[] = [];
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			r.expose("url-1", (v) => order.push(`release:${v}`));
			r.signal.addEventListener("abort", () => order.push(`abort:${r.signal.reason.message}`));
		});
		await world.dispatch(openFeed);
		expect(world.manager.value("Test/Feed", "root")).toBe("url-1");
		void ctx.emit({
			N: 1
		});
		await world.dispatch(closeFeed);
		await settle();
		expect(world.runtime.state.Log).toEqual([]);
		expect(order).toEqual([
			"release:url-1",
			"abort:closed"
		]);
		expect(world.manager.value("Test/Feed", "root")).toBeUndefined();
		expect(world.status("Test/Feed")).toEqual({
			State: "none"
		});
		const lateRelease = vi.fn();
		ctx.expose("url-2", lateRelease);
		expect(lateRelease).toHaveBeenCalledWith("url-2");
		ctx.end("late");
		ctx.status("late");
		await expect(ctx.run((function* () {})())).rejects.toMatchObject({
			name: "AbortError",
			message: "closed"
		});
		await ctx.emit({
			N: 2
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([]);
		expect(world.status("Test/Feed")).toEqual({
			State: "none"
		});
		world.runtime.dispose();
	});

	it("never outlives its owner: the cascade retires it disposed and clears status and value, outliving the opening action until then", async () => {
		const world = build();
		const reasons: unknown[] = [];
		const released: string[] = [];
		world.runtime.registerResourceType("test/quiet", (params, r) => {
			r.signal.addEventListener("abort", () => reasons.push(r.signal.reason.message));
			r.expose(params.Label as never, () => released.push(params.Label));
		});
		function* openChild(draft: IChild, label: string): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: label
			});
		}
		await world.runtime.dispatch(openChild, "child-1", "c1");
		function* openRoot(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "root"
			});
		}
		await world.dispatch(openRoot);
		await settle();
		expect(reasons).toEqual([]);
		treeWrite(world.runtime, (s) => {
			s.Children = [];
		});
		await settle();
		expect(reasons).toEqual([
			"disposed"
		]);
		expect(released).toEqual([
			"c1"
		]);
		expect(world.runtime.resources().map((row) => row.OwnerId)).toEqual([
			"root"
		]);
		expect(world.status("Test/Quiet", "child-1")).toEqual({
			State: "none"
		});
		world.runtime.dispose();
	});

	it("clears an ended cell's status when its owner leaves, after the ending retracted the row", async () => {
		const world = build();
		world.runtime.registerResourceType("test/quiet", (_params, r) => {
			r.end("finished");
		});
		function* openChild(draft: IChild): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "x"
			});
		}
		await world.runtime.dispatch(openChild, "child-1");
		await settle();
		expect(world.status("Test/Quiet", "child-1").State).toBe("ended");
		expect(world.runtime.resources()).toEqual([]);
		treeWrite(world.runtime, (s) => {
			s.Children = [];
		});
		await settle();
		expect(world.status("Test/Quiet", "child-1")).toEqual({
			State: "none"
		});
		world.runtime.dispose();
	});

	it("an explicit close of an ended cell clears its status", async () => {
		const world = build();
		world.runtime.registerResourceType("test/quiet", (_params, r) => {
			r.end("finished");
		});
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "x"
			});
		}
		function* close(draft: IRoot): IActionGenerator {
			yield* closeResource(draft, "Test/Quiet");
		}
		await world.dispatch(open);
		await settle();
		expect(world.status("Test/Quiet").State).toBe("ended");
		await world.dispatch(close);
		await settle();
		expect(world.status("Test/Quiet")).toEqual({
			State: "none"
		});
		world.runtime.dispose();
	});

	it("runtime.dispose releases, aborts and drops without running anything queued", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const order: string[] = [];
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			r.expose("v", () => order.push("release"));
			r.signal.addEventListener("abort", () => order.push(`abort:${r.signal.reason.message}`));
			r.onSupply(() => {
				order.push("supplied");
				return {
					Count: 1
				};
			});
		});
		await world.dispatch(openFeed);
		void ctx.emit({
			N: 1
		});
		const supplied = world.runtime.supplyResource(world.runtime.state, "Test/Feed", [
			"f"
		]);
		world.runtime.dispose();
		expect(order).toEqual([
			"release",
			"abort:disposed"
		]);
		expect(await supplied).toBeUndefined();
		await settle();
		expect(world.runtime.state.Log).toEqual([]);
	});
});

describe("resources: methods", () => {
	function registerFeed(world: ReturnType<typeof build>, ready?: Promise<void>) {
		const calls: AbortSignal[] = [];
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			r.methods({
				echo: async (c, text) => {
					calls.push(c.signal);
					await ready;
					return `${text}!`;
				},
				fail: () => {
					throw new AppError("refused");
				},
				slow: (c) =>
					new Promise((resolve) => {
						calls.push(c.signal);
						c.signal.addEventListener("abort", () => resolve("late"));
					})
			});
		});
		return calls;
	}

	it("answers with the handler's result, and queues calls that arrive during setup", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		registerFeed(world);
		function* openAndCall(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", FeedReceiver, {
				Type: "test/feed"
			});
			const result = yield* resource(draft, "Test/Feed").echo("hi");
			draft.Log.push(result ?? "none");
		}
		await world.dispatch(openAndCall);
		expect(world.runtime.state.Log).toEqual([
			"hi!"
		]);
		world.runtime.dispose();
	});

	it("sends a handler's error to the caller by reference", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		registerFeed(world);
		let caught: unknown;
		function* call(draft: IRoot): IActionGenerator {
			try {
				yield* resource(draft.$Id, "Test/Feed").fail();
			} catch (error) {
				caught = error;
			}
		}
		await world.dispatch(openFeed);
		await world.dispatch(call);
		expect(caught).toBeInstanceOf(AppError);
		world.runtime.dispose();
	});

	it("resolves undefined with a diag when no row exists, and names an ended cell as ended", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		registerFeed(world);
		function* call(draft: IRoot): IActionGenerator {
			const result = yield* resource(draft, "Test/Feed").echo("x");
			draft.Log.push(result === undefined ? "undefined" : result);
		}
		await world.dispatch(call);
		expect(world.codes()).toContain("resource/not-open");
		world.runtime.registerResourceType("test/quiet", (_params, r) => {
			r.end("finished");
		});
		function* openQuiet(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "q"
			});
		}
		function* ping(draft: IRoot): IActionGenerator {
			const result = yield* resource(draft, "Test/Quiet").ping();
			draft.Log.push(result === undefined ? "undefined" : result);
		}
		await world.dispatch(openQuiet);
		await settle();
		await world.dispatch(ping);
		expect(world.codes()).toContain("resource/used-after-end");
		expect(world.runtime.state.Log).toEqual([
			"undefined",
			"undefined"
		]);
		world.runtime.dispose();
	});

	it("resolves undefined for a method the type did not register, with a diag", async () => {
		const world = build();
		world.runtime.registerResourceType("test/quiet", () => {});
		function* openAndPing(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "q"
			});
			const result = yield* resource(draft, "Test/Quiet").ping();
			draft.Log.push(result === undefined ? "undefined" : result);
		}
		await world.dispatch(openAndPing);
		expect(world.runtime.state.Log).toEqual([
			"undefined"
		]);
		expect(world.codes()).toContain("resource/unknown-method");
		world.runtime.dispose();
	});

	it("aborts ctx.signal and resolves undefined when the instance retires before answering", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const signals = registerFeed(world);
		function* call(draft: IRoot) {
			const result = yield* openRegion(resource(draft, "Test/Feed").slow());
			draft.Log.push(result === undefined ? "undefined" : result);
		}
		await world.dispatch(openFeed);
		const pending = world.dispatch(call);
		await settle();
		await world.dispatch(closeFeed);
		await pending;
		expect(signals[0].aborted).toBe(true);
		expect(world.runtime.state.Log).toEqual([
			"undefined"
		]);
		world.runtime.dispose();
	});

	it("rejects non-plain arguments and results", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			r.methods({
				echo: () => new Date(0) as never,
				fail: () => {},
				slow: () => ""
			});
		});
		await world.dispatch(openFeed);
		function* badResult(draft: IRoot): IActionGenerator {
			yield* resource(draft, "Test/Feed").echo("x");
		}
		const refusal = world.dispatch(badResult);
		await expect(refusal).rejects.toThrow(NonPlainDataError);
		await expect(refusal).rejects.toThrow(/the result is not plain: Date at \[\]/);
		function* badArgument(draft: IRoot): IActionGenerator {
			yield* resource(draft, "Test/Feed").echo(new Date(0) as never);
		}
		await expect(world.dispatch(badArgument)).rejects.toThrow(NonPlainDataError);
		const manager = (world.runtime as IRuntimeInternal<IRoot>).get("runtime/resources");
		await expect(
			manager.call(
				{
					Key: "Test/Feed",
					OwnerId: "root",
					Method: "echo",
					Args: [
						new Date(0)
					]
				} as never,
				new AbortController().signal
			)
		).rejects.toThrow(/an argument is not plain: Date at \[0\]/);
		world.runtime.dispose();
	});

	it("refuses non-plain params at the open's yield, before any row", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		function* badParams(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", FeedReceiver, {
				Type: "test/feed",
				Since: new Date(0)
			} as never);
		}
		await expect(world.dispatch(badParams)).rejects.toThrow(/openResource: the input is not plain: Date at \[Params\.Since\]/);
		expect(world.runtime.resources()).toEqual([]);
		world.runtime.dispose();
	});
});

describe("resources: supply and expose", () => {
	it("hands a supplied live value to onSupply through the drain, clones the response, and records the supply", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const held: unknown[] = [];
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			r.onSupply((files) => {
				held.push(files);
				return {
					Count: files.length
				};
			});
		});
		await world.dispatch(openFeed);
		const live = [
			"a",
			"b"
		] as const;
		const answer = await world.runtime.supplyResource("root", "Test/Feed", live);
		expect(answer).toEqual({
			Count: 2
		});
		expect(held[0]).toBe(live);
		expect(world.records.some((r) => r.Kind === "resource:supply" && r.Key === "Test/Feed" && r.OwnerId === "root")).toBe(true);
		world.runtime.dispose();
	});

	it("resolves undefined with a diag when nothing can take the value", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		world.runtime.registerResourceType("test/feed", () => {});
		expect(
			await world.runtime.supplyResource("root", "Test/Feed", [
				"a"
			])
		).toBeUndefined();
		await world.dispatch(openFeed);
		expect(
			await world.runtime.supplyResource("root", "Test/Feed", [
				"a"
			])
		).toBeUndefined();
		expect(world.codes().filter((c) => c === "resource/supply-dropped")).toHaveLength(2);
		world.runtime.dispose();
	});

	it("registers methods and onSupply during setup only", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let late: unknown;
		world.runtime.registerResourceType("test/feed", async (_params, r) => {
			await Promise.resolve();
			try {
				r.onSupply(() => ({
					Count: 0
				}));
			} catch (error) {
				late = error;
			}
		});
		await world.dispatch(openFeed);
		await settle();
		expect((late as Error).name).toBe("ResourceSetupError");
		world.runtime.dispose();
	});

	it("replaces the exposed value, releasing the previous one, and shows a status detail", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const released: string[] = [];
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			r.expose("one", (v) => released.push(v));
		});
		await world.dispatch(openFeed);
		ctx.expose("two", (v) => released.push(v));
		expect(released).toEqual([
			"one"
		]);
		expect(world.manager.value("Test/Feed", "root")).toBe("two");
		ctx.status("retrying");
		await settle();
		expect(world.status("Test/Feed")).toEqual({
			State: "live",
			Detail: "retrying"
		});
		ctx.status();
		await settle();
		expect(world.status("Test/Feed")).toEqual({
			State: "live"
		});
		world.runtime.dispose();
	});
});

describe("resources: r.run", () => {
	it("runs an effect as the owner with a resource:run origin, clones the result and withholds it from the tap", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		defineEffect("test/headers" as never, {
			redact: true
		});
		world.runtime.registerImplementation("test/headers", () => ({
			Authorization: "secret"
		}));
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		await world.dispatch(openFeed);
		const liveResults: unknown[] = [];
		world.runtime.on("record", (record, live) => {
			if (live && "result" in live) {
				liveResults.push(live.result);
			}
		});
		function* headers(): Generator<any, Record<string, string>, any> {
			return yield {
				Type: "test/headers"
			};
		}
		const result = await ctx.run(headers());
		expect(result).toEqual({
			Authorization: "secret"
		});
		expect(liveResults).toEqual([]);
		const start = world.records.find((r) => r.Kind === "action:start" && r.Origin?.Kind === "resource:run");
		expect(start).toMatchObject({
			EntityId: "root",
			Origin: {
				Key: "Test/Feed",
				OwnerId: "root"
			}
		});
		world.runtime.dispose();
	});

	it("rejects without escalating or reaching onError, and refuses the effects that tie work to the tree", async () => {
		const errors: unknown[] = [];
		const world = build({
			onError: (e) => errors.push(e)
		});
		world.runtime.registerReceiver(FeedReceiver);
		world.runtime.registerImplementation("test/broken", () => {
			throw new AppError("down");
		});
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		await world.dispatch(openFeed);
		function* broken(): Generator<any, void, any> {
			yield {
				Type: "test/broken"
			};
		}
		await expect(ctx.run(broken())).rejects.toBeInstanceOf(AppError);
		function* timer(): Generator<any, void, any> {
			yield* (startTimer as unknown as (...args: unknown[]) => Generator<any, void, any>)(world.runtime.state, "x", FeedReceiver, 10);
		}
		await expect(ctx.run(timer())).rejects.toThrow(/r\.run refuses/);
		expect(errors).toEqual([]);
		world.runtime.dispose();
	});

	it("refuses any ask an r.run opens, whatever its owner, inside open or not, since an action on any entity may be awaiting the method", async () => {
		const world = build();
		const refusals: unknown[] = [];
		function* asksOn(ownerId: string, opened: boolean): Generator<any, unknown, any> {
			const asking = ask<string>(ownerId, {
				Path: "Run"
			});
			return opened ? yield* openRegion(asking) : yield* asking;
		}
		world.runtime.registerResourceType("test/quiet", (_params, r) => {
			r.methods({
				ping: async () => {
					for (const [ownerId, opened] of [
						[
							"root",
							false
						],
						[
							"root",
							true
						],
						[
							"child-1",
							false
						],
						[
							"child-1",
							true
						]
					] as const) {
						try {
							await r.run(asksOn(ownerId, opened));
						} catch (error) {
							refusals.push(error);
						}
					}
					return "pinged";
				}
			});
		});
		await world.dispatch(function* openQuiet(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "q"
			});
		});
		await world.dispatch(function* pings(draft: IRoot): IActionGenerator {
			draft.Log.push((yield* resource(draft, "Test/Quiet").ping()) ?? "none");
		});
		expect(world.runtime.state.Log).toEqual([
			"pinged"
		]);
		const inRun = {
			name: "AskRefusedError",
			reason: "in-run",
			entityId: "root"
		};
		expect(refusals).toMatchObject([
			{
				...inRun,
				ownerId: "root"
			},
			inRun,
			{
				...inRun,
				ownerId: "child-1"
			},
			inRun
		]);
		expect((refusals[0] as Error).message).toMatch(/a resource can't ask a person/);
		expect(world.records.filter((record) => record.Kind === "table" && record.Table === "asks")).toHaveLength(0);
		world.runtime.dispose();
	});

	it("reaches methods only on the owner's ancestors", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			r.methods({
				echo: (_c, text) => text,
				fail: () => {},
				slow: () => ""
			});
		});
		let childCtx!: IResourceContext<"test/quiet">;
		world.runtime.registerResourceType("test/quiet", (_params, r) => {
			childCtx = r;
		});
		await world.dispatch(openFeed);
		function* openChild(draft: IChild): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "c"
			});
		}
		await world.runtime.dispatch(openChild, "child-1");
		function* askParent(): Generator<any, unknown, any> {
			return yield* resource("root", "Test/Feed").echo("up");
		}
		expect(await childCtx.run(askParent())).toBe("up");
		function* askSelf(): Generator<any, unknown, any> {
			return yield* resource("child-1", "Test/Quiet").ping();
		}
		await expect(childCtx.run(askSelf())).rejects.toThrow(/not an ancestor/);
		world.runtime.dispose();
	});

	it("leaves a parked delivery running through a replacement of its owner, so its message is applied", async () => {
		const world = build();
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const ran: string[] = [];
		const Parked = receiver<IChild>("ParkedDeliveryReceiver")({
			*"Test/Feed"(_draft, e) {
				if (isEnded(e)) {
					return;
				}
				yield {
					Type: "test/gate"
				};
				ran.push(`after the park:${e.N}`);
			}
		});
		world.runtime.registerReceiver(Parked);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
		});
		await world.runtime.dispatch(function* open(draft: IChild): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Parked, {
				Type: "test/feed"
			});
		}, "child-1");
		await settle();
		void ctx.emit({
			N: 1
		});
		await settle();
		rawWrite(world.runtime, (s) => {
			s.Children = [
				{
					$Id: "child-1",
					Log: [],
					Cursor: null
				}
			];
		});
		release();

		await settle();
		expect(ran).toEqual([
			"after the park:1"
		]);
		world.runtime.dispose();
	});
});

describe("resources: same-tick ordering", () => {
	function registerEcho(world: ReturnType<typeof build>, setups: string[], aborts: string[] = []) {
		world.runtime.registerResourceType("test/feed", (params, r) => {
			const label = String((params as Record<string, unknown>).Extra ?? "-");
			setups.push(label);
			r.signal.addEventListener("abort", () => aborts.push(label));
			r.methods({
				echo: (_c, text) => `${label}:${text}`,
				fail: () => {},
				slow: () => ""
			});
		});
	}
	function* openWith(draft: IRoot, extra: string): IActionGenerator {
		yield* openResource(draft, "Test/Feed", FeedReceiver, {
			Type: "test/feed",
			Extra: extra
		} as never);
	}
	function* echo(draft: IRoot): IActionGenerator {
		const result = yield* resource(draft, "Test/Feed").echo("hi");
		draft.Log.push(result ?? "none");
	}

	it("queues a method dispatched in the same tick as the open", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		registerEcho(world, []);
		await Promise.all([
			world.dispatch(openWith, "a"),
			world.dispatch(echo)
		]);
		expect(world.runtime.state.Log).toEqual([
			"a:hi"
		]);
		world.runtime.dispose();
	});

	it("answers a method dispatched in the same tick as a replace from the successor", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		registerEcho(world, []);
		await world.dispatch(openWith, "a");
		await Promise.all([
			world.dispatch(openWith, "b"),
			world.dispatch(echo)
		]);
		expect(world.runtime.state.Log).toEqual([
			"b:hi"
		]);
		world.runtime.dispose();
	});

	it("answers from the reopened instance when an ended cell is reopened in the same tick, with no used-after-end diag", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const contexts: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			contexts.push(r);
			r.methods({
				echo: (_c, text) => `${contexts.length}:${text}`,
				fail: () => {},
				slow: () => ""
			});
		});
		await world.dispatch(openWith, "a");
		contexts[0].end("done");
		await settle();
		treeWrite(world.runtime, (s) => {
			s.Log = [];
		});
		await Promise.all([
			world.dispatch(openWith, "a"),
			world.dispatch(echo)
		]);
		expect(world.runtime.state.Log).toEqual([
			"2:hi"
		]);
		expect(world.codes()).not.toContain("resource/used-after-end");
		world.runtime.dispose();
	});

	it("does not restart an ending instance when its receiver or type re-registers mid-ending", async () => {
		const world = build();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		world.runtime.registerImplementation("test/gate", () => gate);
		const Gated = receiver<IRoot>("EndingGated")({
			*"Test/Feed"(draft, e) {
				if (isEnded(e)) {
					draft.Log.push("ended");
					return;
				}
				yield {
					Type: "test/gate"
				};
				draft.Log.push(e.N);
			}
		});
		world.runtime.registerReceiver(Gated);
		let setups = 0;
		let ctx!: IResourceContext<"test/feed">;
		const implementation = (_params: unknown, r: IResourceContext<"test/feed">) => {
			setups++;
			ctx = r;
		};
		world.runtime.registerResourceType("test/feed", implementation);
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Gated, {
				Type: "test/feed"
			});
		}
		await world.dispatch(open);
		void ctx.emit({
			N: 1
		});
		ctx.end("done");
		await settle();
		world.runtime.registerReceiver(Gated);
		world.runtime.registerResourceType("test/feed", implementation);
		await settle();
		release();
		await settle();
		expect(setups).toBe(1);
		expect(world.runtime.state.Log).toEqual([
			1,
			"ended"
		]);
		expect(world.runtime.resources()).toEqual([]);
		expect(world.status("Test/Feed")).toEqual({
			State: "ended",
			Reason: "done"
		});
		world.runtime.dispose();
	});

	it("aborts the old instance before the replacement's setup when a receiver re-registers in the same tick", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		const order: string[] = [];
		world.runtime.registerResourceType("test/feed", (params, r) => {
			const label = String((params as Record<string, unknown>).Extra);
			order.push(`setup:${label}`);
			r.signal.addEventListener("abort", () => order.push(`abort:${label}`));
		});
		await world.dispatch(openWith, "a");
		world.runtime.registerReceiver(FeedReceiver);
		await world.dispatch(openWith, "b");
		await settle();
		expect(order).toEqual([
			"setup:a",
			"abort:a",
			"setup:b"
		]);
		world.runtime.dispose();
	});

	it("aborts with an AbortError carrying the retirement reason, and r.run after retirement rejects with it", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let ctx!: IResourceContext<"test/feed">;
		let callSignal!: AbortSignal;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			r.methods({
				echo: () => "",
				fail: () => {},
				slow: (c) =>
					new Promise((resolve) => {
						callSignal = c.signal;
						c.signal.addEventListener("abort", () => resolve(""));
					})
			});
		});
		await world.dispatch(openFeed);
		function* slow(draft: IRoot) {
			yield* openRegion(resource(draft, "Test/Feed").slow());
		}
		const pending = world.dispatch(slow);
		await settle();
		await world.dispatch(closeFeed);
		await settle();
		await pending;
		const reason = ctx.signal.reason as DOMException;
		expect(reason).toBeInstanceOf(DOMException);
		expect(reason.name).toBe("AbortError");
		expect(reason.message).toBe("closed");
		expect(callSignal.reason).toBe(reason);
		await expect(ctx.run((function* () {})())).rejects.toBe(reason);
		world.runtime.dispose();
	});
});

describe("resources: owner churn", () => {
	it("sets up one instance when the owner is removed, re-added under its $Id and reopened in one stretch", async () => {
		const world = build();
		const setups: AbortSignal[] = [];
		world.runtime.registerResourceType("test/quiet", (_params, r) => {
			setups.push(r.signal);
		});
		function* openChild(draft: IChild): IActionGenerator {
			yield* openResource(draft, "Test/Quiet", {
				Type: "test/quiet",
				Label: "c"
			});
		}
		function* closeChild(draft: IChild): IActionGenerator {
			yield* closeResource(draft, "Test/Quiet");
		}
		await world.runtime.dispatch(openChild, "child-1");
		expect(setups).toHaveLength(1);
		treeWrite(world.runtime, (s) => {
			s.Children = [];
		});
		treeWrite(world.runtime, (s) => {
			seat(s, "Children", [
				{
					$Id: "child-1",
					Log: [],
					Cursor: null
				}
			]);
		});
		await world.runtime.dispatch(openChild, "child-1");
		await settle();
		expect(setups).toHaveLength(2);
		await world.runtime.dispatch(closeChild, "child-1");
		await settle();
		expect(setups.every((signal) => signal.aborted)).toBe(true);
		world.runtime.dispose();
	});

	it("drops a view's status tracking with its owner, whether or not the key was ever opened", async () => {
		const world = build();
		const baseline = world.manager.trackedCellCount();
		world.status("Test/Quiet", "child-1");
		world.manager.value("Test/Feed", "child-1");
		expect(world.manager.trackedCellCount()).toBe(baseline + 2);
		treeWrite(world.runtime, (s) => {
			s.Children = [];
		});
		await settle();
		expect(world.manager.trackedCellCount()).toBe(baseline);
		world.runtime.dispose();
	});
});

describe("resources: tidy", () => {
	function* openQuiet(draft: IRoot): IActionGenerator {
		yield* openResource(draft, "Test/Quiet", {
			Type: "test/quiet",
			Label: "q"
		});
	}

	it("reads none after runtime.dispose", async () => {
		const world = build();
		world.runtime.registerResourceType("test/quiet", () => {});
		await world.dispatch(openQuiet);
		expect(world.status("Test/Quiet").State).toBe("live");
		world.runtime.dispose();
		expect(world.status("Test/Quiet")).toEqual({
			State: "none"
		});
	});

	it("keeps a setup's own r.end when the setup then throws, with no failed diag", async () => {
		const world = build();
		world.runtime.registerResourceType("test/quiet", (_params, r) => {
			r.end("bye");
			throw new Error("after the end");
		});
		await world.dispatch(openQuiet);
		await settle();
		expect(world.codes()).not.toContain("resource/ended");
		expect(world.status("Test/Quiet")).toEqual({
			State: "ended",
			Reason: "bye"
		});
		world.runtime.dispose();
	});
});

describe("resources: the pause option", () => {
	it("records rows and connects nothing; methods resolve undefined", async () => {
		const world = build({
			pauseResources: true
		});
		world.runtime.registerReceiver(FeedReceiver);
		const setup = vi.fn();
		world.runtime.registerResourceType("test/feed", setup);
		function* openAndCall(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", FeedReceiver, {
				Type: "test/feed"
			});
			const result = yield* resource(draft, "Test/Feed").echo("x");
			draft.Log.push(result === undefined ? "undefined" : result);
		}
		await world.dispatch(openAndCall);
		await settle();
		expect(setup).not.toHaveBeenCalled();
		expect(world.runtime.resources()).toHaveLength(1);
		expect(world.status("Test/Feed")).toEqual({
			State: "pending",
			Waiting: "paused"
		});
		expect(world.runtime.state.Log).toEqual([
			"undefined"
		]);
		world.runtime.dispose();
	});
});

describe("resources: a receiver and its own cell", () => {
	function* callsEcho(draft: IRoot): IActionGenerator {
		draft.Log.push((yield* resource(draft, "Test/Feed").echo("started")) ?? "none");
	}
	function* echoOrRefused(draft: IRoot): IActionGenerator {
		try {
			draft.Log.push((yield* resource(draft, "Test/Feed").echo("direct")) ?? "none");
		} catch (error) {
			draft.Log.push(String(error).includes("before the reopened instance was set up") ? "refused" : String(error));
		}
	}

	it("refuses a method its $Ended case calls on the instance it just reopened, and a start of it answers", async () => {
		const world = build();
		const Reopening: IReceiver<IRoot, "Test/Feed"> = receiver<IRoot>("ReopenThenCallReceiver")({
			*"Test/Feed"(draft: IRoot, e: IResourceDeliveryOf<"Test/Feed">): IActionGenerator {
				if (!isEnded(e)) return;
				yield* openResource(draft, "Test/Feed", Reopening, {
					Type: "test/feed",
					Extra: "b"
				} as never);
				yield* echoOrRefused(draft);
				yield* start(callsEcho, draft.$Id);
			}
		});
		world.runtime.registerReceiver(Reopening);
		const contexts: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (params, r) => {
			contexts.push(r);
			const label = String((params as Record<string, unknown>).Extra ?? "-");
			r.methods({
				echo: (_c, text) => `${label}:${text}`,
				fail: () => {},
				slow: () => ""
			});
		});
		await world.dispatch(function* openA(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Reopening, {
				Type: "test/feed",
				Extra: "a"
			} as never);
		});
		contexts[0].end("lost");
		await settle();
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"refused",
			"b:started"
		]);
		world.runtime.dispose();
	});

	it("refuses the same call from a branch of the delivery, which inherits its origin", async () => {
		const world = build();
		const Spawning: IReceiver<IRoot, "Test/Feed"> = receiver<IRoot>("ReopenThenSpawnReceiver")({
			*"Test/Feed"(draft: IRoot, e: IResourceDeliveryOf<"Test/Feed">): IActionGenerator {
				if (!isEnded(e)) return;
				yield* openResource(draft, "Test/Feed", Spawning, {
					Type: "test/feed",
					Extra: "b"
				} as never);
				yield* parallel(echoOrRefused(draft));
			}
		});
		world.runtime.registerReceiver(Spawning);
		const contexts: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (params, r) => {
			contexts.push(r);
			const label = String((params as Record<string, unknown>).Extra ?? "-");
			r.methods({
				echo: (_c, text) => `${label}:${text}`,
				fail: () => {},
				slow: () => ""
			});
		});
		await world.dispatch(function* openA(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Spawning, {
				Type: "test/feed",
				Extra: "a"
			} as never);
		});
		contexts[0].end("lost");
		await settle();
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"refused"
		]);
		expect(world.status("Test/Feed").State).toBe("live");
		world.runtime.dispose();
	});

	it("refuses a method a delivery calls on the instance it just replaced", async () => {
		const world = build();
		const Replacing: IReceiver<IRoot, "Test/Feed"> = receiver<IRoot>("ReplaceThenCallReceiver")({
			*"Test/Feed"(draft: IRoot, e: IResourceDeliveryOf<"Test/Feed">): IActionGenerator {
				if (isEnded(e)) return;
				yield* openResource(draft, "Test/Feed", Replacing, {
					Type: "test/feed",
					Extra: "b"
				} as never);
				yield* echoOrRefused(draft);
			}
		});
		world.runtime.registerReceiver(Replacing);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (params, r) => {
			ctx ??= r;
			const label = String((params as Record<string, unknown>).Extra ?? "-");
			r.methods({
				echo: (_c, text) => `${label}:${text}`,
				fail: () => {},
				slow: () => ""
			});
		});
		await world.dispatch(function* openA(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Replacing, {
				Type: "test/feed",
				Extra: "a"
			} as never);
		});
		void ctx.emit({
			N: 1
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"refused"
		]);
		expect(world.status("Test/Feed").State).toBe("live");
		world.runtime.dispose();
	});

	it("lets a delivery call its own live instance's method directly", async () => {
		const world = build();
		const Calling = receiver<IRoot>("DirectCallReceiver")({
			*"Test/Feed"(draft, e) {
				if (isEnded(e)) return;
				yield* echoOrRefused(draft);
			}
		});
		world.runtime.registerReceiver(Calling);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			r.methods({
				echo: (_c, text) => `live:${text}`,
				fail: () => {},
				slow: () => ""
			});
		});
		await world.dispatch(function* openCalling(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Calling, {
				Type: "test/feed"
			});
		});
		void ctx.emit({
			N: 1
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"live:direct"
		]);
		world.runtime.dispose();
	});

	it("applies endOnReceiverFailure during an ending: what was queued behind the failure is dropped and $Ended says receiver-failed", async () => {
		const errors: unknown[] = [];
		const world = build({
			onError: (e) => errors.push(e)
		});
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const Throwing = receiver<IRoot>("EndingFailureReceiver")({
			*"Test/Feed"(draft, e) {
				if (isEnded(e)) {
					draft.Log.push(`ended:${e.$Ended.Reason}`);
					return;
				}
				if (e.N === 1) {
					throw new AppError("bad batch");
				}
				draft.Log.push(e.N);
			}
		});
		world.runtime.registerReceiver(Throwing);
		let ctx!: IResourceContext<"test/feed">;
		world.runtime.registerResourceType(
			"test/feed",
			(_params, r) => {
				ctx = r;
			},
			{
				endOnReceiverFailure: true
			}
		);
		await world.dispatch(function* openThrowing(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", Throwing, {
				Type: "test/feed"
			});
		});
		const holding = world.dispatch(function* longSave(): IActionGenerator {
			yield* testGate();
		});
		await settle();
		for (const n of [
			1,
			2,
			3
		]) {
			void ctx.emit({
				N: n
			});
		}
		ctx.end("lost");
		await settle();
		release();
		await holding;
		await settle();
		await settle();
		expect(world.runtime.state.Log).toEqual([
			"ended:receiver-failed"
		]);
		expect(world.status("Test/Feed")).toEqual({
			State: "ended",
			Reason: "receiver-failed"
		});
		expect(errors).toEqual([
			expect.objectContaining({
				message: "bad batch"
			})
		]);
		world.runtime.dispose();
	});

	it("defers an onIdle callback registered from inside one until the next delivery settles", async () => {
		const world = build();
		world.runtime.registerReceiver(FeedReceiver);
		let ctx!: IResourceContext<"test/feed">;
		let calls = 0;
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			ctx = r;
			const again = () => {
				calls++;
				r.onIdle(again);
			};
			r.onIdle(again);
		});
		await world.dispatch(openFeed);
		await settle();
		expect(calls).toBe(1);
		void ctx.emit({
			N: 1
		});
		await settle();
		expect(world.runtime.state.Log).toEqual([
			1
		]);
		expect(calls).toBe(2);
		world.runtime.dispose();
	});

	it("runs an onIdle callback registered inside one on a later turn when its emit has no receiver or is invalid", async () => {
		for (const invalid of [
			false,
			true
		]) {
			const world = build();
			let calls = 0;
			world.runtime.registerResourceType("test/feed", (_params, r) => {
				const again = () => {
					calls++;
					if (calls < 3) {
						void r.emit(
							(invalid
								? [
										calls
									]
								: {
										N: calls
									}) as never
						);
					}
					r.onIdle(again);
				};
				r.onIdle(again);
			});
			await world.dispatch(function* openIt(draft: IRoot): IActionGenerator {
				yield* openResource(draft, "Test/Silent", {
					Type: "test/feed"
				});
			});
			for (let turn = 0; turn < 6; turn++) {
				await settle();
			}
			expect(calls, invalid ? "invalid" : "no receiver").toBe(3);
			world.runtime.dispose();
		}
	});

	it("drops a delivery queued at the gate when its instance retires, so a leading receiver takes the next instance's first message", async () => {
		const world = build();
		let release!: () => void;
		world.runtime.registerImplementation(
			"test/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const contexts: IResourceContext<"test/feed">[] = [];
		world.runtime.registerResourceType("test/feed", (_params, r) => {
			contexts.push(r);
		});
		world.runtime.registerReceiver({
			...FeedReceiver,
			handle: leading(FeedReceiver.handle as never) as never
		});
		const holding = world.dispatch(function* replacesWhileHeld(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Test/Feed", FeedReceiver, {
				Type: "test/feed",
				Extra: "a"
			} as never);
			yield* testGate();
			yield* openResource(draft, "Test/Feed", FeedReceiver, {
				Type: "test/feed",
				Extra: "b"
			} as never);
			yield* testGate();
		});
		await settle();
		void contexts[0].emit({
			N: 1
		});
		await settle();
		release();
		await settle();
		expect(contexts).toHaveLength(2);
		const stale = world.records.find((r) => r.Kind === "action:start" && r.Origin?.Kind === "resource:deliver");
		const staleId = stale?.Kind === "action:start" ? stale.ActionId : null;
		expect(world.records.find((r) => r.Kind === "action:end" && r.ActionId === staleId)).toMatchObject({
			Status: "dropped"
		});
		void contexts[1].emit({
			N: 2
		});
		await settle();
		release();
		await holding;
		await settle();
		expect(world.runtime.state.Log).toEqual([
			2
		]);
		world.runtime.dispose();
	});
});
