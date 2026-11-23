import type { IActionGenerator, IEntity } from "../../src/index";
import type { IDeliveryAt, IHistory } from "../../src/Resume/history";
import type { IPlan } from "../../src/Resume/plan";
import type { IInFlightState } from "../../src/Runtime/processAction";
import type { ISnapshotInFlightEntry } from "../../src/Snapshot/ISnapshot";
import { describe, expect, it } from "vitest";
import { planResume } from "../../src/Resume/plan";
import { resumable } from "../../src/Resume/resumable";
import { named } from "../../src/Runtime/named";

function* marked(_draft: IEntity): IActionGenerator {}
named(marked, "Plan/Marked");
resumable(marked);

function* unmarked(_draft: IEntity): IActionGenerator {}
named(unmarked, "Plan/Unmarked");

let ids = 0;

function row(state: IInFlightState, place?: number, entityId = "o1", name = "Plan/Marked"): ISnapshotInFlightEntry {
	return {
		ActionId: `a${++ids}`,
		Name: name,
		Label: "marked",
		EntityId: entityId,
		State: state,
		...(place === undefined
			? {}
			: {
					Place: place
				})
	};
}

function historyOf(entry: ISnapshotInFlightEntry, unlisted: unknown, deliveries: unknown = []): IHistory {
	return {
		ActionId: entry.ActionId,
		Args: [],
		ArgsExact: true,
		Entries:
			entry.State === "queued"
				? []
				: [
						{
							Kind: "effect",
							Seq: 1,
							Descriptor: {
								Type: "ask"
							}
						}
					],
		Unlisted: unlisted as IHistory["Unlisted"],
		UnlistedLineage: [],
		Deliveries: deliveries as IDeliveryAt[]
	};
}

function planned(rows: ISnapshotInFlightEntry[], edit: (history: Record<string, unknown>) => void): IPlan[] {
	return planResume({
		rows,
		histories: rows.map((entry) => {
			const history = historyOf(entry, "none") as unknown as Record<string, unknown>;
			edit(history);
			return history as unknown as IHistory;
		}),
		resume: true,
		sameBuild: true,
		isIdempotent: () => false,
		lineOf: (id) => [
			"shop",
			id
		],
		watched: () => null
	});
}

function plan(
	rows: ISnapshotInFlightEntry[],
	...given: [
		unlisted?: unknown
	]
): IPlan[] {
	const unlisted = given.length === 0 ? "none" : given[0];
	return planned(rows, (history) => {
		if (unlisted === undefined) {
			delete history.Unlisted;
		} else {
			history.Unlisted = unlisted;
		}
	});
}

function withDeliveries(rows: ISnapshotInFlightEntry[], deliveries: unknown): IPlan[] {
	return planned(rows, (history) => {
		if (deliveries === undefined) {
			delete history.Deliveries;
		} else {
			history.Deliveries = deliveries;
		}
	});
}

function shapes(plans: IPlan[], rows: ISnapshotInFlightEntry[]): unknown[] {
	const index = (entry: ISnapshotInFlightEntry) => rows.indexOf(entry);
	return plans.map((planned) => {
		switch (planned.kind) {
			case "replay":
				return [
					"replay"
				];
			case "queued":
				return [
					"queued",
					planned.on.map(index)
				];
			case "behind":
				return [
					"behind",
					planned.on.map(index),
					planned.ifResumed
				];
			default:
				return [
					planned.reason,
					planned.detail
				];
		}
	});
}

const HOLDS = "work the snapshot's rows don't list and can't name holds its entity, and nothing resumes beside it";
const IN_LINE = "work the snapshot's rows don't list and can't name stands in its entity's line, and nothing resumes beside it";
const REGAIN = "it waits in its entity's line for its hold back, and replaying a regain is not built";
const NO_HOLDER = "nothing holds its entity, and a line is put back only behind its replayed holder";

