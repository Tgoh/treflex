import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { entity, idOf } from "../../src/Effects/entity";
import { ReconcileRowsKeyError, reconcileRows } from "../../src/Runtime/reconcileRows";
import { transient } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createTestRuntime, guids, type ITestRuntimeOptions } from "../../src/Testing/createTestRuntime";
import * as reactive from "../reactive";

interface IRequest extends IEntity {
	id: string;
	status: string;
	Saved?: string;
	Local?: boolean;
}

interface IRequestInfo {
	id: string;
	status: string;
}

interface IPlain {
	id: string | number;
	n: number;
}

interface IThread extends IEntity {
	Requests: Record<string, IRequest>;
	Plain: Record<string, IPlain>;
}

function* hold(): IActionGenerator<string> {
	return yield {
		Type: "hold"
	};
}

function* save(draft: IRequest, value: string): IActionGenerator<string> {
	const answer = yield* hold();
	draft.Saved = `${value}:${answer}`;
	return draft.Saved;
}

function* setStatus(row: IRequest, item: IRequestInfo): IActionGenerator {
	row.status = item.status;
}

const infos = (...ids: (string | number | undefined)[]): IRequestInfo[] =>
	ids.map((id) => ({
		id: id as string,
		status: `s-${id}`
	}));

type IAllow = Pick<ITestRuntimeOptions, "allowDiags" | "allowFailures">;

function build(seed: Partial<IThread> = {}, allow: IAllow = {}) {
	const holds: ((answer: string) => void)[] = [];
	const runtime = createTestRuntime<IThread>(
		{
			$Id: "thread",
			Requests: {},
			Plain: {},
			...seed
		},
		{
			generateGuid: guids("m"),
			hold: () =>
				new Promise((resolve) => {
					holds.push(resolve);
				})
		},
		allow
	);
	const records: IRecord[] = [];
	runtime.on("record", (record) => {
		records.push(record);
	});
	const run = <R>(action: IAction<IThread, [], R>): Promise<R | undefined> => runtime.dispatch(action, "thread");
	const keys = () => Object.keys(runtime.state.Requests);
	return {
		runtime,
		holds,
		records,
		run,
		keys
	};
}

