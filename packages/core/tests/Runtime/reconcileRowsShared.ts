import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import type { IEntity, IEntityId } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ask } from "../../src/Effects/ask";
import { defineEffect } from "../../src/Effects/defineEffect";
import { entity, idOf } from "../../src/Effects/entity";
import { generateGuid } from "../../src/Effects/generateGuid";
import { publish } from "../../src/Effects/publish";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { start } from "../../src/Effects/start";
import { getData } from "../../src/Reads/getData";
import { select } from "../../src/Reads/select";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { DraftDetachedError, EntityReplacedError } from "../../src/Runtime/draftNode";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { ReconcileRowsKeyError, ReconcileRowsWaitError, reconcileRows } from "../../src/Runtime/reconcileRows";
import { transient } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createTestRuntime, guids } from "../../src/Testing/createTestRuntime";
import { captureSurfaced, mountComponent } from "../testHelpers";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"ReconcileRows/Ping": {};
	}
}

declare module "../../src/Registries/IDataSourceRegistry" {
	interface IDataSourceRegistry {
		"ReconcileRows/Own": IRow;
	}
}

interface ISub extends IEntity {
	Id: string;
	Value: string;
	Saved?: string;
	Heard?: number;
	Expanded?: boolean;
}

interface IRow extends IEntity {
	Id: string;
	Value: string;
	Subs: ISub[];
	Saved?: string;
	Heard?: number;
	Expanded?: boolean;
}

interface IDoc extends IEntity {
	Title: string;
	Rows: IRow[];
	Plain: IPlain[];
	SelectedId?: IEntityId;
	Seen?: unknown;
}

interface IPlain {
	Id: string | number;
	Value: string;
	Note?: string;
}

interface ISubInfo {
	Id: string;
	Value: string;
}

interface IRowInfo {
	Id: string;
	Value: string;
	Subs: ISubInfo[];
}

interface IDocInfo {
	Title: string;
	Rows: IRowInfo[];
}

type IRowFields = Omit<IRow, "$Id">;

const now = defineEffect<
	{
		Type: "reconcileRows/now";
	},
	number
>("reconcileRows/now", {
	settles: "sync"
});

function* hold(): IActionGenerator<string> {
	return yield {
		Type: "hold"
	};
}

function* save(
	draft: {
		Saved?: string;
	},
	value: string
): IActionGenerator<string> {
	const answer = yield* hold();
	draft.Saved = `${value}:${answer}`;
	return draft.Saved;
}

const Listener = receiver<
	{
		Heard?: number;
	} & IEntity
>("ReconcileRows/Listener")({
	"ReconcileRows/Ping": function* (draft) {
		draft.Heard = (draft.Heard ?? 0) + 1;
	}
});

function* listen(
	draft: {
		Heard?: number;
	} & IEntity
): IActionGenerator {
	bind(draft, Listener);
}

function* ping(_draft: IDoc): IActionGenerator {
	yield* publish("ReconcileRows/Ping");
}

function* newRow(info: IRowInfo) {
	return yield* entity({
		Id: info.Id,
		Value: "",
		Subs: [] as ISub[]
	});
}

function* assignRow(draft: IRow, info: IRowInfo): IActionGenerator {
	draft.Value = info.Value;
	yield* reconcileRows(draft.Subs, info.Subs, (sub) => sub.Id, {
		update(sub, item) {
			sub.Value = item.Value;
		}
	});
}

function* assign(draft: IDoc, info: IDocInfo): IActionGenerator {
	draft.Title = info.Title;
	yield* reconcileRows(draft.Rows, info.Rows, (row) => row.Id, {
		add: newRow,
		update: assignRow
	});
}

function info(
	title: string,
	...rows: [
		string,
		...string[]
	][]
): IDocInfo {
	return {
		Title: title,
		Rows: rows.map(([id, ...subs]) => ({
			Id: id,
			Value: `${title}/${id}`,
			Subs: subs.map((sub) => ({
				Id: sub,
				Value: `${title}/${sub}`
			}))
		}))
	};
}