describe("the planner's rule", () => {
	it("a holder later in row order than a row inside open(...) is the one replayed, whatever is in its line", () => {
		const rows = [
			row("open"),
			row("holding"),
			row("queued", 0, "o1", "Plan/Unmarked")
		];
		expect(shapes(plan(rows), rows)).toEqual([
			[
				"behind",
				[
					1
				],
				'its entity\'s holder "Plan/Marked" is resumed, and only one action per entity is replayed'
			],
			[
				"replay"
			],
			[
				"not-marked",
				undefined
			]
		]);
	});

	it("a queued row waits on the holder and every row ahead of it; a regaining row drops", () => {
		const rows = [
			row("holding"),
			row("regaining", 1),
			row("queued", 0),
			row("queued", 2)
		];
		expect(shapes(plan(rows), rows)).toEqual([
			[
				"replay"
			],
			[
				"off-list",
				REGAIN
			],
			[
				"queued",
				[
					0
				]
			],
			[
				"queued",
				[
					0,
					2,
					1
				]
			]
		]);
	});

	it("with a holder that isn't replayed, the first row inside open(...) is, and a queued row waits on the holder", () => {
		const rows = [
			row("holding", undefined, "o1", "Plan/Unmarked"),
			row("open"),
			row("open"),
			row("queued", 0)
		];
		expect(shapes(plan(rows), rows)).toEqual([
			[
				"not-marked",
				undefined
			],
			[
				"replay"
			],
			[
				"off-list",
				"a replay is planned ahead of it, in row order, on its entity, an ancestor or a descendant"
			],
			[
				"queued",
				[
					0
				]
			]
		]);
	});

	it("a stopping row is a holder no one replays", () => {
		const rows = [
			row("stopping"),
			row("open"),
			row("queued", 0)
		];
		expect(shapes(plan(rows), rows)).toEqual([
			[
				"off-list",
				"the runtime had stopped it"
			],
			[
				"replay"
			],
			[
				"queued",
				[
					0
				]
			]
		]);
	});

	it("on an entity nothing holds, a row inside open(...) is replayed and the line drops", () => {
		const rows = [
			row("open"),
			row("queued", 0),
			row("regaining", 1)
		];
		expect(shapes(plan(rows), rows)).toEqual([
			[
				"replay"
			],
			[
				"behind",
				NO_HOLDER
			],
			[
				"off-list",
				REGAIN
			]
		]);
	});

	for (const [what, unlisted, detail] of [
		[
			"holding the entity",
			"holding",
			HOLDS
		],
		[
			"in the line",
			"in-line",
			IN_LINE
		],
		[
			"missing, from a writer that didn't know the field",
			undefined,
			HOLDS
		],
		[
			'"foo"',
			"foo",
			HOLDS
		],
		[
			"{}",
			{},
			HOLDS
		],
		[
			"null",
			null,
			HOLDS
		]
	] as const) {
		it(`work the rows don't list and can't name, ${what}: every row on the entity drops, unlisted`, () => {
			const rows = [
				row("holding"),
				row("open"),
				row("queued", 0)
			];
			expect(shapes(plan(rows, unlisted), rows)).toEqual([
				[
					"unlisted",
					detail
				],
				[
					"unlisted",
					detail
				],
				[
					"unlisted",
					detail
				]
			]);
		});
	}

	const MAY_BE =
		"work the snapshot's rows don't list and can't name may be on an entity above or below its own, and nothing resumes beside it";
	for (const [what, lineage, detail] of [
		[
			"holding an entity below",
			[
				{
					EntityId: "o1-l1",
					Unlisted: "holding"
				}
			],
			"work the snapshot's rows don't list and can't name holds \"o1-l1\", above or below its entity, and nothing resumes beside it"
		],
		[
			"in the line of an entity above",
			[
				{
					EntityId: "shop",
					Unlisted: "in-line"
				}
			],
			"work the snapshot's rows don't list and can't name stands in the line of \"shop\", above or below its entity, and nothing resumes beside it"
		],
		[
			"missing, from a writer that didn't know the field",
			undefined,
			MAY_BE
		],
		[
			'"none"',
			"none",
			MAY_BE
		],
		[
			"null",
			null,
			MAY_BE
		],
		[
			"an entry with no entity",
			[
				{
					Unlisted: "holding"
				}
			],
			MAY_BE
		],
		[
			"an entry that says none",
			[
				{
					EntityId: "shop",
					Unlisted: "none"
				}
			],
			MAY_BE
		]
	] as const) {
		it(`work the rows don't list and can't name above or below the entity, ${what}: every row on the entity drops, unlisted`, () => {
			const rows = [
				row("holding"),
				row("open"),
				row("queued", 0)
			];
			const plans = planned(rows, (history) => {
				if (lineage === undefined) {
					delete history.UnlistedLineage;
				} else {
					history.UnlistedLineage = lineage;
				}
			});
			expect(shapes(plans, rows)).toEqual([
				[
					"unlisted",
					detail
				],
				[
					"unlisted",
					detail
				],
				[
					"unlisted",
					detail
				]
			]);
		});
	}

	it("rows on another entity are judged by their own entity's rows", () => {
		const rows = [
			row("holding", undefined, "o1"),
			row("queued", 0, "o2"),
			row("open", undefined, "o2")
		];
		expect(shapes(plan(rows), rows)).toEqual([
			[
				"replay"
			],
			[
				"behind",
				NO_HOLDER
			],
			[
				"replay"
			]
		]);
	});

	it("names the wait a replay is parked on, and a delivery's resource once however many of its deliveries are in flight", () => {
		const rows = [
			row("holding"),
			row("queued", 0)
		];
		const plans = withDeliveries(rows, [
			{
				Key: "Feed",
				OwnerId: "shop",
				EntityId: "shop",
				At: "holding"
			},
			{
				Key: "Feed",
				OwnerId: "shop",
				EntityId: "shop",
				At: "in-line"
			},
			{
				Key: "Feed",
				OwnerId: "o1-l1",
				EntityId: "o1-l1",
				At: "open"
			}
		]);
		const work = [
			{
				key: "Feed",
				ownerId: "shop"
			},
			{
				key: "Feed",
				ownerId: "o1-l1"
			}
		];
		expect(plans).toMatchObject([
			{
				kind: "replay",
				wait: "ask",
				resourceWork: work
			},
			{
				kind: "queued",
				resourceWork: work
			}
		]);
		expect(plans[1]).not.toHaveProperty("wait");
	});

	it("with no delivery in flight, a plan's resourceWork is empty", () => {
		const rows = [
			row("open")
		];
		expect(plan(rows)).toMatchObject([
			{
				kind: "replay",
				resourceWork: []
			}
		]);
	});
});

