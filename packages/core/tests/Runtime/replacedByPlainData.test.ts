import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it, vi } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { start } from "../../src/Effects/start";
import { startTimer } from "../../src/Effects/startTimer";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { minted, rawReceiver } from "../testHelpers";

const CODE = "entity/replaced-by-plain-data";

interface IRow {
	$Id?: string;
	Name: string;
}

interface IWorld {
	$Id: string;
	Rows: IRow[];
	Panel: IRow | null;
	Other: IRow[];
}

const Noop = rawReceiver(
	"PlainNoop",
	[
		"Plain/Topic"
	],
	function* noop(): IActionGenerator {}
);

function* attachBinding(draft: IRow): IActionGenerator {
	bind(draft as any, Noop);
}

function* attachTimer(draft: IRow): IActionGenerator {
	yield* (startTimer as any)(draft, "Plain/Tick", Noop, {
		IntervalMs: 60000
	});
}

function* attachResource(draft: IRow): IActionGenerator {
	yield* (openResource as any)(draft, "Plain/Feed", Noop, {
		Type: "plain/feed"
	});
}

function* parks(): IActionGenerator {
	yield {
		Type: "gate"
	};
}

function build(seed?: Partial<IWorld>) {
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Rows: [
				{
					$Id: "row-1",
					Name: "one"
				},
				{
					$Id: "row-2",
					Name: "two"
				}
			],
			Panel: {
				$Id: "panel",
				Name: "panel"
			},
			Other: [],
			...seed
		},
		{
			pauseTimers: true,
			pauseResources: true,
			implementations: {
				gate: () => new Promise(() => {})
			}
		}
	);
	runtime.registerReceiver(Noop);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => {
		if (event.code === CODE) {
			diags.push(event);
		}
	});
	return {
		runtime,
		diags,
		write: (fn: (draft: IWorld) => void) =>
			runtime.dispatch(function* write(draft: IWorld): IActionGenerator {
				fn(draft);
			}, "root")
	};
}

const fetched = () => [
	{
		Name: "fetched"
	}
];