function emptyDoc(): IDoc {
	return {
		$Id: "doc",
		Title: "",
		Rows: [],
		Plain: []
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function build(seed: IDoc = emptyDoc()) {
	const errors: unknown[] = [];
	const holds: ((answer: string) => void)[] = [];
	let time = 0;
	const runtime = createTestRuntime<IDoc>(
		seed,
		{
			generateGuid: guids("m"),
			"reconcileRows/now": () => ++time,
			hold: () =>
				new Promise((resolve) => {
					holds.push(resolve);
				})
		},
		{
			onError: (error) => errors.push(error)
		}
	) as IRuntimeInternal<IDoc>;
	runtime.registerReceiver(Listener);
	const records: IRecord[] = [];
	runtime.on("record", (record) => {
		records.push(record);
	});
	const row = (id: string) => runtime.state.Rows.find((r) => r.Id === id) as IRow;
	const sub = (rowId: string, id: string) => row(rowId).Subs.find((s) => s.Id === id) as ISub;
	const minted = () => records.filter((record) => record.Kind === "effect" && record.Type === "generateGuid").length;
	const run = <R>(action: IAction<IDoc, [], R>): Promise<R | undefined> => runtime.dispatch(action, "doc");
	return {
		runtime,
		errors,
		holds,
		records,
		row,
		sub,
		minted,
		run
	};
}

export function reconcileRowsRules(build_: string): void {
	describe(`entity ${build_}`, () => {
		it("returns a copy carrying a new $Id, and leaves what it was given alone", async () => {
			const h = build();
			const given = Object.freeze({
				Name: "x"
			});
			const made = await h.run(function* () {
				return yield* entity(given);
			});
			expect(made).toEqual({
				$Id: "~m-1",
				Name: "x"
			});
			expect(Object.keys(given)).toEqual([
				"Name"
			]);
		});

		it("can be edited until it's written, and is frozen after, as anything written is", async () => {
			const h = build();
			const outcome = await h.run(function* (draft) {
				const made = yield* entity({
					Id: "a",
					Value: "",
					Subs: [] as ISub[]
				});
				made.Value = "edited";
				draft.Rows.push(made);
				return Object.isFrozen(made);
			});
			expect(outcome).toBe(true);
			expect(h.row("a").Value).toBe("edited");
		});

		it("gives entity({ ...row }) a new id, and a spread with no entity() keeps the old one", async () => {
			const h = build({
				...emptyDoc(),
				Rows: [
					{
						$Id: "old",
						Id: "a",
						Value: "v",
						Subs: []
					}
				]
			});
			const ids = await h.run(function* (draft) {
				const copy = yield* entity({
					...draft.Rows[0]
				});
				const fromNode = yield* entity(draft.Rows[0]);
				return [
					copy.$Id,
					fromNode.$Id,
					{
						...draft.Rows[0],
						Value: "w"
					}.$Id
				];
			});
			expect(ids).toEqual([
				"~m-1",
				"~m-2",
				"old"
			]);
		});

		it("keeps a nested entity's id, so an inner mint stays that entity once the outer one lands", async () => {
			const h = build();
			const subId = await h.run(function* (draft) {
				const inner = yield* entity({
					Id: "s",
					Value: "v"
				});
				const outer = yield* entity({
					Id: "a",
					Value: "v",
					Subs: [
						inner
					]
				});
				draft.Rows.push(outer);
				return inner.$Id;
			});
			expect(h.sub("a", "s").$Id).toBe(subId);
			expect(h.row("a").$Id).not.toBe(subId);
		});

		it("carries a nested live $Id through a copy, and writing that is refused for naming a live node", async () => {
			const h = build({
				...emptyDoc(),
				Rows: [
					{
						$Id: "a",
						Id: "a",
						Value: "v",
						Subs: [
							{
								$Id: "s",
								Id: "s",
								Value: "v"
							}
						]
					}
				]
			});
			await expect(
				h.run(function* (draft) {
					draft.Rows.push(
						yield* entity({
							...draft.Rows[0],
							Id: "b"
						})
					);
				})
			).rejects.toBeInstanceOf(EntityReplacedError);
			expect(h.runtime.state.Rows).toHaveLength(1);
		});

		it("refuses what state can't hold, before minting", async () => {
			const h = build();
			class Money {
				cents = 5;
			}
			await expect(
				h.run(function* () {
					yield* entity(new Money());
				})
			).rejects.toBeInstanceOf(NonPlainDataError);
			await expect(
				h.run(function* () {
					yield* entity({
						When: new Date(0)
					});
				})
			).rejects.toBeInstanceOf(NonPlainDataError);
			await expect(
				h.run(function* () {
					yield* entity([]);
				})
			).rejects.toBeInstanceOf(TypeError);
			await expect(
				h.run(function* () {
					yield* entity(null as unknown as object);
				})
			).rejects.toBeInstanceOf(TypeError);
			expect(h.minted()).toBe(0);
		});

		it("ends the step, so a write ahead of it reaches a view before the next one", async () => {
			const h = build();
			const seen: string[] = [];
			const dispose = createRoot((disposer) => {
				createEffect(() => {
					seen.push(h.runtime.state.Title);
				});
				return disposer;
			});
			await h.run(function* (draft) {
				draft.Title = "one";
				yield* entity({
					Name: "x"
				});
				draft.Title = "two";
			});
			dispose();
			expect(seen).toEqual([
				"",
				"one",
				"two"
			]);
		});

		it("is recorded, and answered by a stub", async () => {
			const h = build();
			const id = await h.run(function* () {
				return (yield* entity({
					Name: "x"
				})).$Id;
			});
			expect(id).toBe("~m-1");
			expect(h.minted()).toBe(1);
		});

		it("fails when a test stubbed no generateGuid", async () => {
			const runtime = createTestRuntime<IDoc>(
				emptyDoc(),
				{},
				{
					onError: () => {}
				}
			);
			await expect(
				runtime.dispatch(function* () {
					yield* entity({
						Name: "x"
					});
				}, "doc")
			).rejects.toThrow(/generateGuid/);
		});
	});

	describe(`a minted entity as an address ${build_}`, () => {
		function* mintAndWrite(draft: IDoc) {
			const made = yield* entity({
				Id: "a",
				Value: "v",
				Subs: [] as ISub[]
			});
			draft.Rows.push(made);
			return made;
		}

		function* mark(draft: IRow, value: string): IActionGenerator {
			draft.Value = value;
		}

		it("gives idOf a field value that refers to the row", async () => {
			const h = build();
			await h.run(function* (draft) {
				const made = yield* mintAndWrite(draft);
				draft.SelectedId = idOf(made);
			});
			expect(h.runtime.state.SelectedId).toBe(h.row("a").$Id);
		});

		it("gives idOf the same answer from a value, a draft node and a view", async () => {
			const h = build();
			const ids = await h.run(function* (draft) {
				const made = yield* mintAndWrite(draft);
				return [
					idOf(made),
					idOf(draft.Rows[0])
				];
			});
			expect(ids).toEqual([
				idOf(h.row("a")),
				idOf(h.row("a"))
			]);
		});

		it("refuses idOf on something with no $Id, and on an empty one", () => {
			expect(() => idOf({} as IEntity)).toThrow(TypeError);
			expect(() =>
				idOf({
					$Id: ""
				})
			).toThrow(TypeError);
		});

		it("is taken by start as the value entity() returned", async () => {
			const h = build();
			await h.run(function* (draft) {
				const made = yield* mintAndWrite(draft);
				yield* start(mark, made, "started");
			});
			await settle();
			expect(h.row("a").Value).toBe("started");
		});

		it("is taken by ask in the step it was written, and the ask ends with the row", async () => {
			const h = build();
			const asked = h.run(function* (draft) {
				const made = yield* mintAndWrite(draft);
				return (
					(yield* open(
						ask<string>(made, {
							Path: "Made"
						})
					)) ?? "ended"
				);
			});
			await settle();
			await h.run(function* (draft) {
				draft.Rows.length = 0;
			});
			await expect(asked).resolves.toBe("ended");
		});

		it("is bound through the row the tree holds, in the step it was written", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* mintAndWrite(draft);
				bind(draft.Rows[0], Listener);
			});
			await h.run(ping);
			await settle();
			expect(h.row("a").Heard).toBe(1);
		});

		it("is taken by registerDataSource and getData in the step it was written", async () => {
			const h = build();
			const found = await h.run(function* (draft) {
				const made = yield* mintAndWrite(draft);
				yield* registerDataSource(made, "ReconcileRows/Own", made);
				return (yield* getData(made, "ReconcileRows/Own"))?.Id;
			});
			expect(found).toBe("a");
		});

		it("is taken by dispatch as a returned value's $Id, a view and its idOf", async () => {
			const h = build();
			const made = (await h.run(mintAndWrite))!;
			await h.runtime.dispatch(mark, made.$Id, "value");
			expect(h.row("a").Value).toBe("value");
			await h.runtime.dispatch(mark, h.row("a"), "view");
			expect(h.row("a").Value).toBe("view");
			await h.runtime.dispatch(mark, idOf(made), "id");
			expect(h.row("a").Value).toBe("id");
		});

		it("rejects a dispatch to an entity that isn't in the tree, naming its id", async () => {
			const h = build();
			await expect(
				h.runtime.dispatch(
					mark,
					{
						$Id: "gone"
					},
					"no"
				)
			).rejects.toThrow(/no entity "gone"/);
			await expect(h.runtime.dispatch(mark, null as unknown as string, "no")).rejects.toThrow(TypeError);
		});

		it("reaches a transient only as a node, which the transient's yield lands", async () => {
			const counter = (owner: IEntity) =>
				transient(owner, "ReconcileRows/Counter", {
					Marks: 0
				});
			const h = build();
			const outcome = await h.run(function* (draft): IActionGenerator<number> {
				const made = yield* mintAndWrite(draft);
				let refusal: unknown;
				try {
					yield* counter(made);
				} catch (error) {
					refusal = error;
				}
				expect(String(refusal)).toMatch(/has to be a draft/);
				return (yield* counter(draft.Rows[0])).Marks;
			});
			expect(outcome).toBe(0);
		});
	});

	describe(`reconcileRows ${build_}: the refresh the notes measured`, () => {
		async function loaded() {
			const h = build();
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info(
						"one",
						[
							"a",
							"a1",
							"a2"
						],
						[
							"b",
							"b1"
						],
						[
							"c",
							"c1"
						]
					)
				);
			});
			return h;
		}

		it("fills an empty collection on its first refresh, minting at both levels", async () => {
			const h = await loaded();
			expect(h.runtime.state.Rows.map((r) => r.Id)).toEqual([
				"a",
				"b",
				"c"
			]);
			expect(h.row("a").Value).toBe("one/a");
			expect(h.sub("a", "a2").Value).toBe("one/a2");
			const ids = h.runtime.state.Rows.flatMap((r) => [
				r.$Id,
				...r.Subs.map((s) => s.$Id)
			]);
			expect(new Set(ids).size).toBe(7);
			expect(h.minted()).toBe(7);
		});

		it("makes a first load's nested rows entities, so they take work in the same way as any other", async () => {
			const h = await loaded();
			const subId = h.sub("a", "a1").$Id;
			await h.runtime.dispatch(listen, subId);
			await h.run(ping);
			await settle();
			expect(h.sub("a", "a1").Heard).toBe(1);
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info("two", [
						"a",
						"a1"
					])
				);
			});
			expect(h.sub("a", "a1").$Id).toBe(subId);
			expect(h.sub("a", "a1").Value).toBe("two/a1");
		});

		it("fills a new row and refreshes a kept one through the same update", async () => {
			const h = build();
			const filled = await h.run(function* (draft) {
				const rows: string[] = [];
				yield* assign(
					draft,
					info("one", [
						"a"
					])
				);
				yield* reconcileRows(
					draft.Rows,
					[
						{
							Id: "b",
							Value: "new",
							Subs: [] as ISub[]
						},
						{
							Id: "a",
							Value: "kept",
							Subs: [] as ISub[]
						}
					],
					(row) => row.Id,
					{
						update(row, item) {
							rows.push(row.Id);
							row.Value = item.Value;
						}
					}
				);
				return rows;
			});
			expect(filled).toEqual([
				"b",
				"a"
			]);
			expect(h.row("b").Value).toBe("new");
			expect(h.row("a").Value).toBe("kept");
		});

		it("gives each update its own row's item when an earlier update splices the list", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info(
						"one",
						[
							"a"
						],
						[
							"b"
						],
						[
							"c"
						]
					)
				);
				yield* reconcileRows(
					draft.Rows,
					[
						{
							Id: "a",
							Value: "for a",
							Subs: [] as ISub[]
						},
						{
							Id: "b",
							Value: "for b",
							Subs: [] as ISub[]
						},
						{
							Id: "c",
							Value: "for c",
							Subs: [] as ISub[]
						}
					],
					(row) => row.Id,
					{
						update(row, item) {
							row.Value = item.Value;
							if (row.Id === "a") {
								draft.Rows.shift();
							}
						}
					}
				);
			});
			expect(
				h.runtime.state.Rows.map((r) => [
					r.Id,
					r.Value
				])
			).toEqual([
				[
					"b",
					"for b"
				],
				[
					"c",
					"for c"
				]
			]);
		});

		it("keeps work and bindings on the right rows through reorders at two levels, and ends a removed row's", async () => {
			const h = await loaded();
			const before = {
				a: h.row("a").$Id,
				a1: h.sub("a", "a1").$Id,
				a2: h.sub("a", "a2").$Id,
				b: h.row("b").$Id,
				c: h.row("c").$Id
			};
			await h.runtime.dispatch(listen, before.a);
			await h.runtime.dispatch(listen, before.a1);
			await h.runtime.dispatch(listen, before.c);
			const saves = {
				a: h.runtime.dispatch(save, before.a, "row-a"),
				a2: h.runtime.dispatch(save, before.a2, "sub-a2"),
				b: h.runtime.dispatch(save, before.b, "row-b"),
				c: h.runtime.dispatch(save, before.c, "row-c")
			};
			await settle();
			const [holdA, holdA2, holdB, holdC] = h.holds;

			await h.run(function* (draft) {
				draft.Rows[0].Expanded = true;
				yield* assign(
					draft,
					info(
						"two",
						[
							"d",
							"d1"
						],
						[
							"c",
							"c1"
						],
						[
							"a",
							"a2",
							"a3",
							"a1"
						]
					)
				);
			});

			expect(h.runtime.state.Title).toBe("two");
			expect(h.runtime.state.Rows.map((r) => r.Id)).toEqual([
				"d",
				"c",
				"a"
			]);
			expect(h.row("a").Subs.map((s) => s.Id)).toEqual([
				"a2",
				"a3",
				"a1"
			]);
			expect(h.row("a").$Id).toBe(before.a);
			expect(h.sub("a", "a1").$Id).toBe(before.a1);
			expect(h.sub("a", "a2").$Id).toBe(before.a2);
			expect(h.row("c").$Id).toBe(before.c);
			expect(h.row("a").Value).toBe("two/a");
			expect(h.sub("a", "a1").Value).toBe("two/a1");
			expect(h.row("a").Expanded).toBe(true);
			expect(Object.values(before)).not.toContain(h.row("d").$Id);
			expect(Object.values(before)).not.toContain(h.sub("a", "a3").$Id);
			expect(h.sub("a", "a3").$Id).not.toBe(h.sub("d", "d1").$Id);

			holdA("ok");
			holdA2("ok");
			holdB("ok");
			holdC("ok");
			await expect(saves.a).resolves.toBe("row-a:ok");
			await expect(saves.a2).resolves.toBe("sub-a2:ok");
			await expect(saves.c).resolves.toBe("row-c:ok");
			await expect(saves.b).resolves.toBeUndefined();
			expect(h.row("a").Saved).toBe("row-a:ok");
			expect(h.sub("a", "a2").Saved).toBe("sub-a2:ok");
			expect(h.row("c").Saved).toBe("row-c:ok");
			expect(h.row("d").Saved).toBeUndefined();

			await h.run(ping);
			await settle();
			expect(h.row("a").Heard).toBe(1);
			expect(h.sub("a", "a1").Heard).toBe(1);
			expect(h.row("c").Heard).toBe(1);
			expect(h.row("d").Heard).toBeUndefined();
			expect(h.errors).toEqual([]);
		});

		it("lands a save waiting on a on a, when the server swaps a and b and their values", async () => {
			const h = await loaded();
			const aId = h.row("a").$Id;
			const saving = h.runtime.dispatch(save, aId, "for-a");
			await settle();
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info(
						"two",
						[
							"b",
							"b1"
						],
						[
							"a",
							"a1",
							"a2"
						]
					)
				);
			});
			expect(h.runtime.state.Rows[1].$Id).toBe(aId);
			h.holds[0]("ok");
			await expect(saving).resolves.toBe("for-a:ok");
			expect(h.row("a").Saved).toBe("for-a:ok");
			expect(h.row("b").Saved).toBeUndefined();
			expect(h.row("a").Value).toBe("two/a");
			expect(h.row("b").Value).toBe("two/b");
		});

		it("shows a view the state before and the state after, with new rows at every depth and the writes around it", async () => {
			const h = await loaded();
			const seen: unknown[] = [];
			const dispose = createRoot((disposer) => {
				createEffect(() => {
					seen.push([
						h.runtime.state.Title,
						...h.runtime.state.Rows.map((r) => `${r.Id}(${r.Subs.map((s) => s.Id).join()})`)
					]);
				});
				return disposer;
			});
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info(
						"two",
						[
							"e",
							"e1",
							"e2"
						],
						[
							"c",
							"c9",
							"c1"
						],
						[
							"a",
							"a3"
						]
					)
				);
				draft.Seen = "after";
			});
			dispose();
			expect(seen).toEqual([
				[
					"one",
					"a(a1,a2)",
					"b(b1)",
					"c(c1)"
				],
				[
					"two",
					"e(e1,e2)",
					"c(c9,c1)",
					"a(a3)"
				]
			]);
			expect(h.minted()).toBe(7 + 5);
		});

		it("takes one step, recording each mint inside it", async () => {
			const h = await loaded();
			const from = h.records.length;
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info("two", [
						"e",
						"e1"
					])
				);
			});
			const fresh = h.records.slice(from);
			expect(fresh.filter((record) => record.Kind === "step")).toHaveLength(1);
			expect(
				fresh
					.filter((record) => record.Kind === "effect")
					.map(
						(record) =>
							(
								record as {
									Type: string;
								}
							).Type
					)
			).toEqual([
				"generateGuid",
				"generateGuid"
			]);
			expect(fresh.filter((record) => record.Kind === "response")).toHaveLength(2);
		});
	});

	describe(`reconcileRows ${build_}: rows`, () => {
		it("follows the server's order, returns the array it was given, and returns what it added as draft nodes", async () => {
			const h = build();
			const outcome = await h.run(function* (draft) {
				yield* assign(
					draft,
					info(
						"one",
						[
							"a"
						],
						[
							"b"
						]
					)
				);
				const rows = draft.Rows;
				const added = yield* reconcileRows(
					draft.Rows,
					[
						{
							Id: "c",
							Value: "new",
							Subs: []
						},
						{
							Id: "b",
							Value: "kept",
							Subs: []
						},
						{
							Id: "d",
							Value: "new",
							Subs: []
						}
					],
					(row) => row.Id,
					{
						update: () => {}
					}
				);
				for (const row of added) {
					row.Expanded = true;
				}
				return {
					same: rows === draft.Rows,
					added: added.map((row) => row.Id)
				};
			});
			expect(outcome).toEqual({
				same: true,
				added: [
					"c",
					"d"
				]
			});
			expect(
				h.runtime.state.Rows.map((r) => [
					r.Id,
					r.Expanded
				])
			).toEqual([
				[
					"c",
					true
				],
				[
					"b",
					undefined
				],
				[
					"d",
					true
				]
			]);
		});

		it("mints a row for an item with add omitted, whatever $Id the item carried", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* reconcileRows(
					draft.Rows,
					[
						{
							$Id: "from-server",
							Id: "a",
							Value: "v",
							Subs: []
						}
					],
					(row) => row.Id,
					{
						update: () => {}
					}
				);
			});
			expect(h.row("a").$Id).toBe("~m-1");
		});

		it("leaves a matched row's contents alone with an update that writes nothing", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info("one", [
						"a"
					])
				);
				yield* reconcileRows(
					draft.Rows,
					[
						{
							Id: "a",
							Value: "changed",
							Subs: []
						}
					],
					(row) => row.Id,
					{
						update: () => {}
					}
				);
			});
			expect(h.row("a").Value).toBe("one/a");
		});

		it("removes everything for an empty list", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info(
						"one",
						[
							"a"
						],
						[
							"b"
						]
					)
				);
				const added = yield* reconcileRows(draft.Rows, [] as IRowInfo[], (row) => row.Id, {
					add: newRow,
					update: () => {}
				});
				draft.Seen = added;
			});
			expect(h.runtime.state.Rows).toEqual([]);
			expect(h.runtime.state.Seen).toEqual([]);
		});

		it("matches 5 with '5'", async () => {
			const h = build({
				...emptyDoc(),
				Plain: [
					{
						Id: "5",
						Value: "old"
					}
				]
			});
			const added = await h.run(function* (draft) {
				return yield* reconcileRows(
					draft.Plain,
					[
						{
							Id: 5,
							Value: "new"
						}
					],
					(row) => row.Id,
					{
						add: (item) => item,
						update(row, item) {
							row.Value = item.Value;
						}
					}
				);
			});
			expect(added).toEqual([]);
			expect(h.runtime.state.Plain).toEqual([
				{
					Id: "5",
					Value: "new"
				}
			]);
		});

		it("keeps plain rows' nodes, so a held reference still writes to its row, and adds plain rows through add", async () => {
			const h = build({
				...emptyDoc(),
				Plain: [
					{
						Id: "a",
						Value: "1"
					},
					{
						Id: "b",
						Value: "2"
					}
				]
			});
			await h.run(function* (draft) {
				const a = draft.Plain[0];
				yield* reconcileRows(
					draft.Plain,
					[
						{
							Id: "c",
							Value: "3"
						},
						{
							Id: "b",
							Value: "2"
						},
						{
							Id: "a",
							Value: "1"
						}
					],
					(row) => row.Id,
					{
						add: (item) => item,
						update: () => {}
					}
				);
				yield* generateGuid();
				a.Note = "held";
			});
			expect(h.runtime.state.Plain).toEqual([
				{
					Id: "c",
					Value: "3"
				},
				{
					Id: "b",
					Value: "2"
				},
				{
					Id: "a",
					Value: "1",
					Note: "held"
				}
			]);
		});

		it("works on a transient's array, born by the refresh, and the rows it adds take work", async () => {
			const shelf = (owner: IEntity) =>
				transient(owner, "ReconcileRows/Shelf", {
					Rows: [] as ISub[]
				});
			const h = build();
			const items = [
				{
					Id: "a",
					Value: "1"
				},
				{
					Id: "b",
					Value: "2"
				}
			];
			const ids = (await h.run(function* (draft) {
				const added = yield* reconcileRows((yield* shelf(draft)).Rows, items, (row) => row.Id, {
					update: () => {}
				});
				return added.map((row) => idOf(row));
			}))!;
			await h.runtime.dispatch(listen, ids[0]);
			const saving = h.runtime.dispatch(save, ids[1], "kept");
			await settle();
			await h.run(function* (draft) {
				yield* reconcileRows(
					(yield* shelf(draft)).Rows,
					[
						items[1],
						items[0]
					],
					(row) => row.Id,
					{
						update: () => {}
					}
				);
			});
			h.holds[0]("ok");
			await expect(saving).resolves.toBe("kept:ok");
			await h.run(ping);
			await settle();
			const rows = await h.run(function* (draft) {
				return (yield* shelf(draft)).Rows.map((row) => [
					row.Id,
					row.Saved,
					row.Heard
				]);
			});
			expect(rows).toEqual([
				[
					"b",
					"kept:ok",
					undefined
				],
				[
					"a",
					undefined,
					1
				]
			]);
		});

		it("lets add and update run a sync effect", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info("one", [
						"a"
					])
				);
				yield* reconcileRows(
					draft.Rows,
					[
						{
							Id: "a",
							Value: "",
							Subs: []
						},
						{
							Id: "b",
							Value: "",
							Subs: []
						}
					],
					(row) => row.Id,
					{
						*add(item) {
							return yield* entity({
								...item,
								Value: `at ${yield* now()}`
							});
						},
						*update(row) {
							row.Value = `at ${yield* now()}`;
						}
					}
				);
			});
			expect(h.row("a").Value).toBe("at 2");
			expect(h.row("b").Value).toBe("at 3");
		});

		it("gives the key function live rows and incoming data alike", async () => {
			const h = build();
			const seen = await h.run(function* (draft) {
				yield* assign(
					draft,
					info("one", [
						"a"
					])
				);
				const sides: boolean[] = [];
				yield* reconcileRows(
					draft.Rows,
					[
						{
							Id: "a",
							Value: "",
							Subs: []
						}
					],
					(row) => {
						sides.push("$Id" in row);
						return row.Id;
					},
					{
						update: () => {}
					}
				);
				return sides;
			});
			expect(seen).toEqual([
				true,
				false
			]);
		});

		it("removes a current row with no key, as nothing can match it", async () => {
			const h = build({
				...emptyDoc(),
				Plain: [
					{
						Id: "",
						Value: "unsaved"
					},
					{
						Id: "a",
						Value: "saved"
					}
				]
			});
			await h.run(function* (draft) {
				yield* reconcileRows(
					draft.Plain,
					[
						{
							Id: "a",
							Value: "saved"
						}
					],
					(row) => row.Id,
					{
						add: (item) => item,
						update: () => {}
					}
				);
			});
			expect(h.runtime.state.Plain.map((r) => r.Value)).toEqual([
				"saved"
			]);
		});
	});

	describe(`reconcileRows ${build_}: refusals`, () => {
		async function twoRows() {
			const h = build();
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info(
						"one",
						[
							"a"
						],
						[
							"b"
						]
					)
				);
			});
			return h;
		}
		const order = (h: ReturnType<typeof build>) => h.runtime.state.Rows.map((r) => r.Id);
		const incoming = (...ids: (string | undefined)[]): IRowFields[] =>
			ids.map((id) => ({
				Id: id as string,
				Value: "new",
				Subs: []
			}));

		it("refuses the same key twice in the incoming list, before minting or moving", async () => {
			const h = await twoRows();
			const minted = h.minted();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("b", "z", "z"), (row) => row.Id, {
						update: () => {}
					});
				})
			).rejects.toBeInstanceOf(ReconcileRowsKeyError);
			expect(order(h)).toEqual([
				"a",
				"b"
			]);
			expect(h.minted()).toBe(minted);
		});

		it("refuses the same key twice in the current list, before minting or moving", async () => {
			const h = build({
				...emptyDoc(),
				Rows: [
					{
						$Id: "1",
						Id: "a",
						Value: "",
						Subs: []
					},
					{
						$Id: "2",
						Id: "a",
						Value: "",
						Subs: []
					}
				]
			});
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("z"), (row) => row.Id, {
						update: () => {}
					});
				})
			).rejects.toBeInstanceOf(ReconcileRowsKeyError);
			expect(h.runtime.state.Rows).toHaveLength(2);
			expect(h.minted()).toBe(0);
		});

		it("refuses an incoming row with no key, before minting or moving", async () => {
			const h = await twoRows();
			const minted = h.minted();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("b", undefined), (row) => row.Id, {
						update: () => {}
					});
				})
			).rejects.toThrow(/no key on the incoming row at \[1\]/);
			expect(order(h)).toEqual([
				"a",
				"b"
			]);
			expect(h.minted()).toBe(minted);
		});

		it("refuses a wait in add with the list untouched, and the writes ahead of the call landing as usual", async () => {
			const h = await twoRows();
			await expect(
				h.run(function* (draft) {
					draft.Title = "ahead";
					yield* reconcileRows(draft.Rows, incoming("b", "z"), (row) => row.Id, {
						*add(item) {
							yield* hold();
							return yield* entity({
								...item
							});
						},
						update: () => {}
					});
				})
			).rejects.toBeInstanceOf(ReconcileRowsWaitError);
			expect(order(h)).toEqual([
				"a",
				"b"
			]);
			expect(h.runtime.state.Title).toBe("ahead");
			expect(h.holds).toEqual([]);
		});

		it("refuses a wait in update with the list arranged and earlier updates landed", async () => {
			const h = await twoRows();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("b", "a"), (row) => row.Id, {
						*update(row) {
							if (row.Id === "a") {
								yield* hold();
							}
							row.Value = "updated";
						}
					});
				})
			).rejects.toThrow(/update yielded "hold"/);
			expect(order(h)).toEqual([
				"b",
				"a"
			]);
			expect(h.row("b").Value).toBe("updated");
			expect(h.row("a").Value).toBe("one/a");
			expect(h.holds).toEqual([]);
		});

		it("refuses the same wait through a nested reconcileRows", async () => {
			const h = await twoRows();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("a"), (row) => row.Id, {
						*update(row) {
							yield* reconcileRows(
								row.Subs,
								[
									{
										Id: "s",
										Value: ""
									}
								],
								(sub) => sub.Id,
								{
									*add(item) {
										yield* hold();
										return yield* entity({
											...item
										});
									},
									update: () => {}
								}
							);
						}
					});
				})
			).rejects.toBeInstanceOf(ReconcileRowsWaitError);
			expect(h.holds).toEqual([]);
		});

		it("refuses a read that needs the index in update", async () => {
			const h = await twoRows();
			function* titleOf(draft: IDoc) {
				return draft.Title;
			}
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("a"), (row) => row.Id, {
						*update(): IActionGenerator {
							yield* select(titleOf);
						}
					});
				})
			).rejects.toBeInstanceOf(ReconcileRowsWaitError);
		});

		it("refuses a transient's yield in add and in update, and a transient held from before takes writes there", async () => {
			const h = await twoRows();
			const marks = (owner: IEntity) =>
				transient(owner, "ReconcileRows/Marks", {
					Count: 0
				});
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("a", "new"), (row) => row.Id, {
						*add(item): IActionGenerator<IRow> {
							yield* marks(draft);
							return yield* entity({
								...item
							} as IRow);
						},
						update: () => {}
					});
				})
			).rejects.toThrow(/add yielded "transient"/);
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("a", "b"), (row) => row.Id, {
						*update(row): IActionGenerator {
							yield* marks(row);
						}
					});
				})
			).rejects.toBeInstanceOf(ReconcileRowsWaitError);
			const counted = await h.run(function* (draft) {
				const held = yield* marks(draft);
				yield* reconcileRows(draft.Rows, incoming("a", "b"), (row) => row.Id, {
					update() {
						held.Count++;
					}
				});
				return held.Count;
			});
			expect(counted).toBe(2);
		});

		it("refuses an async add and an async update", async () => {
			const h = await twoRows();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("z"), (row) => row.Id, {
						add: async (item: IRowFields) => item as unknown as IRow,
						update: () => {}
					} as never);
				})
			).rejects.toThrow(/add yielded an async result/);
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("a"), (row) => row.Id, {
						update: async () => {}
					});
				})
			).rejects.toThrow(/update yielded an async result/);
		});

		it("takes open(...) inside update, around the sync effects there", async () => {
			const h = await twoRows();
			await h.run(function* (draft) {
				yield* reconcileRows(draft.Rows, incoming("a"), (row) => row.Id, {
					*update(row) {
						row.Value = yield* open(
							(function* () {
								return `at ${yield* now()}`;
							})()
						);
					}
				});
			});
			expect(h.row("a").Value).toBe("at 1");
		});

		it("lets add or update catch the refusal and carry on, as any throw at a yield", async () => {
			const h = await twoRows();
			await h.run(function* (draft) {
				yield* reconcileRows(draft.Rows, incoming("a"), (row) => row.Id, {
					*update(row) {
						try {
							yield* hold();
						} catch {
							row.Value = "caught";
						}
					}
				});
			});
			expect(h.row("a").Value).toBe("caught");
		});

		it("refuses a new row carrying a live $Id, before anything moves", async () => {
			const h = await twoRows();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("z", "b"), (row) => row.Id, {
						add: () => ({
							...draft.Rows[0]
						}),
						update: () => {}
					});
				})
			).rejects.toBeInstanceOf(EntityReplacedError);
			expect(order(h)).toEqual([
				"a",
				"b"
			]);
		});

		it.each([
			[
				"undefined",
				undefined
			],
			[
				"null",
				null
			],
			[
				"a number",
				5
			],
			[
				"an array",
				[]
			]
		])("refuses add returning %s, before anything moves, with no row lost", async (_name, value) => {
			const h = build();
			await h.run(function* (draft) {
				yield* assign(
					draft,
					info(
						"one",
						[
							"a"
						],
						[
							"b"
						],
						[
							"c"
						]
					)
				);
			});
			const surfaced = captureSurfaced();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("c", "z", "a", "b"), (row) => row.Id, {
						add: () => value as unknown as IRow,
						update: () => {}
					});
				})
			).rejects.toThrow(/add has to return a row/);
			await settle();
			vi.restoreAllMocks();
			expect(surfaced).toEqual([]);
			expect(order(h)).toEqual([
				"a",
				"b",
				"c"
			]);
		});

		it("refuses a new row state can't hold, before anything moves", async () => {
			const h = await twoRows();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("z", "b"), (row) => row.Id, {
						add: () =>
							({
								When: new Date(0)
							}) as unknown as IRow,
						update: () => {}
					});
				})
			).rejects.toThrow(NonPlainDataError);
			expect(order(h)).toEqual([
				"a",
				"b"
			]);
		});

		it("refuses incoming data state can't hold", async () => {
			const h = await twoRows();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(
						draft.Rows,
						[
							{
								Id: "a",
								Value: new Date(0) as unknown as string,
								Subs: []
							}
						],
						(row) => row.Id,
						{
							update: () => {}
						}
					);
				})
			).rejects.toBeInstanceOf(NonPlainDataError);
		});

		it("refuses a target that isn't a draft array, and incoming that isn't an array", async () => {
			const h = await twoRows();
			await expect(
				h.runtime.dispatch(
					function* (_draft: IDoc, rows: IRow[]) {
						yield* reconcileRows(rows, [] as IRowFields[], (row) => row.Id, {
							update: () => {}
						});
					},
					"doc",
					[]
				)
			).rejects.toThrow(/an array on the draft/);
			await expect(
				h.run(function* () {
					yield* reconcileRows(h.runtime.state.Rows, [] as IRowFields[], (row) => row.Id, {
						update: () => {}
					});
				})
			).rejects.toThrow(/an array on the draft/);
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft as unknown as IRow[], [] as IRowFields[], (row) => row.Id, {
						update: () => {}
					});
				})
			).rejects.toThrow(/an array on the draft/);
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, null as unknown as IRowFields[], (row) => row.Id, {
						update: () => {}
					});
				})
			).rejects.toThrow(/incoming rows have to be an array/);
		});

		it("refuses a call with no update, before minting or moving", async () => {
			const h = await twoRows();
			const minted = h.minted();
			await expect(
				h.run(function* (draft) {
					yield* reconcileRows(draft.Rows, incoming("b", "z"), (row) => row.Id, {} as never);
				})
			).rejects.toThrow(/update is required/);
			expect(order(h)).toEqual([
				"a",
				"b"
			]);
			expect(h.minted()).toBe(minted);
		});

		it("refuses rows that have left the tree", async () => {
			const h = await twoRows();
			await expect(
				h.run(function* (draft) {
					const subs = draft.Rows[0].Subs;
					draft.Rows.shift();
					yield* generateGuid();
					yield* reconcileRows(subs, [] as ISubInfo[], (sub) => sub.Id, {
						update: () => {}
					});
				})
			).rejects.toBeInstanceOf(DraftDetachedError);
		});

		it("doesn't touch what it was given", async () => {
			const h = await twoRows();
			const given = incoming("a", "z");
			await h.run(function* (draft) {
				yield* reconcileRows(draft.Rows, given, (row) => row.Id, {
					update: () => {}
				});
			});
			expect(Object.isFrozen(given)).toBe(false);
			expect(Object.isFrozen(given[0])).toBe(false);
		});
	});

	describe(`reconcileRows and the rules every write obeys ${build_}`, () => {
		it("is refused through a held draft after its action, and writes nothing", async () => {
			const runtime = createRuntime<any>(
				{
					$Id: "root",
					Rows: [
						{
							K: 1
						}
					]
				},
				{
					onError: () => {}
				}
			);
			let held: any;
			await runtime.dispatch(function* (draft: any): IActionGenerator {
				held = draft.Rows;
			}, "root");
			const refresh = reconcileRows(
				held as object[],
				[
					{
						K: 2
					}
				],
				(row: any) => row.K,
				{
					add: (item: any) => item,
					update: () => {}
				}
			);
			expect(() => refresh.next()).toThrow(/state mutations belong to actions/);
			expect(runtime.state.Rows).toEqual([
				{
					K: 1
				}
			]);
			runtime.dispose();
		});

		it("refuses a new row in component state that copies a live domain row, as any write does", async () => {
			const runtime = createRuntime<any>(
				{
					$Id: "root",
					Rows: [
						{
							$Id: "row-1",
							Name: "one"
						}
					]
				},
				{
					onError: () => {}
				}
			);
			const internal = runtime as IRuntimeInternal<any>;
			const local = mountComponent(runtime, undefined, {
				Rows: []
			});
			const raw = rawOf(internal.resolveCell(local)!.state) as any;
			function* refresh(draft: any): IActionGenerator {
				yield* reconcileRows(
					draft.Rows,
					[
						{
							K: 1
						}
					],
					(row: any) => row.K,
					{
						add: () => ({
							...rawOf(runtime.state).Rows[0],
							K: 1
						}),
						update: () => {}
					}
				);
			}
			await expect(internal.dispatch(refresh, local)).rejects.toBeInstanceOf(EntityReplacedError);
			expect(raw.Rows).toEqual([]);
			runtime.dispose();
		});
	});

	describe(`guids ${build_}`, () => {
		it("answers readable ids in order, and each stub counts for itself", () => {
			const rows = guids("row");
			const other = guids();
			expect([
				rows(),
				rows(),
				other()
			]).toEqual([
				"row-1",
				"row-2",
				"guid-1"
			]);
		});
	});

	it(`reconcileRows ${build_}: stays quiet on a refresh with no fault`, async () => {
		const warn = vi.spyOn(console, "warn");
		const h = build();
		await h.run(function* (draft) {
			yield* assign(
				draft,
				info(
					"one",
					[
						"a",
						"a1"
					],
					[
						"b"
					]
				)
			);
			yield* generateGuid();
			yield* assign(
				draft,
				info(
					"two",
					[
						"b"
					],
					[
						"a",
						"a1"
					]
				)
			);
		});
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
}