describe("a resource's delivery beside a row", () => {
	const delivery = (entityId: string, at: IDeliveryAt["At"]): IDeliveryAt => ({
		Key: "Feed",
		OwnerId: entityId,
		EntityId: entityId,
		At: at
	});

	for (const at of [
		"holding",
		"in-line",
		"open"
	] as const) {
		for (const entityId of [
			"o1",
			"shop",
			"o1-l1"
		]) {
			it(`${at} on ${entityId}: a row planned for replay is not dropped for it`, () => {
				const rows = [
					row(at === "holding" && entityId === "o1" ? "open" : "holding")
				];
				expect(
					shapes(
						withDeliveries(rows, [
							delivery(entityId, at)
						]),
						rows
					)
				).toEqual([
					[
						"replay"
					]
				]);
			});
		}
	}

	for (const at of [
		"holding",
		"in-line"
	] as const) {
		it(`${at} on its own entity: a queued row drops behind, the detail naming the resource`, () => {
			const rows = [
				row("holding"),
				row("queued", 0)
			];
			expect(
				shapes(
					withDeliveries(rows, [
						delivery("o1", at)
					]),
					rows
				)
			).toEqual([
				[
					"replay"
				],
				[
					"behind",
					`a delivery of the resource "Feed" on "o1" ${at === "holding" ? "holds its entity" : "stands in its entity's line"}, and it could be put back ahead of it`
				]
			]);
		});
	}

	for (const [where, entityId, at] of [
		[
			"parked inside open(...) on its own entity",
			"o1",
			"open"
		],
		[
			"holding the entity above",
			"shop",
			"holding"
		],
		[
			"in the line of the entity above",
			"shop",
			"in-line"
		],
		[
			"holding an entity below",
			"o1-l1",
			"holding"
		],
		[
			"in the line of an entity below",
			"o1-l1",
			"in-line"
		]
	] as const) {
		it(`${where}: a queued row is still put back behind its replayed holder`, () => {
			const rows = [
				row("holding"),
				row("queued", 0)
			];
			expect(
				shapes(
					withDeliveries(rows, [
						delivery(entityId, at)
					]),
					rows
				)
			).toEqual([
				[
					"replay"
				],
				[
					"queued",
					[
						0
					]
				]
			]);
		});
	}

	for (const [what, deliveries] of [
		[
			"missing, from a writer that didn't know the field",
			undefined
		],
		[
			"null",
			null
		],
		[
			"an object",
			{}
		],
		[
			"an entry with no key",
			[
				{
					OwnerId: "o1",
					EntityId: "o1",
					At: "holding"
				}
			]
		],
		[
			"an entry with an unknown place",
			[
				{
					Key: "Feed",
					OwnerId: "o1",
					EntityId: "o1",
					At: "nearby"
				}
			]
		]
	] as const) {
		it(`Deliveries ${what}: read as work holding the entity that can't be named, so every row on it drops, unlisted`, () => {
			const rows = [
				row("holding"),
				row("open"),
				row("queued", 0)
			];
			expect(shapes(withDeliveries(rows, deliveries), rows)).toEqual([
				[
					"unlisted",
					HOLDS
				],
				[
					"unlisted",
					HOLDS
				],
				[
					"unlisted",
					HOLDS
				]
			]);
		});
	}
});