async function loaded(allow: IAllow = {}) {
	const h = build({}, allow);
	await h.run(function* (draft) {
		yield* reconcileRows(draft.Requests, infos("a", "b", "c"), (item) => item.id, {
			update: setStatus
		});
	});
	return h;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function reconcileRowsRecordRules(build_: string): void {
	describe(`reconcileRows ${build_}: records`, () => {
		it("refreshes a record from a list: a matched row keeps its node, $Id and work, a new row is minted at its key, and a removed row's work ends", async () => {
			const h = await loaded({
				allowDiags: [
					"entity/written-while-held"
				]
			});
			expect(h.keys()).toEqual([
				"a",
				"b",
				"c"
			]);
			const a = rawOf(h.runtime.state.Requests.a!);
			const aId = a.$Id;
			await h.runtime.dispatch(function* (draft: IRequest) {
				draft.Local = true;
			}, aId);
			const savingA = h.runtime.dispatch(save, aId, "on-a");
			const savingB = h.runtime.dispatch(save, h.runtime.state.Requests.b!.$Id, "on-b");
			await settle();
			const outcome = await h.run(function* (draft) {
				const record = draft.Requests;
				const added = yield* reconcileRows(
					draft.Requests,
					[
						{
							id: "d",
							status: "new"
						},
						{
							id: "a",
							status: "two"
						}
					],
					(item) => item.id,
					{
						update: setStatus
					}
				);
				return {
					same: record === draft.Requests,
					added: added.map((row) => [
						row.id,
						row === draft.Requests[row.id]
					])
				};
			});
			expect(outcome).toEqual({
				same: true,
				added: [
					[
						"d",
						true
					]
				]
			});
			expect(h.keys()).toEqual([
				"a",
				"d"
			]);
			expect(rawOf(h.runtime.state.Requests.a)).toBe(a);
			expect(h.runtime.state.Requests.a).toMatchObject({
				$Id: aId,
				status: "two",
				Local: true
			});
			expect(h.runtime.state.Requests.d!.$Id).toBe("~m-4");
			h.holds[0]!("ok");
			h.holds[1]!("ok");
			await expect(savingA).resolves.toBe("on-a:ok");
			await expect(savingB).resolves.toBeUndefined();
			expect(h.runtime.state.Requests.a!.Saved).toBe("on-a:ok");
		});

		it("refreshes a record from a record by its own keys, and a row's field naming another key is data update writes", async () => {
			const h = await loaded();
			const b = rawOf(h.runtime.state.Requests.b!);
			await h.run(function* (draft) {
				yield* reconcileRows(
					draft.Requests,
					{
						x: {
							id: "y",
							status: "under x"
						},
						b: {
							id: "b",
							status: "kept"
						}
					},
					{
						update(row, item) {
							row.id = item.id;
							row.status = item.status;
						}
					}
				);
			});
			expect(h.keys()).toEqual([
				"b",
				"x"
			]);
			expect(rawOf(h.runtime.state.Requests.b)).toBe(b);
			expect(h.runtime.state.Requests.x).toMatchObject({
				id: "y",
				status: "under x"
			});
		});

		it("matches a current row by its record key, not by the field the key function reads", async () => {
			const h = build({
				Requests: {
					a: {
						$Id: "held",
						id: "z",
						status: "old"
					}
				}
			});
			const a = rawOf(h.runtime.state.Requests.a!);
			await h.run(function* (draft) {
				yield* reconcileRows(
					draft.Requests,
					[
						{
							id: "a",
							status: "new"
						}
					],
					(item) => item.id,
					{
						update: setStatus
					}
				);
			});
			expect(h.keys()).toEqual([
				"a"
			]);
			expect(rawOf(h.runtime.state.Requests.a)).toBe(a);
			expect(h.runtime.state.Requests.a).toMatchObject({
				$Id: "held",
				id: "z",
				status: "new"
			});
		});

		it("keeps a matched key where it was and puts new keys on the end in incoming order, and matches 5 with '5'", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* reconcileRows(draft.Requests, infos("k2", "k1"), (item) => item.id, {
					update: setStatus
				});
				yield* reconcileRows(draft.Requests, infos("n1", "k1", "n2", "k2"), (item) => item.id, {
					update: setStatus
				});
			});
			expect(h.keys()).toEqual([
				"k2",
				"k1",
				"n1",
				"n2"
			]);

			await h.run(function* (draft) {
				yield* reconcileRows(draft.Requests, infos("x", "5"), (item) => item.id, {
					update: setStatus
				});
			});
			const five = rawOf(h.runtime.state.Requests["5"]!);
			await h.run(function* (draft) {
				yield* reconcileRows(draft.Requests, infos(5, "x", 10), (item) => item.id, {
					update: () => {}
				});
			});
			expect(rawOf(h.runtime.state.Requests["5"])).toBe(five);
			expect(h.keys()).toEqual([
				"5",
				"10",
				"x"
			]);
		});

		it("lands in one step, so a view sees the record before or after", async () => {
			const h = await loaded();
			const seen: string[][] = [];
			const dispose = reactive.root((disposer) => {
				reactive.effect(() => {
					seen.push(Object.entries(h.runtime.state.Requests).map(([key, row]) => `${key}:${row.status}`));
				});
				return disposer;
			});
			const from = h.records.length;
			await h.run(function* (draft) {
				yield* reconcileRows(draft.Requests, infos("c", "e", "a"), (item) => item.id, {
					update(row, item) {
						row.status = `two-${item.id}`;
					}
				});
			});
			dispose();
			expect(seen).toEqual([
				[
					"a:s-a",
					"b:s-b",
					"c:s-c"
				],
				[
					"a:two-a",
					"c:two-c",
					"e:two-e"
				]
			]);
			expect(h.records.slice(from).filter((record) => record.Kind === "step")).toHaveLength(1);
		});

		it("runs every add before anything moves, so a throw there leaves the record untouched", async () => {
			function* refresh(draft: IThread): IActionGenerator {
				yield* reconcileRows(draft.Requests, infos("a", "d", "e"), (item) => item.id, {
					*add(item) {
						if (item.id === "e") {
							throw new Error("no e");
						}
						return yield* entity(item);
					},
					update: setStatus
				});
			}
			const h = await loaded({
				allowFailures: [
					refresh
				]
			});
			const before = JSON.stringify(h.runtime.state);
			await expect(h.run(refresh)).rejects.toThrow("no e");
			expect(JSON.stringify(h.runtime.state)).toBe(before);
		});

		it("refuses a repeated or missing key in a list and an empty key in a record, before anything moves", async () => {
			function* repeated(draft: IThread): IActionGenerator {
				yield* reconcileRows(draft.Requests, infos("d", "a", "d"), (item) => item.id, {
					update: setStatus
				});
			}
			function* missing(draft: IThread): IActionGenerator {
				yield* reconcileRows(draft.Requests, infos("d", ""), (item) => item.id, {
					update: setStatus
				});
			}
			function* empty(draft: IThread): IActionGenerator {
				yield* reconcileRows(
					draft.Requests,
					{
						d: {
							id: "d",
							status: ""
						},
						"": {
							id: "",
							status: ""
						}
					},
					{
						update: setStatus
					}
				);
			}
			const h = await loaded({
				allowFailures: [
					repeated,
					missing,
					empty
				]
			});
			const before = JSON.stringify(h.runtime.state);
			await expect(h.run(repeated)).rejects.toThrow(ReconcileRowsKeyError);
			await expect(h.run(missing)).rejects.toThrow(/no key on the incoming row at \[1\]/);
			await expect(h.run(empty)).rejects.toThrow(/the incoming record has the key ""/);
			expect(JSON.stringify(h.runtime.state)).toBe(before);
		});

		it("refuses a key function with an incoming record, and a record of incoming rows for a list, before anything moves", async () => {
			function* keyed(draft: IThread): IActionGenerator {
				yield* reconcileRows(
					draft.Requests,
					{
						d: {
							id: "d",
							status: ""
						}
					} as never,
					((item: IRequestInfo) => item.id) as never,
					{
						update: setStatus
					} as never
				);
			}
			function* intoAList(draft: IThread): IActionGenerator {
				const shelf = yield* transient(draft, "ReconcileRows/List", {
					Rows: [] as IRequest[]
				});
				yield* reconcileRows(
					shelf.Rows as never,
					{} as never,
					{
						update: () => {}
					} as never
				);
			}
			const h = await loaded({
				allowFailures: [
					keyed,
					intoAList
				]
			});
			const before = JSON.stringify(h.runtime.state);
			await expect(h.run(keyed)).rejects.toThrow(/takes no key function/);
			await expect(h.run(intoAList)).rejects.toThrow(/incoming rows for a list have to be an array/);
			expect(JSON.stringify(h.runtime.state)).toBe(before);
		});

		it("skips __proto__, as an item's key or as an own key JSON.parse made in an incoming record", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* reconcileRows(draft.Requests, infos("__proto__", "a"), (item) => item.id, {
					update: setStatus
				});
			});
			expect(h.keys()).toEqual([
				"a"
			]);
			await h.run(function* (draft) {
				yield* reconcileRows(
					draft.Requests,
					JSON.parse('{"__proto__": {"id": "p", "status": "p"}, "b": {"id": "b", "status": "b"}}') as Record<string, IRequestInfo>,
					{
						update: setStatus
					}
				);
			});
			expect(h.keys()).toEqual([
				"b"
			]);
			expect(Object.getPrototypeOf(rawOf(h.runtime.state.Requests))).toBe(Object.prototype);
		});

		it("keeps plain rows' nodes, adds plain rows through add, and removes a row under the empty key, which can't match", async () => {
			const h = build({
				Plain: {
					"": {
						id: "",
						n: 0
					},
					a: {
						id: "a",
						n: 1
					}
				}
			});
			const a = rawOf(h.runtime.state.Plain.a!);
			await h.run(function* (draft) {
				yield* reconcileRows(
					draft.Plain,
					[
						{
							id: "b",
							n: 2
						},
						{
							id: "a",
							n: 3
						}
					],
					(item) => item.id,
					{
						add: (item) => ({
							id: item.id,
							n: 0
						}),
						update(row, item) {
							row.n = item.n;
						}
					}
				);
			});
			expect(rawOf(h.runtime.state.Plain.a)).toBe(a);
			expect(rawOf(h.runtime.state.Plain)).toEqual({
				a: {
					id: "a",
					n: 3
				},
				b: {
					id: "b",
					n: 2
				}
			});
		});

		it("works on a transient's record, born by the refresh, and the rows it adds take work", async () => {
			const shelf = (owner: IEntity) =>
				transient(owner, "ReconcileRows/Shelf", {
					Rows: {} as Record<string, IRequest>
				});
			const h = build();
			const ids = (await h.run(function* (draft) {
				const added = yield* reconcileRows((yield* shelf(draft)).Rows, infos("a", "b"), (item) => item.id, {
					update: setStatus
				});
				return added.map((row) => idOf(row));
			}))!;
			const saving = h.runtime.dispatch(save, ids[0]!, "kept");
			await settle();
			await h.run(function* (draft) {
				yield* reconcileRows((yield* shelf(draft)).Rows, infos("a"), (item) => item.id, {
					update: () => {}
				});
			});
			h.holds[0]!("ok");
			await expect(saving).resolves.toBe("kept:ok");
			const rows = await h.run(function* (draft) {
				return Object.keys((yield* shelf(draft)).Rows);
			});
			expect(rows).toEqual([
				"a"
			]);
		});
	});
}