describe("entity/replaced-by-plain-data", () => {
	it.each([
		[
			"a binding",
			attachBinding,
			{
				receiver: "PlainNoop"
			}
		],
		[
			"a timer",
			attachTimer,
			{
				timers: 1
			}
		],
		[
			"a resource",
			attachResource,
			{
				resources: 1
			}
		]
	] as const)("fires when plain rows replace an entity holding %s", async (_name, attach, expected) => {
		const h = build();
		await h.runtime.dispatch(attach, "row-1");

		await h.write((draft) => {
			draft.Rows = fetched();
		});

		expect(h.diags).toHaveLength(1);
		expect(h.diags[0].severity).toBe("warn");
		expect(h.diags[0].message).toContain("[AppState.Rows]");
		expect(h.diags[0].message).toContain('"row-1"');
		expect(h.diags[0].message).not.toContain('"row-2"');
		expect(h.diags[0].data).toMatchObject({
			at: "AppState.Rows",
			entities: [
				{
					id: "row-1",
					receiver: undefined,
					timers: 0,
					resources: 0,
					actions: [],
					...expected
				}
			]
		});
		h.runtime.dispose();
	});

	it("fires for running work, naming the action", async () => {
		const h = build();
		await h.runtime.dispatch(function* startsParked(draft: IWorld): IActionGenerator {
			yield* start(parks, draft.Rows[0].$Id!);
		}, "root");

		await h.write((draft) => {
			draft.Rows = fetched();
		});

		expect(h.diags).toHaveLength(1);
		expect(h.diags[0].data).toMatchObject({
			entities: [
				{
					id: "row-1",
					actions: [
						"parks"
					]
				}
			]
		});
		h.runtime.dispose();
	});

	it("fires for an entity slot replaced by a plain object", async () => {
		const h = build();
		await h.runtime.dispatch(attachBinding, "panel");

		await h.write((draft) => {
			draft.Panel = {
				Name: "plain"
			};
		});

		expect(h.diags).toHaveLength(1);
		expect(h.diags[0].data).toMatchObject({
			at: "AppState.Panel"
		});
		h.runtime.dispose();
	});

	it("reports entities nested under the replaced node", async () => {
		const h = build({
			Panel: {
				$Id: "panel",
				Name: "panel",
				Inner: {
					$Id: "inner",
					Name: "inner"
				}
			} as IRow
		});
		await h.runtime.dispatch(attachBinding, "inner");

		await h.write((draft) => {
			draft.Panel = {
				Name: "plain"
			};
		});

		expect(h.diags[0].data).toMatchObject({
			entities: [
				{
					id: "inner"
				}
			]
		});
		h.runtime.dispose();
	});

	it("stays silent on an empty replacement, a null, or a scalar", async () => {
		const h = build({
			Extra: {
				$Id: "extra",
				Name: "extra"
			}
		} as Partial<IWorld>);
		await h.runtime.dispatch(attachBinding, "row-1");
		await h.runtime.dispatch(attachBinding, "panel");
		await h.runtime.dispatch(attachBinding, "extra");

		await h.write((draft: any) => {
			draft.Rows = [];
			draft.Panel = null;
			draft.Extra = 5;
		});

		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("stays silent when nothing was attached", async () => {
		const h = build();

		await h.write((draft) => {
			draft.Rows = fetched();
		});

		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("stays silent when the replacement carries entities", async () => {
		const h = build();
		await h.runtime.dispatch(attachBinding, "row-1");

		await h.write((draft) => {
			draft.Rows = [
				minted("fresh", {
					Name: "fresh"
				}),
				{
					Name: "plain beside it"
				}
			];
		});

		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("stays silent when the plain data lands in a later step", async () => {
		const h = build();
		await h.runtime.dispatch(attachBinding, "row-1");

		await h.write((draft) => {
			draft.Rows = [];
		});
		await h.write((draft) => {
			draft.Rows = fetched();
		});

		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("stays silent when the plain data lands in another slot", async () => {
		const h = build();
		await h.runtime.dispatch(attachBinding, "row-1");

		await h.write((draft) => {
			draft.Rows = [];
			draft.Other = fetched();
		});

		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("stays silent on a splice whose shifted neighbour is plain", async () => {
		const h = build({
			Rows: [
				{
					$Id: "row-1",
					Name: "one"
				},
				{
					Name: "already here"
				}
			]
		});
		await h.runtime.dispatch(attachBinding, "row-1");

		await h.write((draft) => {
			draft.Rows.splice(0, 1);
		});

		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("stays silent when an entity moved elsewhere rather than ending", async () => {
		const h = build();
		await h.runtime.dispatch(attachBinding, "row-1");

		await h.write((draft) => {
			draft.Other.push(draft.Rows[0]);
			draft.Rows = fetched();
		});

		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("stays silent on reconcileRows' seating: its removals say nothing about the plain rows it added", async () => {
		const h = build();
		await h.runtime.dispatch(attachBinding, "row-1");

		await h.runtime.dispatch(function* (draft: IWorld): IActionGenerator {
			yield* reconcileRows(draft.Rows, fetched(), (row) => row.Name, {
				add: (item) => item,
				update: () => {}
			});
		}, "root");

		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	describe("the entity's own key in the new container", () => {
		const paged = () =>
			({
				Page: {
					Sel: {
						$Id: "sel",
						Name: "sel"
					},
					Title: "page"
				}
			}) as Partial<IWorld>;

		it.each([
			[
				"null",
				null
			]
		])("stays silent when it holds %s, an explicit clear", async (_name, cleared) => {
			const h = build(paged());
			await h.runtime.dispatch(attachBinding, "sel");

			await h.write((draft: any) => {
				draft.Page = {
					...draft.Page,
					Sel: cleared
				};
			});

			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});

		it("fires when the key is missing", async () => {
			const h = build(paged());
			await h.runtime.dispatch(attachBinding, "sel");

			await h.write((draft: any) => {
				draft.Page = {
					Title: draft.Page.Title
				};
			});

			expect(h.diags).toHaveLength(1);
			expect(h.diags[0].data).toMatchObject({
				at: "AppState.Page",
				entities: [
					{
						id: "sel"
					}
				]
			});
			h.runtime.dispose();
		});

		it("stays silent when a key on the way to its container is missing", async () => {
			const h = build({
				Page: {
					Deep: {
						Rows: [
							{
								$Id: "deep-row",
								Name: "row"
							}
						]
					}
				}
			} as Partial<IWorld>);
			await h.runtime.dispatch(attachBinding, "deep-row");

			await h.write((draft: any) => {
				draft.Page = {
					Title: "no Deep here"
				};
			});

			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});
	});

	describe("the verdict on a container", () => {
		function countingScans(rows: object[]) {
			const counted = {
				scans: 0,
				rows: new Proxy(rows, {
					ownKeys(target) {
						counted.scans++;
						return Reflect.ownKeys(target);
					}
				})
			};
			return counted;
		}

		async function scansWith(attachedCount: number, rows: object[]) {
			const h = build({
				Rows: Array.from(
					{
						length: 20
					},
					(_, i) => ({
						$Id: `row-${i}`,
						Name: "row"
					})
				)
			});
			for (let i = 0; i < attachedCount; i++) {
				await h.runtime.dispatch(attachBinding, `row-${i}`);
			}
			const counted = countingScans(rows);
			await h.write((draft) => {
				draft.Rows = counted.rows as IRow[];
			});
			h.runtime.dispose();
			return {
				scans: counted.scans,
				diags: h.diags
			};
		}

		it("is scanned once when it fires, however many attached entities sat in it", async () => {
			const one = await scansWith(1, fetched());
			const many = await scansWith(20, fetched());

			expect(one.diags).toHaveLength(1);
			expect(many.diags).toHaveLength(1);
			expect(many.scans).toBe(one.scans);
		});

		it("is scanned once when it stays silent, however many attached entities sat in it", async () => {
			const entities = () => [
				minted("new-1", {
					Name: "new"
				}),
				minted("new-2", {
					Name: "new"
				})
			];
			const one = await scansWith(1, entities());
			const many = await scansWith(20, entities());

			expect(one.diags).toEqual([]);
			expect(many.diags).toEqual([]);
			expect(many.scans).toBe(one.scans);
		});
	});

	it("settles a write a diag listener makes before the drain ends", async () => {
		const h = build();
		await h.runtime.dispatch(attachBinding, "row-1");
		h.runtime.on("diag", (event) => {
			if (event.code === CODE) {
				void h.write((draft) => {
					draft.Other.push(
						minted("added-by-listener", {
							Name: "added"
						})
					);
				});
			}
		});

		await h.write((draft) => {
			draft.Rows = fetched();
		});

		expect((h.runtime as IRuntimeInternal<IWorld>).resolveCell("~added-by-listener")).toBeDefined();
		h.runtime.dispose();
	});

	it("answers per owner from the tables' indexes, never copying a table per removed entity", async () => {
		const rows = Array.from(
			{
				length: 50
			},
			(_, i) => ({
				$Id: `row-${i}`,
				Name: "row"
			})
		);
		const h = build({
			Rows: rows
		});
		const internal = h.runtime as IRuntimeInternal<IWorld>;
		const tables = [
			internal.get("runtime/bindings"),
			internal.get("runtime/timers"),
			internal.get("runtime/resourceTable")
		];
		const copies = tables.map((table) => vi.spyOn(table, "entries"));
		const counts = vi.spyOn(internal.get("runtime/bindings"), "receiverOf");

		await h.write((draft) => {
			draft.Rows = fetched();
		});

		expect(h.diags).toEqual([]);
		for (const copy of copies) {
			expect(copy).not.toHaveBeenCalled();
		}
		expect(counts).toHaveBeenCalledTimes(50);
		h.runtime.dispose();
	});

	it("asks nothing about a removal with nothing arriving", async () => {
		const h = build();
		const counts = vi.spyOn((h.runtime as IRuntimeInternal<IWorld>).get("runtime/bindings"), "receiverOf");

		await h.write((draft) => {
			draft.Rows.splice(0, 2);
		});

		expect(counts).not.toHaveBeenCalled();
		h.runtime.dispose();
	});

	describe("judged per removed entity, at the container it sat in", () => {
		function pageWorld(page: object) {
			const h = build({
				Page: page
			} as Partial<IWorld>);
			return {
				...h,
				writePage: (fn: (draft: any) => void) => h.write(fn)
			};
		}

		it("fires for a row when a spread keeps a sibling entity and swaps the rows", async () => {
			const h = pageWorld({
				Header: {
					$Id: "header",
					Name: "header"
				},
				Rows: [
					{
						$Id: "page-row",
						Name: "row"
					}
				]
			});
			await h.runtime.dispatch(attachBinding, "page-row");
			await h.runtime.dispatch(attachBinding, "header");

			await h.writePage((draft) => {
				draft.Page = {
					...draft.Page,
					Rows: fetched()
				};
			});

			expect(h.diags).toHaveLength(1);
			expect(h.diags[0].data).toMatchObject({
				at: "AppState.Page.Rows",
				entities: [
					{
						id: "page-row"
					}
				]
			});
			h.runtime.dispose();
		});

		it("fires for a row when a new entity with plain rows takes the slot, and not for the entity it replaced", async () => {
			const h = pageWorld({
				$Id: "p1",
				Rows: [
					{
						$Id: "page-row",
						Name: "row"
					}
				]
			});
			await h.runtime.dispatch(attachBinding, "page-row");
			await h.runtime.dispatch(attachBinding, "p1");

			await h.writePage((draft) => {
				draft.Page = minted("p2", {
					Rows: fetched()
				});
			});

			expect(h.diags).toHaveLength(1);
			expect((h.diags[0].data as any).entities.map((entity: any) => entity.id)).toEqual([
				"page-row"
			]);
			h.runtime.dispose();
		});

		it("stays silent when the shape comes back empty", async () => {
			const h = pageWorld({
				Rows: [
					{
						$Id: "page-row",
						Name: "row"
					}
				],
				Sel: {
					$Id: "sel",
					Name: "sel"
				}
			});
			await h.runtime.dispatch(attachBinding, "page-row");
			await h.runtime.dispatch(attachBinding, "sel");

			await h.writePage((draft) => {
				draft.Page = {
					Rows: [],
					Sel: null
				};
			});

			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});

		it("names every attached row, including those past the end of what arrived", async () => {
			const h = build();
			await h.runtime.dispatch(attachBinding, "row-1");
			await h.runtime.dispatch(attachTimer, "row-2");

			await h.write((draft) => {
				draft.Rows = fetched();
			});

			expect(h.diags).toHaveLength(1);
			expect((h.diags[0].data as any).entities.map((entity: any) => entity.id)).toEqual([
				"row-1",
				"row-2"
			]);
			h.runtime.dispose();
		});

		it("stays silent on an in-place splice that leaves entities", async () => {
			const h = build();
			await h.runtime.dispatch(attachBinding, "row-1");

			await h.write((draft) => {
				draft.Rows.splice(0, 1);
			});

			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});

		it("names the first ten, and counts the rest", async () => {
			const h = build({
				Rows: Array.from(
					{
						length: 12
					},
					(_, i) => ({
						$Id: `row-${i}`,
						Name: "row"
					})
				)
			});
			for (let i = 0; i < 12; i++) {
				await h.runtime.dispatch(attachBinding, `row-${i}`);
			}

			await h.write((draft) => {
				draft.Rows = fetched();
			});

			expect(h.diags).toHaveLength(1);
			expect(h.diags[0].message).toContain("; and 2 more.");
			expect((h.diags[0].data as any).entities).toHaveLength(10);
			h.runtime.dispose();
		});
	});

	it("fires when plain data already in the tree moves into the slot", async () => {
		const h = build({
			Pending: fetched()
		} as Partial<IWorld>);
		await h.runtime.dispatch(attachBinding, "row-1");

		await h.write((draft: any) => {
			draft.Rows = draft.Pending;
			draft.Pending = [];
		});

		expect(h.diags).toHaveLength(1);
		expect(h.diags[0].data).toMatchObject({
			at: "AppState.Rows"
		});
		h.runtime.dispose();
	});

	describe("nodes reconcileRows seated", () => {
		const keyedSeed = () => ({
			Rows: [
				{
					$Id: "row-1",
					Id: "a",
					Name: "one"
				},
				{
					Id: "b",
					Name: "two"
				}
			] as (IRow & {
				Id: string;
			})[]
		});

		it("stay exempt after a reorder moves them to other slots", async () => {
			const h = build(keyedSeed());
			await h.runtime.dispatch(attachBinding, "row-1");

			await h.runtime.dispatch(function* (draft: IWorld): IActionGenerator {
				yield* reconcileRows(
					draft.Rows as any[],
					[
						{
							Id: "b",
							Name: "two"
						},
						{
							Id: "c",
							Name: "seated"
						}
					],
					(row) => row.Id,
					{
						add: (item) => item,
						update: () => {}
					}
				);
				draft.Rows.sort((x, y) => y.Name.localeCompare(x.Name));
			}, "root");

			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});

		it("do not exempt a different node assigned over the slot", async () => {
			const h = build(keyedSeed());
			await h.runtime.dispatch(attachBinding, "row-1");

			await h.runtime.dispatch(function* (draft: IWorld): IActionGenerator {
				yield* reconcileRows(
					draft.Rows as any[],
					[
						{
							Id: "c",
							Name: "seated"
						}
					],
					(row) => row.Id,
					{
						add: (item) => item,
						update: () => {}
					}
				);
				draft.Rows[0] = {
					Name: "assigned"
				};
			}, "root");

			expect(h.diags).toHaveLength(1);
			h.runtime.dispose();
		});
	});

	describe("one warning per container", () => {
		it("for a clear and refill of the array in place", async () => {
			const h = build();
			await h.runtime.dispatch(attachBinding, "row-1");
			await h.runtime.dispatch(attachBinding, "row-2");

			await h.write((draft) => {
				draft.Rows.length = 0;
				draft.Rows.push(
					{
						Name: "a"
					},
					{
						Name: "b"
					}
				);
			});

			expect(h.diags).toHaveLength(1);
			expect((h.diags[0].data as any).entities.map((entity: any) => entity.id)).toEqual([
				"row-1",
				"row-2"
			]);
			h.runtime.dispose();
		});
	});

	describe("rows carried over from the array that was replaced", () => {
		const mixed = () => ({
			Rows: [
				{
					$Id: "row-1",
					Name: "one"
				},
				{
					Name: "plain"
				}
			]
		});

		it("do not count as arriving when a filter keeps only them", async () => {
			const h = build(mixed());
			await h.runtime.dispatch(attachBinding, "row-1");

			await h.write((draft) => {
				draft.Rows = draft.Rows.filter((row) => !row.$Id);
			});

			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});

		it("do not hide a fresh row beside them", async () => {
			const h = build(mixed());
			await h.runtime.dispatch(attachBinding, "row-1");

			await h.write((draft) => {
				draft.Rows = [
					...draft.Rows.filter((row) => !row.$Id),
					{
						Name: "fresh"
					}
				];
			});

			expect(h.diags).toHaveLength(1);
			h.runtime.dispose();
		});

		it("are not followed into when the entity sat inside a row, whichever position they now hold", async () => {
			const h = build({
				Windows: [
					{
						Kind: "a",
						Body: {
							$Id: "win-a",
							Name: "a"
						}
					},
					{
						Kind: "text",
						Body: {
							Text: "plain"
						}
					},
					{
						Kind: "b",
						Body: {
							$Id: "win-b",
							Name: "b"
						}
					}
				]
			} as Partial<IWorld>);
			await h.runtime.dispatch(attachBinding, "win-a");

			await h.write((draft: any) => {
				draft.Windows = draft.Windows.filter((window: any) => window.Body.$Id !== "win-a");
			});

			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});
	});

	it("refuses nothing: the write lands and the entity ends", async () => {
		const h = build();
		await h.runtime.dispatch(attachBinding, "row-1");

		await h.write((draft) => {
			draft.Rows = fetched();
		});

		expect(h.runtime.state.Rows).toEqual(fetched());
		expect((h.runtime as IRuntimeInternal<IWorld>).get("runtime/bindings").boundTo(Noop.Id)).toEqual([]);
		h.runtime.dispose();
	});
});