describe("the drop reasons", () => {
	const reasonsOf = (plans: IPlan[]) =>
		plans.map((planned) =>
			planned.kind === "drop"
				? {
						reason: planned.reason,
						...(planned.wait === undefined
							? {}
							: {
									wait: planned.wait
								}),
						...(planned.ownDoing
							? {
									ownDoing: true
								}
							: {})
					}
				: planned.kind
		);

	it("resume-off: a runtime without the option", () => {
		const rows = [
			row("holding")
		];
		expect(
			reasonsOf(
				planResume({
					rows,
					histories: [],
					resume: false,
					sameBuild: true,
					isIdempotent: () => true,
					lineOf: () => [],
					watched: () => null
				})
			)
		).toEqual([
			{
				reason: "resume-off"
			}
		]);
	});

	it("not-idempotent carries the wait's Type and is the action's own doing; an idempotent wait replays", () => {
		const rows = [
			row("holding")
		];
		const histories = [
			{
				...historyOf(rows[0]!, "none"),
				Entries: [
					{
						Kind: "effect" as const,
						Seq: 1,
						Descriptor: {
							Type: "Shop/Pay"
						}
					}
				]
			}
		];
		const run = (isIdempotent: (type: string) => boolean) =>
			planResume({
				rows,
				histories,
				resume: true,
				sameBuild: true,
				isIdempotent,
				lineOf: (id) => [
					"shop",
					id
				],
				watched: () => null
			});
		expect(reasonsOf(run(() => false))).toEqual([
			{
				reason: "not-idempotent",
				wait: "Shop/Pay",
				ownDoing: true
			}
		]);
		expect(run(() => false)[0]).toMatchObject({
			detail: 'the wait the snapshot caught is "Shop/Pay", which isn\'t declared idempotent'
		});
		expect(run((type) => type === "Shop/Pay")).toMatchObject([
			{
				kind: "replay",
				wait: "Shop/Pay"
			}
		]);
	});

	it("off-list for what the history holds, and for arguments the history can't give back, is the action's own doing; off-list for where it stood is not", () => {
		const rows = [
			row("holding", undefined, "o1"),
			row("holding", undefined, "o2"),
			row("regaining", 0, "o3"),
			row("stopping", undefined, "o4")
		];
		const histories = [
			{
				...historyOf(rows[0]!, "none"),
				Entries: []
			},
			{
				...historyOf(rows[1]!, "none"),
				ArgsExact: false
			},
			historyOf(rows[2]!, "none"),
			historyOf(rows[3]!, "none")
		];
		expect(
			reasonsOf(
				planResume({
					rows,
					histories,
					resume: true,
					sameBuild: true,
					isIdempotent: () => false,
					lineOf: (id) => [
						"shop",
						id
					],
					watched: () => null
				})
			)
		).toEqual([
			{
				reason: "off-list",
				ownDoing: true
			},
			{
				reason: "off-list",
				ownDoing: true
			},
			{
				reason: "off-list"
			},
			{
				reason: "off-list"
			}
		]);
	});

	it("watched: a reactive scope has read what a prefix changes", () => {
		const rows = [
			row("holding")
		];
		const plans = planResume({
			rows,
			histories: [
				historyOf(rows[0]!, "none")
			],
			resume: true,
			sameBuild: true,
			isIdempotent: () => false,
			lineOf: (id) => [
				"shop",
				id
			],
			watched: () => "the tree at Orders"
		});
		expect(shapes(plans, rows)).toEqual([
			[
				"watched",
				"a reactive scope has read the tree at Orders, and would see the replay"
			]
		]);
	});
});
