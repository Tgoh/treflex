import type { IResourceDeliveryOf } from "../../src/Registries/IResourceRegistry";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import type { IResourceContext } from "../../src/Types/IResource";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { createEffect, createMemo, createRoot } from "solid-js";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { select } from "../../src/Reads/select";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { inFlight } from "../../src/Runtime/arrivals";
import { bind } from "../../src/Runtime/bind";
import { createRuntime, type IRuntime, type IRuntimeOptions } from "../../src/Runtime/createRuntime";
import { seat } from "../../src/Runtime/draftNode";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { inFlightOf } from "../testHelpers";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"Leading/Ping": {};
	}
}

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"leading/feed": {
			Message: {
				N: number;
			};
		};
	}
	interface IResourceRegistry {
		"Leading/Feed": {
			Type: "leading/feed";
		};
	}
}

interface IDoc extends IEntity {
	Runs: number;
	Saved?: string;
	Settings?: object;
}

interface IWorld extends IEntity {
	Docs: IDoc[];
	Other: IDoc[];
	Seen?: unknown;
}

function doc(id: string): IDoc {
	return {
		$Id: id,
		Runs: 0
	};
}

function seed(): IWorld {
	return {
		$Id: "root",
		Docs: [
			doc("a"),
			doc("b")
		],
		Other: []
	};
}

function* park(): IActionGenerator<string> {
	return yield {
		Type: "park"
	};
}

const save = leading(function* saveDoc(draft: IDoc, title: string): IActionGenerator<string> {
	draft.Runs++;
	const answer = yield* park();
	draft.Saved = title;
	return `${title}:${answer}`;
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const optionsFor = (errors: unknown[]): IRuntimeOptions => ({
	onError: (error) => errors.push(error)
});

function build() {
	const errors: unknown[] = [];
	return wire(createRuntime<IWorld>(seed(), optionsFor(errors)), errors);
}

function wire(built: IRuntime<IWorld>, errors: unknown[]) {
	const runtime = built as IRuntimeInternal<IWorld>;
	const releases: ((value?: unknown) => void)[] = [];
	const fails: ((error: unknown) => void)[] = [];
	runtime.registerImplementation(
		"park",
		() =>
			new Promise((resolve, reject) => {
				releases.push(resolve);
				fails.push(reject);
			})
	);
	const records: IRecord[] = [];
	runtime.on("record", (record) => {
		records.push(record);
	});
	const a = () => runtime.state.Docs[0];
	const b = () => runtime.state.Docs[1];
	const run = <R>(action: (draft: IWorld) => IActionGenerator<R>): Promise<R | undefined> => runtime.dispatch(action, "root");
	const onA = <R>(action: (draft: IDoc) => IActionGenerator<R>): Promise<R | undefined> => runtime.dispatch(action, "a");
	return {
		runtime,
		errors,
		releases,
		fails,
		records,
		a,
		b,
		run,
		onA
	};
}

async function restoreBuilt(saved: string) {
	const errors: unknown[] = [];
	let world!: ReturnType<typeof wire>;
	await restoreRuntime<IWorld>(saved, {
		rootId: "root",
		options: optionsFor(errors),
		setup: (runtime) => {
			world = wire(runtime, errors);
		}
	});
	return world;
}

function* removeA(draft: IWorld): IActionGenerator {
	draft.Docs.shift();
}

function* addA(draft: IWorld): IActionGenerator {
	seat(draft, "Docs", [
		doc("a"),
		...draft.Docs
	]);
}

export function leadingRules(build_: string): void {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe(`leading ${build_}: a repeat`, () => {
		it("is dropped on two dispatches in a row: undefined at once, no body, and the first run's result is its own", async () => {
			const h = build();
			const first = h.runtime.dispatch(save, "a", "one");
			await expect(h.runtime.dispatch(save, "a", "two")).resolves.toBeUndefined();
			expect(h.a().Runs).toBe(1);
			h.releases[0]("done");
			await expect(first).resolves.toBe("one:done");
			expect(h.a().Saved).toBe("one");
			expect(h.releases).toHaveLength(1);
		});

		it("runs again once the first has finished", async () => {
			const h = build();
			const first = h.runtime.dispatch(save, "a", "one");
			h.releases[0]("done");
			await first;
			const second = h.runtime.dispatch(save, "a", "two");
			expect(h.a().Runs).toBe(2);
			h.releases[1]("again");
			await expect(second).resolves.toBe("two:again");
		});

		it("is dropped when dispatched from a view, with nothing subscribed by the mark's read", async () => {
			const h = build();
			await createRoot(async (dispose) => {
				const results: unknown[] = [];
				let runs = 0;
				createEffect(() => {
					runs++;
					results.push(h.runtime.dispatch(save, "a", "one"), h.runtime.dispatch(save, "a", "two"));
				});
				await settle();
				expect(runs).toBe(1);
				expect(h.a().Runs).toBe(1);
				await expect(results[1]).resolves.toBeUndefined();
				h.releases[0]("done");
				await expect(results[0]).resolves.toBe("one:done");
				await settle();
				expect(runs).toBe(1);
				dispose();
			});
		});

		it("has the mark at arrival, ahead of the dispatch's return", () => {
			const h = build();
			void h.runtime.dispatch(save, "a", "one");
			expect(inFlightOf(h.runtime, save, h.a())).toBe(true);
			expect(h.a().Runs).toBe(1);
		});

		it("is dropped from two starts in a row, and from a dispatch behind a start", async () => {
			const h = build();
			await h.onA(function* (draft) {
				yield* start(save, draft.$Id, "one");
				yield* start(save, draft, "two");
			});
			expect(h.a().Runs).toBe(1);
			await expect(h.runtime.dispatch(save, "a", "three")).resolves.toBeUndefined();
			h.releases[0]("done");
			await settle();
			expect(h.a().Saved).toBe("one");
		});

		it("runs under yield* as part of its caller, which has no arrival to read the mark at", async () => {
			const h = build();
			const own = h.onA(function* (draft) {
				return yield* save(draft, "own");
			});
			const ancestor = h.run(function* (draft) {
				return yield* save(draft.Docs[0], "ancestor");
			});
			expect(h.a().Runs).toBe(2);
			expect(inFlightOf(h.runtime, save, h.a())).toBe(false);
			h.releases[0]("one");
			h.releases[1]("two");
			await expect(own).resolves.toBe("own:one");
			await expect(ancestor).resolves.toBe("ancestor:two");
		});

		it("writes nothing, resolves undefined, and ends dropped in the records", async () => {
			const h = build();
			const first = h.runtime.dispatch(save, "a", "one");
			const before = h.records.length;
			await expect(h.runtime.dispatch(save, "a", "two")).resolves.toBeUndefined();
			const dropped = h.records.slice(before);
			expect(dropped.map((record) => record.Kind)).toEqual([
				"action:start",
				"action:end"
			]);
			expect(dropped[0].Kind === "action:start" && dropped[0].Label).toBe("saveDoc");
			expect(dropped[1].Kind === "action:end" && dropped[1].Status).toBe("dropped");
			h.releases[0]("done");
			await first;
			expect(h.errors).toEqual([]);
		});
	});

	describe(`leading ${build_}: what the mark is keyed by`, () => {
		const publishIt = leading(function* publishIt(draft: IDoc): IActionGenerator<string> {
			draft.Runs++;
			return yield* park();
		});

		it("does not let two leading actions on one entity block each other", async () => {
			const h = build();
			const saving = h.runtime.dispatch(save, "a", "one");
			const publishing = h.runtime.dispatch(publishIt, "a");
			expect(h.a().Runs).toBe(1);
			h.releases[0]("saved");
			await settle();
			expect(h.a().Runs).toBe(2);
			h.releases[1]("published");
			await expect(saving).resolves.toBe("one:saved");
			await expect(publishing).resolves.toBe("published");
		});

		it("does not let the same action on two entities block itself", async () => {
			const h = build();
			const onA = h.runtime.dispatch(save, "a", "one");
			const onB = h.runtime.dispatch(save, "b", "two");
			expect(h.a().Runs).toBe(1);
			expect(h.b().Runs).toBe(1);
			h.releases[0]("a");
			h.releases[1]("b");
			await expect(onA).resolves.toBe("one:a");
			await expect(onB).resolves.toBe("two:b");
		});

		it("does not let two functions with one name collide, as from two modules or a minifier, and each reads as that name", async () => {
			const h = build();
			const named = () =>
				leading(
					Object.defineProperty(
						function* (draft: IDoc): IActionGenerator<string> {
							draft.Runs++;
							return yield* park();
						},
						"name",
						{
							value: "a"
						}
					)
				);
			const one = named();
			const two = named();
			expect(one.name).toBe("a");
			expect(two.name).toBe("a");
			const first = h.runtime.dispatch(one, "a");
			const second = h.runtime.dispatch(two, "a");
			await expect(h.runtime.dispatch(two, "a")).resolves.toBeUndefined();
			await expect(h.runtime.dispatch(one, "a")).resolves.toBeUndefined();
			h.releases[0]("x");
			await settle();
			expect(h.a().Runs).toBe(2);
			h.releases[1]("y");
			await expect(first).resolves.toBe("x");
			await expect(second).resolves.toBe("y");
		});

		it("gives each anonymous function a mark of its own, and it reads as anonymous", async () => {
			const h = build();
			const left = leading(function* (draft: IDoc): IActionGenerator<string> {
				draft.Runs++;
				return yield* park();
			});
			const right = leading(function* (draft: IDoc): IActionGenerator<string> {
				draft.Runs++;
				return yield* park();
			});
			expect(left.name).toBe("");
			const first = h.runtime.dispatch(left, "a");
			const second = h.runtime.dispatch(right, "a");
			await expect(h.runtime.dispatch(right, "a")).resolves.toBeUndefined();
			await expect(h.runtime.dispatch(left, "a")).resolves.toBeUndefined();
			h.releases[0]("x");
			await settle();
			expect(h.a().Runs).toBe(2);
			h.releases[1]("y");
			await first;
			await second;
			const start = h.records.find((record) => record.Kind === "action:start");
			expect(start?.Kind === "action:start" && start.Label).toBeNull();
		});

		it("does not share a mark between two runtimes", async () => {
			const one = build();
			const two = build();
			const first = one.runtime.dispatch(save, "a", "one");
			const second = two.runtime.dispatch(save, "a", "two");
			expect(inFlightOf(one.runtime, save, one.a())).toBe(true);
			expect(inFlightOf(two.runtime, save, two.a())).toBe(true);
			one.releases[0]("x");
			await first;
			expect(inFlightOf(one.runtime, save, one.a())).toBe(false);
			expect(inFlightOf(two.runtime, save, two.a())).toBe(true);
			two.releases[0]("y");
			await expect(second).resolves.toBe("two:y");
		});
	});

	describe(`leading ${build_}: release`, () => {
		it("releases when the body throws, with the throw reaching the caller", async () => {
			const h = build();
			const first = h.runtime.dispatch(save, "a", "one");
			h.fails[0](new Error("refused"));
			await expect(first).rejects.toThrow("refused");
			expect(inFlightOf(h.runtime, save, h.a())).toBe(false);
			expect(h.errors).toHaveLength(1);
			void h.runtime.dispatch(save, "a", "two");
			expect(h.a().Runs).toBe(2);
		});

		it("does not throw or warn when the owner is removed mid-run, and a re-add starts clear", async () => {
			const h = build();
			const warn = vi.spyOn(console, "warn");
			const first = h.runtime.dispatch(save, "a", "one");
			await h.run(removeA);
			await expect(first).resolves.toBeUndefined();
			expect(h.errors).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
			await h.run(addA);
			expect(inFlightOf(h.runtime, save, h.a())).toBe(false);
			void h.runtime.dispatch(save, "a", "two");
			expect(h.a().Runs).toBe(1);
		});

		it("follows the owner through a move, and releases there", async () => {
			const h = build();
			const first = h.runtime.dispatch(save, "a", "one");
			await h.run(function* (draft) {
				const [node] = draft.Docs.splice(0, 1);
				draft.Other.push(node);
			});
			const moved = () => h.runtime.state.Other[0];
			expect(inFlightOf(h.runtime, save, moved())).toBe(true);
			await expect(h.runtime.dispatch(save, "a", "two")).resolves.toBeUndefined();
			h.releases[0]("done");
			await expect(first).resolves.toBe("one:done");
			expect(inFlightOf(h.runtime, save, moved())).toBe(false);
		});
	});

	describe(`leading ${build_}: a receiver's messages`, () => {
		it("handles a resource delivery at a case it shares with a button, after the button's run, not dropped", async () => {
			const h = build();
			const reload = leading(function* reloadDoc(draft: IDoc, _message?: IResourceDeliveryOf<"Leading/Feed">): IActionGenerator {
				draft.Runs++;
				yield* park();
			});
			const Feed = receiver<IDoc>("LeadingReloadReceiver")({
				"Leading/Feed": reload
			});
			h.runtime.registerReceiver(Feed);
			let feed!: IResourceContext<"leading/feed">;
			h.runtime.registerResourceType("leading/feed", (_params, r) => {
				feed = r;
			});
			await h.onA(function* (draft) {
				yield* openResource(draft, "Leading/Feed", Feed, {
					Type: "leading/feed"
				});
			});
			await settle();
			const pressed = h.runtime.dispatch(reload, "a");
			void feed.emit({
				N: 1
			});
			await settle();
			expect(h.a().Runs).toBe(1);
			h.releases[0]("button");
			await pressed;
			await settle();
			expect(h.a().Runs).toBe(2);
			h.releases[1]("delivery");
			await settle();
			const delivery = h.records.find((r) => r.Kind === "action:start" && r.Origin?.Kind === "resource:deliver");
			const deliveryId = delivery?.Kind === "action:start" ? delivery.ActionId : null;
			expect(h.records.find((r) => r.Kind === "action:end" && r.ActionId === deliveryId)).toMatchObject({
				Status: "completed"
			});
			h.runtime.dispose();
		});

		it("handles every published message at a case it shares with a leading button action", async () => {
			const h = build();
			const reload = leading(function* reloadDoc(draft: IDoc, _event?: unknown): IActionGenerator {
				draft.Runs++;
				yield* park();
			});
			const Pings = receiver<IDoc>("LeadingPingReceiver")({
				"Leading/Ping": reload
			});
			h.runtime.registerReceiver(Pings);
			await h.onA(function* (draft) {
				bind(draft, Pings);
			});
			const ping = () =>
				h.runtime.dispatch(function* pings(_draft: IDoc): IActionGenerator {
					yield* publish("Leading/Ping");
				}, "b");
			const pressed = h.runtime.dispatch(reload, "a");
			await ping();
			await ping();
			await settle();
			expect(h.a().Runs).toBe(1);
			for (let at = 0; at < 3; at++) {
				h.releases[at]!(`run ${at}`);
				await settle();
			}
			await pressed;
			expect(h.a().Runs).toBe(3);
			expect(h.releases).toHaveLength(3);
		});
	});

	describe(`leading ${build_}: restart`, () => {
		it("starts clear after a restore, with no receiver and nothing in the snapshot", async () => {
			const a = build();
			void a.runtime.dispatch(save, "a", "one");
			expect(inFlightOf(a.runtime, save, a.a())).toBe(true);
			const saved = createSnapshot(a.runtime);
			expect(saved).not.toContain("Leading");
			a.runtime.dispose();

			const b = await restoreBuilt(saved);
			expect(inFlightOf(b.runtime, save, b.a())).toBe(false);
			const again = b.runtime.dispatch(save, "a", "two");
			expect(inFlightOf(b.runtime, save, b.a())).toBe(true);
			b.releases[0]("done");
			await expect(again).resolves.toBe("two:done");
			expect(inFlightOf(b.runtime, save, b.a())).toBe(false);
		});
	});

	describe(`leading ${build_}: the action it stays`, () => {
		it("passes arguments through as an action gets them, and keeps the name in the records", async () => {
			const h = build();
			const passing = leading(function* passingOn(
				_draft: IDoc,
				one: number,
				two: {
					Text: string;
				}
			): IActionGenerator<string> {
				return `${one}/${two.Text}/${Object.isFrozen(two)}`;
			});
			await expect(
				h.runtime.dispatch(passing, "a", 1, {
					Text: "two"
				})
			).resolves.toBe("1/two/true");
			const start = h.records.find((record) => record.Kind === "action:start");
			expect(start?.Kind === "action:start" && start.Label).toBe("passingOn");
			expect(passing.name).toBe("passingOn");
		});

		it("is the function it was given, typed as that function", () => {
			function* given(_draft: IDoc, _title: string): IActionGenerator<string> {
				return "";
			}
			const marked = leading(given);
			expect(marked).toBe(given);
			expectTypeOf(marked).toEqualTypeOf<typeof given>();
			expectTypeOf(save).returns.toEqualTypeOf<IActionGenerator<string>>();
			const h = build();
			expectTypeOf(h.runtime.dispatch(save, "a", "one")).resolves.toEqualTypeOf<string | undefined>();
			// @ts-expect-error a title is a string.
			void h.runtime.dispatch(save, "b", 1).catch(() => {});
			// @ts-expect-error the draft is an entity.
			void (() => leading(function* notOnEntity(_draft: { Runs: number }): IActionGenerator {}));
		});

		it("marks a declaration from a statement after it, and its records carry the declaration's name", async () => {
			const h = build();
			function* saveTitle(draft: IDoc): IActionGenerator<string> {
				draft.Runs++;
				return yield* park();
			}
			leading(saveTitle);
			const first = h.runtime.dispatch(saveTitle, "a");
			await expect(h.runtime.dispatch(saveTitle, "a")).resolves.toBeUndefined();
			h.releases[0]("done");
			await expect(first).resolves.toBe("done");
			expect(h.a().Runs).toBe(1);
			const names = h.records
				.filter((record) => record.Kind === "action:start")
				.map((record) => record.Kind === "action:start" && record.Label);
			expect(names).toEqual([
				"saveTitle",
				"saveTitle"
			]);
		});

		it("reads the mark on a start the function makes of itself, by its own name", async () => {
			const h = build();
			let runs = 0;
			function* refresh(draft: IDoc): IActionGenerator {
				draft.Runs++;
				if (runs++ === 0) {
					yield* start(refresh, draft);
					yield* start(refresh, draft);
				}
				yield* park();
			}
			leading(refresh);
			const first = h.runtime.dispatch(refresh, "a");
			await settle();
			h.releases[0]();
			await first;
			await settle();
			expect(h.a().Runs).toBe(1);
			expect(h.releases).toHaveLength(1);
			expect(
				h.records.filter((record) => record.Kind === "action:end").map((record) => record.Kind === "action:end" && record.Status)
			).toEqual([
				"dropped",
				"dropped",
				"completed"
			]);
		});

		it("throws on a second mark, the same policy or the other", () => {
			function* once(_draft: IDoc): IActionGenerator {}
			leading(once);
			expect(() => leading(once)).toThrow('action "once" is already marked leading');
			expect(() => latest(once)).toThrow('action "once" is already marked leading');
		});
	});

	describe(`leading ${build_}: reading it`, () => {
		it("reacts in a view: up on the run and back down, a throw included", async () => {
			const h = build();
			await createRoot(async (dispose) => {
				const seen: boolean[] = [];
				const saving = createMemo(() => inFlightOf(h.runtime, save, h.a()));
				createEffect(() => {
					seen.push(saving());
				});
				await settle();
				const first = h.runtime.dispatch(save, "a", "one");
				await settle();
				h.releases[0]("done");
				await first;
				await settle();
				const second = h.runtime.dispatch(save, "a", "two");
				await settle();
				h.fails[1](new Error("refused"));
				await second.catch(() => {});
				await settle();
				expect(seen).toEqual([
					false,
					true,
					false,
					true,
					false
				]);
				dispose();
			});
		});

		it("reads through a selector and a draft, and an owner that has gone reads clear", async () => {
			const h = build();
			function* saving(draft: IDoc): ISelectorGenerator<boolean> {
				return yield* inFlight(save, draft);
			}
			const read = () => h.runtime.runSelector(saving, h.a);
			expect(read()).toBe(false);
			const first = h.runtime.dispatch(save, "a", "one");
			expect(inFlightOf(h.runtime, save, h.a())).toBe(true);
			await settle();
			expect(read()).toBe(true);
			await expect(
				h.run(function* (draft) {
					return [
						yield* inFlight(save, draft.Docs[0]),
						yield* select(saving, (world: IWorld) => world.Docs[0])
					];
				})
			).resolves.toEqual([
				true,
				true
			]);
			const held = h.a();
			await h.run(removeA);
			await first;
			expect(inFlightOf(h.runtime, save, held)).toBe(false);
		});
	});

	describe(`leading ${build_}: what has no slot`, () => {
		it("cannot be dispatched to a root with no $Id, as no action can", async () => {
			const runtime = createRuntime<{
				Docs: IDoc[];
			}>(
				{
					Docs: []
				},
				{
					onError: () => {}
				}
			);
			await expect(runtime.dispatch(save, "", "one")).rejects.toThrow("a state root with no $Id");
		});

		it("refuses a read from a value snapshot, a plain object that reaches no runtime", () => {
			const h = build();
			expect(() =>
				inFlightOf(h.runtime, save, {
					$Id: "a"
				})
			).toThrow("the owner is a plain object. A value snapshot or a React view reaches no runtime");
		});
	});
}
