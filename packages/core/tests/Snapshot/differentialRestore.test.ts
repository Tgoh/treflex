import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IDifferentialOptions, IDifferentialStep } from "../../src/Snapshot/index";
import type { IEffectStub } from "../../src/Testing/createTestRuntime";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionContext } from "../../src/Types/IActionContext";
import type { IEntity } from "../../src/Types/IEntity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineEffect } from "../../src/Effects/defineEffect";
import { entity } from "../../src/Effects/entity";
import { parallel } from "../../src/Effects/parallel";
import { start } from "../../src/Effects/start";
import { bind } from "../../src/Runtime/bind";
import { named } from "../../src/Runtime/named";
import { receiver } from "../../src/Runtime/receiver";
import { transient } from "../../src/Runtime/transient";
import { AsyncSetupError, differentialRestore, dispatchStep, settleStep } from "../../src/Snapshot/index";
import { drainReports } from "../../src/Testing/reports";

declare module "../../src/Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"diff:session": {
			token: string;
		};
	}
}

interface IOrder extends IEntity {
	Amount: number;
	Status: "new" | "charging" | "paid";
	Receipt: string | null;
}

interface INote extends IEntity {
	Text: string;
}

interface IShop extends IEntity {
	Orders: IOrder[];
	Shipped: string[];
	Notes: INote[];
}

const seed: IShop = {
	$Id: "shop",
	Orders: [],
	Shipped: [],
	Notes: []
};

const chargeCard = defineEffect<
	{
		Type: "Diff/Charge";
		Amount: number;
	},
	string
>("Diff/Charge");

const ping = defineEffect<
	{
		Type: "Diff/Ping";
	},
	void
>("Diff/Ping");

function* charge(draft: IOrder): IActionGenerator {
	draft.Status = "charging";
	draft.Receipt = yield* chargeCard({
		Amount: draft.Amount
	});
	draft.Status = "paid";
}
named(charge, "Diff/Charge");

function* placeOrder(draft: IShop, amount: number): IActionGenerator {
	const order = yield* entity<IOrder>({
		Amount: amount,
		Status: "new",
		Receipt: null
	});
	draft.Orders.push(order);
	yield* start(charge, order);
}
named(placeOrder, "Diff/PlaceOrder");

function* audit(_draft: IShop): IActionGenerator {
	yield* ping();
}
named(audit, "Diff/Audit");

function* ship(draft: IShop, orderId: string): IActionGenerator {
	const order = draft.Orders.find((o) => o.$Id === orderId);
	if (order?.Status !== "paid") throw new Error(`${orderId} is not paid`);
	draft.Shipped.push(orderId);
}
named(ship, "Diff/Ship");

function* noop(_draft: IShop): IActionGenerator {}

function* boom(_draft: IShop, label: string): IActionGenerator {
	throw new Error(label);
}

function* note(draft: IShop, text: string): IActionGenerator {
	draft.Notes.push(
		yield* entity<INote>({
			Text: text
		})
	);
}

const stamp = defineEffect<
	{
		Type: "Diff/Stamp";
	},
	number
>("Diff/Stamp");

const readClock = defineEffect<
	{
		Type: "Diff/ReadClock";
	},
	number
>("Diff/ReadClock", {
	settles: "sync"
});

function* takeStamp(draft: IShop): IActionGenerator {
	draft.Notes.push(
		yield* entity<INote>({
			Text: String(yield* stamp())
		})
	);
}
named(takeStamp, "Diff/TakeStamp");

function* readTime(_draft: IShop): IActionGenerator {
	yield* readClock();
}

function* cancelOrders(draft: IShop): IActionGenerator {
	draft.Orders.splice(0);
}
named(cancelOrders, "Diff/CancelOrders");

function* settleOrder(draft: IOrder): IActionGenerator {
	draft.Status = "paid";
}
named(settleOrder, "Diff/SettleOrder");

function* stray(_draft: IShop): IActionGenerator {
	yield* start(noop, "gone");
}

function* sendNote(draft: INote): IActionGenerator {
	yield* ping();
	yield* start(note, "shop", `sent ${draft.Text}`);
}
named(sendNote, "Diff/SendNote");

function* queueNote(draft: IShop, text: string): IActionGenerator {
	const outbox = yield* transient(draft, "Diff/Outbox", {
		Notes: [] as INote[]
	});
	const queued = yield* entity<INote>({
		Text: text
	});
	outbox.Notes.push(queued);
	yield* start(sendNote, queued);
}
named(queueNote, "Diff/QueueNote");

const app = (more: Partial<IDifferentialOptions<IShop>> = {}): IDifferentialOptions<IShop> => ({
	seed,
	hold: [
		chargeCard
	],
	...more
});

const first = (runtime: IRuntime<IShop>): string => runtime.state.Orders[0]!.$Id;

const branch = expect.any(String);

const result = (
	dropped: {
		name: string;
		label: string;
		entityId: string;
		state: string;
	}[]
) =>
	expect.objectContaining({
		dropped: dropped.map((d) => ({
			actionId: branch,
			...d,
			reason: "resume-off"
		}))
	});

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("differentialRestore", () => {
	it("reports which in-flight points a data-only restore ends as the uninterrupted run, and how the others differ", async () => {
		const script: IDifferentialStep<IShop>[] = [
			dispatchStep(audit, "shop"),
			settleStep(ping, {
				value: undefined
			}),
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			settleStep(chargeCard, {
				value: "r-10"
			}),
			dispatchStep(ship, "shop", (runtime) => [
				first(runtime)
			])
		];

		const report = await differentialRestore(
			app({
				hold: [
					chargeCard,
					ping
				]
			}),
			script
		);

		const audited = {
			after: 1,
			inFlight: [
				{
					ActionId: branch,
					Name: "Diff/Audit",
					Label: "audit",
					EntityId: "shop",
					State: "holding"
				}
			],
			snapshot: expect.any(String),
			result: result([
				{
					name: "Diff/Audit",
					label: "audit",
					entityId: "shop",
					state: "holding"
				}
			]),
			skipped: [
				{
					step: 2,
					reason: 'no "Diff/Ping" is held open; open: none'
				}
			],
			differences: {},
			same: true
		};
		const charging = {
			after: 3,
			inFlight: [
				{
					ActionId: branch,
					Name: "Diff/Charge",
					Label: "charge",
					EntityId: "~step3-1",
					State: "holding"
				}
			],
			snapshot: expect.any(String),
			result: result([
				{
					name: "Diff/Charge",
					label: "charge",
					entityId: "~step3-1",
					state: "holding"
				}
			]),
			skipped: [
				{
					step: 4,
					reason: 'no "Diff/Charge" is held open; open: none'
				}
			],
			differences: {
				state: [
					{
						path: "Orders[0].Status",
						expected: "paid",
						actual: "charging"
					},
					{
						path: "Orders[0].Receipt",
						expected: "r-10",
						actual: null
					},
					{
						path: "Shipped[0]",
						expected: "~step3-1",
						actual: undefined
					}
				],
				failures: {
					missing: [],
					extra: [
						{
							Name: "Diff/Ship",
							Label: "ship",
							EntityId: "shop",
							Status: "errored",
							Close: false,
							Taken: true,
							Error: "Error: ~step3-1 is not paid"
						}
					]
				}
			},
			same: false
		};
		expect(report).toEqual({
			steps: 5,
			quiet: 2,
			points: [
				audited,
				charging
			],
			differing: [
				charging
			]
		});
		expect(JSON.parse(report.points[1]!.snapshot).InFlight).toEqual(charging.inFlight);
		expect(drainReports()).toEqual([]);
	});

	it("gives the same report every time", async () => {
		const script = [
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			dispatchStep(
				placeOrder,
				"shop",
				[
					20
				]
			),
			settleStep(
				chargeCard,
				{
					value: "r-10"
				},
				{
					on: first
				}
			),
			settleStep(chargeCard, {
				value: "r-20"
			})
		];
		const once = await differentialRestore(app(), script);
		expect(await differentialRestore(app(), script)).toEqual(once);
	});

	it("names a step's mints for the step in every run, and the restore's own under a name no step mints", async () => {
		const report = await differentialRestore(
			app({
				repair: (runtime) => runtime.dispatch(note, "shop", "restored")
			}),
			[
				dispatchStep(
					placeOrder,
					"shop",
					[
						10
					]
				),
				dispatchStep(
					placeOrder,
					"shop",
					[
						20
					]
				),
				settleStep(
					chargeCard,
					{
						value: "r-20"
					},
					{
						on: "~step2-1"
					}
				),
				settleStep(
					chargeCard,
					{
						value: "r-10"
					},
					{
						on: "~step1-1"
					}
				)
			]
		);
		expect(report.points.map((p) => p.after)).toEqual([
			1,
			2,
			3
		]);
		expect(report.points[0]!.differences.state).toEqual([
			{
				path: "Orders[0].Status",
				expected: "paid",
				actual: "charging"
			},
			{
				path: "Orders[0].Receipt",
				expected: "r-10",
				actual: null
			},
			{
				path: "Notes[0]",
				expected: undefined,
				actual: {
					$Id: "~restore-1",
					Text: "restored"
				}
			}
		]);
	});

	describe("ids across a restore", () => {
		interface IBox extends IEntity {
			Notes: INote[];
			Pending: string[];
			Bumps: number;
		}

		const box: IBox = {
			$Id: "box",
			Notes: [],
			Pending: [],
			Bumps: 0
		};

		const post = defineEffect<
			{
				Type: "Diff/Post";
				Text: string;
			},
			void
		>("Diff/Post");

		function* jot(draft: IBox, text: string): IActionGenerator {
			draft.Notes.push(
				yield* entity<INote>({
					Text: text
				})
			);
		}

		function* jotAfterPost(draft: IBox, text: string): IActionGenerator {
			yield* post({
				Text: text
			});
			yield* jot(draft, text);
		}
		named(jotAfterPost, "Diff/JotAfterPost");

		function* postThenTidy(draft: IBox): IActionGenerator {
			yield* post({
				Text: "temp"
			});
			yield* jot(draft, "temp");
			draft.Notes.pop();
		}
		named(postThenTidy, "Diff/PostThenTidy");

		function* sendText(draft: IBox, text: string): IActionGenerator {
			draft.Pending.push(text);
			try {
				yield* post({
					Text: text
				});
			} catch {
				yield* jot(draft, `failed ${text}`);
			}
			draft.Pending.splice(draft.Pending.indexOf(text), 1);
		}
		named(sendText, "Diff/SendText");

		function* fail(draft: IBox, text: string): IActionGenerator {
			yield* jot(draft, `failed ${text}`);
			draft.Pending.splice(draft.Pending.indexOf(text), 1);
		}

		function* bumpBox(draft: IBox): IActionGenerator {
			draft.Bumps++;
		}

		function* bumpVia(_draft: INote): IActionGenerator {
			yield* start(bumpBox, "box");
		}

		function* clear(draft: IBox): IActionGenerator {
			draft.Notes.splice(0);
		}

		it("shows the effect of a later step that names, by a literal id, an entity the restore lost", async () => {
			const report = await differentialRestore(
				{
					seed: box,
					hold: [
						post
					]
				},
				[
					dispatchStep(jotAfterPost, "box", [
						"x"
					]),
					settleStep(post, {
						value: undefined
					}),
					dispatchStep(jot, "box", [
						"y"
					]),
					dispatchStep(bumpVia, "~step2-1"),
					dispatchStep(clear, "box")
				]
			);
			expect(report.points).toEqual([
				expect.objectContaining({
					after: 1,
					skipped: [
						{
							step: 2,
							reason: 'no "Diff/Post" is held open; open: none'
						},
						{
							step: 4,
							reason: 'no entity "~step2-1" is in the tree'
						}
					],
					differences: {
						state: [
							{
								path: "Bumps",
								expected: 1,
								actual: 0
							}
						]
					},
					same: false
				})
			]);
		});

		it("reads a point as same, with the settle skipped, when the restore dropped work that would have minted an entity and removed it", async () => {
			const report = await differentialRestore(
				{
					seed: box,
					hold: [
						post
					]
				},
				[
					dispatchStep(postThenTidy, "box"),
					settleStep(post, {
						value: undefined
					}),
					dispatchStep(jot, "box", [
						"later"
					])
				]
			);
			expect(
				report.points.map((p) => [
					p.after,
					p.skipped.map((s) => s.step),
					p.differences,
					p.same
				])
			).toEqual([
				[
					1,
					[
						2
					],
					{},
					true
				]
			]);
		});

		it("reads an entity the repair recreates under the restore's name as same when all but its name matches", async () => {
			const report = await differentialRestore(
				{
					seed: box,
					hold: [
						post
					],
					repair: (runtime) => {
						for (const text of [
							...runtime.state.Pending
						]) {
							void runtime.dispatch(fail, "box", text);
						}
					}
				},
				[
					dispatchStep(sendText, "box", [
						"hi"
					]),
					settleStep(post, {
						error: new Error("offline")
					}),
					dispatchStep(jot, "box", [
						"later"
					])
				]
			);
			expect(report.points[0]!.differences).toEqual({});
			expect(report.points[0]!.same).toBe(true);
		});

		it("reads a point as same when dropped work let queued work mint a step earlier", async () => {
			function* idle(_draft: IBox): IActionGenerator {
				yield* post({
					Text: "idle"
				});
			}
			named(idle, "Diff/Idle");
			const report = await differentialRestore(
				{
					seed: box,
					hold: [
						post
					]
				},
				[
					dispatchStep(idle, "box"),
					dispatchStep(jot, "box", [
						"queued"
					]),
					settleStep(post, {
						value: undefined
					})
				]
			);
			const afterIdle = report.points.find((p) => p.after === 1)!;
			expect(afterIdle.result.dropped.map((d) => d.name)).toEqual([
				"Diff/Idle"
			]);
			expect(afterIdle.differences).toEqual({});
		});

		it("names what work the repair restarts mints when a later step settles it for that step, so the point reads same", async () => {
			const report = await differentialRestore(
				{
					seed: box,
					hold: [
						post
					],
					repair: (runtime, outcome) => {
						for (const dropped of outcome.dropped) void runtime.dispatch(jotAfterPost, dropped.entityId, "x");
					}
				},
				[
					dispatchStep(jotAfterPost, "box", [
						"x"
					]),
					settleStep(post, {
						value: undefined
					}),
					dispatchStep(bumpVia, "~step2-1")
				]
			);
			expect(
				report.points.map((p) => [
					p.after,
					p.skipped,
					p.same
				])
			).toEqual([
				[
					1,
					[],
					true
				]
			]);
		});

		it("names setup-n what setup's work mints once a stub answers it, and step 1's first mint step1-1", async () => {
			const fetchText = defineEffect<
				{
					Type: "Diff/Fetch";
				},
				string
			>("Diff/Fetch");
			function* fetchThenJot(draft: IBox): IActionGenerator {
				yield* jot(draft, yield* fetchText());
			}
			let seen: unknown;
			await differentialRestore(
				{
					seed: box,
					effectStubs: {
						[fetchText.Type]: () => Promise.resolve("boot")
					},
					setup: (runtime) => {
						void runtime.dispatch(fetchThenJot, "box");
					}
				},
				[
					dispatchStep(jot, "box", [
						"first"
					]),
					dispatchStep(clear, (runtime) => {
						seen ??= JSON.parse(JSON.stringify(runtime.state.Notes));
						return "box";
					})
				]
			);
			expect(seen).toEqual([
				{
					$Id: "~setup-1",
					Text: "boot"
				},
				{
					$Id: "~step1-1",
					Text: "first"
				}
			]);
		});

		describe("compared by where they sit", () => {
			interface IShelf extends IEntity {
				Pending: string[];
				Notes: INote[];
				Index: Record<string, string>;
				Pinned: string | null;
			}

			const shelf: IShelf = {
				$Id: "shelf",
				Pending: [],
				Notes: [],
				Index: {},
				Pinned: null
			};

			function* file(draft: IShelf, texts: string[], pin: number): IActionGenerator {
				const made: INote[] = [];
				for (const text of texts) {
					const note = yield* entity<INote>({
						Text: text
					});
					draft.Notes.push(note);
					draft.Index[note.$Id] = text;
					made.push(note);
				}
				draft.Pinned = made[pin]?.$Id ?? null;
				draft.Pending.splice(0);
			}

			function* postThenFile(draft: IShelf, texts: string[]): IActionGenerator {
				draft.Pending.push(...texts);
				yield* post({
					Text: texts.join()
				});
				yield* file(draft, texts, 1);
			}
			named(postThenFile, "Diff/PostThenFile");

			const refile = (order: (texts: string[]) => string[], pin = 1): IDifferentialOptions<IShelf>["repair"] => {
				return (runtime) => {
					void runtime.dispatch(
						file,
						"shelf",
						order([
							...runtime.state.Pending
						]),
						pin
					);
				};
			};

			const differencesWith = async (repair: IDifferentialOptions<IShelf>["repair"]) => {
				const report = await differentialRestore(
					{
						seed: shelf,
						hold: [
							post
						],
						repair
					},
					[
						dispatchStep(postThenFile, "shelf", [
							[
								"x",
								"y"
							]
						]),
						settleStep(post, {
							value: undefined
						})
					]
				);
				return report.points[0]!.differences;
			};

			it("reads entities a repair remints, and the fields and keys that hold their ids, as same", async () => {
				expect(await differencesWith(refile((texts) => texts))).toEqual({});
			});

			it("shows a missing entity, an extra one and two swapped, with each run's own ids", async () => {
				expect((await differencesWith(refile((texts) => texts.slice(0, 1), 0))).state).toEqual([
					{
						path: "Notes[1]",
						expected: {
							$Id: "~step2-2",
							Text: "y"
						},
						actual: undefined
					},
					{
						path: "Index.~step2-2",
						expected: "y",
						actual: undefined
					},
					{
						path: "Pinned",
						expected: "~step2-2",
						actual: "~restore-1"
					}
				]);
				expect(
					(
						await differencesWith(
							refile((texts) => [
								...texts,
								"z"
							])
						)
					).state
				).toEqual([
					{
						path: "Notes[2]",
						expected: undefined,
						actual: {
							$Id: "~restore-3",
							Text: "z"
						}
					},
					{
						path: "Index.~restore-3",
						expected: undefined,
						actual: "z"
					}
				]);
				expect((await differencesWith(refile((texts) => texts.reverse(), 0))).state).toEqual([
					{
						path: "Notes[0].Text",
						expected: "x",
						actual: "y"
					},
					{
						path: "Notes[1].Text",
						expected: "y",
						actual: "x"
					},
					{
						path: "Index.~step2-1",
						expected: "x",
						actual: "y"
					},
					{
						path: "Index.~step2-2",
						expected: "y",
						actual: "x"
					},
					{
						path: "Pinned",
						expected: "~step2-2",
						actual: "~restore-1"
					}
				]);
			});

			it("shows a field that holds another entity's id than the uninterrupted run's", async () => {
				expect(await differencesWith(refile((texts) => texts, 0))).toEqual({
					state: [
						{
							path: "Pinned",
							expected: "~step2-2",
							actual: "~restore-1"
						}
					]
				});
			});

			it("shows a field that holds the id of an entity sitting at another place in the restored run, with the real ids", async () => {
				const state = (await differencesWith(refile((texts) => texts.reverse(), 0))).state!;
				expect(state.filter((d) => d.path.startsWith("Notes"))).toEqual([
					{
						path: "Notes[0].Text",
						expected: "x",
						actual: "y"
					},
					{
						path: "Notes[1].Text",
						expected: "y",
						actual: "x"
					}
				]);
				expect(state.find((d) => d.path === "Pinned")).toEqual({
					path: "Pinned",
					expected: "~step2-2",
					actual: "~restore-1"
				});
			});

			describe("one entity missing early in a list", () => {
				interface IPair extends IEntity {
					Notes: INote[];
					Aside: INote[];
					Pinned: string | null;
				}
				function* noteAfterPost(draft: IPair, text: string): IActionGenerator {
					yield* post({
						Text: text
					});
					draft.Notes.push(
						yield* entity<INote>({
							Text: text
						})
					);
				}
				named(noteAfterPost, "Diff/NoteAfterPost");
				function* noteIn(draft: IPair, list: "Notes" | "Aside", text: string): IActionGenerator {
					draft[list].push(
						yield* entity<INote>({
							Text: text
						})
					);
				}
				function* pin(draft: IPair, text: string): IActionGenerator {
					draft.Pinned = draft.Notes.find((note) => note.Text === text)!.$Id;
				}
				const pair: IPair = {
					$Id: "pair",
					Notes: [],
					Aside: [],
					Pinned: null
				};
				const stateAfter = async (...more: IDifferentialStep<IPair>[]) => {
					const report = await differentialRestore(
						{
							seed: pair,
							hold: [
								post
							]
						},
						[
							dispatchStep(noteAfterPost, "pair", [
								"a"
							]),
							settleStep(post, {
								value: undefined
							}),
							dispatchStep(noteIn, "pair", [
								"Notes",
								"b"
							]),
							dispatchStep(noteIn, "pair", [
								"Notes",
								"c"
							]),
							dispatchStep(noteIn, "pair", [
								"Aside",
								"d"
							]),
							...more
						]
					);
					return report.points[0]!.differences.state!;
				};
				const listDifferences = [
					{
						path: "Notes[0].Text",
						expected: "a",
						actual: "b"
					},
					{
						path: "Notes[1].Text",
						expected: "b",
						actual: "c"
					},
					{
						path: "Notes[2]",
						expected: {
							$Id: "~step4-1",
							Text: "c"
						},
						actual: undefined
					}
				];

				it("shows the list's differences, and nothing about the entities in a later list", async () => {
					const state = await stateAfter();
					expect(state).toEqual(listDifferences);
					expect(state.filter((d) => d.expected === d.actual)).toEqual([]);
				});

				it("shows a field that holds the id of a later entity in the list, the same in both runs, since position-by-position comparison names its neighbour", async () => {
					expect(
						await stateAfter(
							dispatchStep(pin, "pair", [
								"c"
							])
						)
					).toEqual([
						...listDifferences,
						{
							path: "Pinned",
							expected: "~step4-1",
							actual: "~step4-1"
						}
					]);
				});
			});

			it("reads two failures on entities no longer in the tree, raised in the other order, as same", async () => {
				function* boom(draft: INote): IActionGenerator {
					throw new Error(draft.Text);
				}
				named(boom, "Diff/Boom");
				function* noteBothAndFail(draft: IShelf, order: number[]): IActionGenerator {
					const made: INote[] = [];
					for (const text of [
						"x",
						"y"
					]) {
						const note = yield* entity<INote>({
							Text: text
						});
						draft.Notes.push(note);
						made.push(note);
					}
					for (const i of order) {
						yield* start(boom, made[i]!);
					}
				}
				function* postThenFail(draft: IShelf): IActionGenerator {
					yield* post({
						Text: "fail"
					});
					yield* noteBothAndFail(
						draft,
						[
							0,
							1
						]
					);
				}
				named(postThenFail, "Diff/PostThenFail");
				function* empty(draft: IShelf): IActionGenerator {
					draft.Notes.splice(0);
				}
				const report = await differentialRestore(
					{
						seed: shelf,
						hold: [
							post
						],
						options: {
							allowFailures: [
								boom
							]
						},
						repair: (runtime) => {
							void runtime.dispatch(
								noteBothAndFail,
								"shelf",
								[
									1,
									0
								]
							);
						}
					},
					[
						dispatchStep(postThenFail, "shelf"),
						settleStep(post, {
							value: undefined
						}),
						dispatchStep(empty, "shelf")
					]
				);
				expect(report.points[0]!.differences).toEqual({});
				expect(report.points[0]!.same).toBe(true);
			});
		});

		describe("paired between the two runs", () => {
			type ITree = IEntity & Record<string, any>;
			type IBuild = (draft: ITree) => IActionGenerator;

			function* mint(fields: Record<string, unknown>): IActionGenerator<ITree> {
				return yield* entity<ITree>(fields);
			}

			function* boomOn(_draft: ITree): IActionGenerator {
				throw new Error("boom");
			}
			named(boomOn, "Diff/BoomOn");

			const pointOf = async (fields: Record<string, unknown>, uninterrupted: IBuild, restored: IBuild) => {
				function* go(draft: ITree): IActionGenerator {
					yield* post({
						Text: "go"
					});
					yield* uninterrupted(draft);
				}
				named(go, "Diff/Go");
				function* rebuild(draft: ITree): IActionGenerator {
					yield* restored(draft);
				}
				const report = await differentialRestore<ITree>(
					{
						seed: {
							$Id: "root",
							...fields
						},
						hold: [
							post
						],
						options: {
							allowFailures: [
								boomOn
							]
						},
						repair: (runtime) => {
							void runtime.dispatch(rebuild, "root").catch(() => {});
						}
					},
					[
						dispatchStep(go, "root"),
						settleStep(post, {
							value: undefined
						})
					]
				);
				return report.points[0]!;
			};

			it("shows a map from one entity to another that the restored run links the other way round", async () => {
				const link = (from: number, to: number) =>
					function* (draft: ITree): IActionGenerator {
						const made = [
							yield* mint({
								Name: "folder"
							}),
							yield* mint({
								Name: "file"
							})
						];
						draft.Items.push(...made);
						draft.ParentOf[made[from]!.$Id] = made[to]!.$Id;
					};
				const point = await pointOf(
					{
						ParentOf: {},
						Items: []
					},
					link(1, 0),
					link(0, 1)
				);
				expect(point.differences).toEqual({
					state: [
						{
							path: "ParentOf.~step2-2",
							expected: "~step2-1",
							actual: undefined
						},
						{
							path: "ParentOf.~restore-1",
							expected: undefined,
							actual: "~restore-2"
						}
					]
				});
			});

			describe("an id-keyed store built in another order", () => {
				const store = (order: number[], list: boolean) =>
					function* (draft: ITree): IActionGenerator {
						const made = [
							yield* mint({
								Title: "a"
							}),
							yield* mint({
								Title: "b"
							})
						];
						if (list) {
							draft.Items.push(...made);
						}
						for (const i of order) {
							draft.ById[made[i]!.$Id] = list ? made[i]!.Title : made[i];
						}
					};
				const fields = () => ({
					ById: {},
					Items: []
				});

				it("reads same when its entities sit in a list", async () => {
					const point = await pointOf(
						fields(),
						store(
							[
								0,
								1
							],
							true
						),
						store(
							[
								1,
								0
							],
							true
						)
					);
					expect(point.differences).toEqual({});
				});

				it("matches entities that live only in the store in the order they were added, so their contents differ", async () => {
					const point = await pointOf(
						fields(),
						store(
							[
								0,
								1
							],
							false
						),
						store(
							[
								1,
								0
							],
							false
						)
					);
					expect(point.differences.state).toEqual([
						{
							path: "ById.~step2-1.Title",
							expected: "a",
							actual: "b"
						},
						{
							path: "ById.~step2-2.Title",
							expected: "b",
							actual: "a"
						}
					]);
				});

				it("reads same when a list holds its ids, though no entity sits in a list", async () => {
					const normalised = (order: number[]) =>
						function* (draft: ITree): IActionGenerator {
							const made = [
								yield* mint({
									Title: "a"
								}),
								yield* mint({
									Title: "b"
								})
							];
							for (const i of order) {
								draft.ById[made[i]!.$Id] = made[i];
							}
							draft.AllIds = made.map((m) => m.$Id);
						};
					const point = await pointOf(
						{
							ById: {},
							AllIds: []
						},
						normalised([
							0,
							1
						]),
						normalised([
							1,
							0
						])
					);
					expect(point.differences).toEqual({});
				});

				describe("two maps keyed by the same ids, one built in another order", () => {
					const twoMaps = (agesOrder: number[], list: boolean) =>
						function* (draft: ITree): IActionGenerator {
							const ids = [
								(yield* mint({})).$Id,
								(yield* mint({})).$Id
							];
							for (const i of [
								0,
								1
							]) {
								draft.Names[ids[i]!] = `n${i}`;
							}
							for (const i of agesOrder) {
								draft.Ages[ids[i]!] = i;
							}
							if (list) {
								draft.Ids = ids;
							}
						};
					const differencesWith = async (fields: Record<string, unknown>, list: boolean) =>
						(
							await pointOf(
								fields,
								twoMaps(
									[
										0,
										1
									],
									list
								),
								twoMaps(
									[
										1,
										0
									],
									list
								)
							)
						).differences;

					it("reads same whichever map the uninterrupted run added first when a list holds the ids", async () => {
						expect(
							await differencesWith(
								{
									Names: {},
									Ages: {}
								},
								true
							)
						).toEqual({});
						expect(
							await differencesWith(
								{
									Ages: {},
									Names: {}
								},
								true
							)
						).toEqual({});
					});

					it("matches the keys in the order the first map was added when nothing else holds the ids", async () => {
						expect(
							await differencesWith(
								{
									Names: {},
									Ages: {}
								},
								false
							)
						).toEqual({});
						expect(
							(
								await differencesWith(
									{
										Ages: {},
										Names: {}
									},
									false
								)
							).state
						).toEqual([
							{
								path: "Ages.~step2-1",
								expected: 0,
								actual: 1
							},
							{
								path: "Ages.~step2-2",
								expected: 1,
								actual: 0
							},
							{
								path: "Names.~step2-1",
								expected: "n0",
								actual: "n1"
							},
							{
								path: "Names.~step2-2",
								expected: "n1",
								actual: "n0"
							}
						]);
					});
				});
			});

			it("shows one extra entry early in an id-keyed store whose entities sit in a list as that entry alone", async () => {
				const fill = (extra: boolean) =>
					function* (draft: ITree): IActionGenerator {
						if (extra) {
							const made = yield* mint({
								Title: "extra"
							});
							draft.ById[made.$Id] = made.Title;
						}
						for (const title of [
							"a",
							"b",
							"c"
						]) {
							const made = yield* mint({
								Title: title
							});
							draft.Items.push(made);
							draft.ById[made.$Id] = title;
						}
					};
				const point = await pointOf(
					{
						ById: {},
						Items: []
					},
					fill(false),
					fill(true)
				);
				expect(point.differences).toEqual({
					state: [
						{
							path: "ById.~restore-1",
							expected: undefined,
							actual: "extra"
						}
					]
				});
			});

			it("reads the same fields added in another order as same", async () => {
				const point = await pointOf(
					{},
					function* (draft) {
						const made = yield* mint({
							N: 1
						});
						draft.Items = [
							made
						];
						draft.Sel = made.$Id;
					},
					function* (draft) {
						const made = yield* mint({
							N: 1
						});
						draft.Sel = made.$Id;
						draft.Items = [
							made
						];
					}
				);
				expect(point.differences).toEqual({});
			});

			it("shows a selection moved to another entity at the selection, though it comes before the list", async () => {
				const pick = (at: number) =>
					function* (draft: ITree): IActionGenerator {
						const made = [
							yield* mint({
								N: 1
							}),
							yield* mint({
								N: 1
							})
						];
						draft.Items.push(...made);
						draft.Sel = made[at]!.$Id;
					};
				const point = await pointOf(
					{
						Sel: null,
						Items: []
					},
					pick(0),
					pick(1)
				);
				expect(point.differences).toEqual({
					state: [
						{
							path: "Sel",
							expected: "~step2-1",
							actual: "~restore-2"
						}
					]
				});
			});

			it("shows a selection left on an entity the restored run no longer has at the selection", async () => {
				const point = await pointOf(
					{
						Sel: null,
						Items: []
					},
					function* (draft) {
						const made = yield* mint({
							N: 1
						});
						draft.Items.push(made);
						draft.Sel = made.$Id;
					},
					function* (draft) {
						const made = yield* mint({
							N: 1
						});
						const gone = yield* mint({
							N: 1
						});
						draft.Items.push(made);
						draft.Sel = gone.$Id;
					}
				);
				expect(point.differences).toEqual({
					state: [
						{
							path: "Sel",
							expected: "~step2-1",
							actual: "~restore-2"
						}
					]
				});
			});

			it("shows two entities that swap places with their contents, and reads one the repair recreates in place as same", async () => {
				const place = (order: number[]) =>
					function* (draft: ITree): IActionGenerator {
						const made = [
							yield* mint({
								N: 1
							}),
							yield* mint({
								N: 2
							})
						];
						draft.Items.push(...order.map((i) => made[i]));
					};
				const fields = () => ({
					Items: []
				});
				expect(
					(
						await pointOf(
							fields(),
							place([
								0,
								1
							]),
							place([
								1,
								0
							])
						)
					).differences
				).toEqual({
					state: [
						{
							path: "Items[0].N",
							expected: 1,
							actual: 2
						},
						{
							path: "Items[1].N",
							expected: 2,
							actual: 1
						}
					]
				});
				expect(
					(
						await pointOf(
							fields(),
							place([
								0,
								1
							]),
							place([
								0,
								1
							])
						)
					).same
				).toBe(true);
			});

			it("can't be made to read two different trees as same by keys spelled with a dot", async () => {
				const point = await pointOf(
					{
						"x.y": null,
						x: {
							y: null
						},
						Sel: null
					},
					function* (draft) {
						const a = yield* mint({
							N: 1
						});
						const b = yield* mint({
							N: 2
						});
						draft["x.y"] = a.$Id;
						draft.x.y = b.$Id;
						draft.Sel = a.$Id;
					},
					function* (draft) {
						const a = yield* mint({
							N: 1
						});
						const b = yield* mint({
							N: 2
						});
						draft["x.y"] = a.$Id;
						draft.x.y = b.$Id;
						draft.Sel = b.$Id;
					}
				);
				expect(point.differences).toEqual({
					state: [
						{
							path: "Sel",
							expected: "~step2-1",
							actual: "~restore-2"
						}
					]
				});
			});

			it("compares the entity an event names through the pairing", async () => {
				const failOn = (at: number) =>
					function* (draft: ITree): IActionGenerator {
						const made = [
							yield* mint({
								N: 1
							}),
							yield* mint({
								N: 1
							})
						];
						draft.Sel = made[0]!.$Id;
						draft.Items.push(...made);
						yield* start(boomOn, made[at]!);
					};
				const fields = () => ({
					Sel: null,
					Items: []
				});
				expect((await pointOf(fields(), failOn(0), failOn(0))).differences).toEqual({});
				const failure = (entityId: string) => ({
					Name: "Diff/BoomOn",
					Label: "boomOn",
					EntityId: entityId,
					Status: "errored",
					Close: false,
					Taken: true,
					Error: "Error: boom"
				});
				expect((await pointOf(fields(), failOn(0), failOn(1))).differences).toEqual({
					failures: {
						missing: [
							failure("~step2-1")
						],
						extra: [
							failure("~restore-2")
						]
					}
				});
			});
		});

		describe("that existed at the point", () => {
			type ITree = IEntity & Record<string, any>;
			type IBuild = (draft: ITree) => IActionGenerator;

			function* mint(fields: Record<string, unknown>): IActionGenerator<ITree> {
				return yield* entity<ITree>(fields);
			}

			const pointOf = async (before: IBuild, uninterrupted: IBuild, restored: IBuild) => {
				function* go(draft: ITree): IActionGenerator {
					yield* before(draft);
					yield* post({
						Text: "go"
					});
					yield* uninterrupted(draft);
				}
				named(go, "Diff/GoAfterMint");
				function* rebuild(draft: ITree): IActionGenerator {
					yield* restored(draft);
				}
				const report = await differentialRestore<ITree>(
					{
						seed: {
							$Id: "root",
							L: [],
							M: []
						},
						hold: [
							post
						],
						repair: (runtime) => {
							void runtime.dispatch(rebuild, "root").catch(() => {});
						}
					},
					[
						dispatchStep(go, "root"),
						settleStep(post, {
							value: undefined
						})
					]
				);
				return report.points[0]!;
			};

			const one: IBuild = function* (draft) {
				draft.L.push(
					yield* mint({
						Text: "kept"
					})
				);
			};

			const finish: IBuild = function* (draft) {
				draft.Done = true;
			};

			it("shows a repair that replaces one with a new entity of equal contents at its $Id", async () => {
				const point = await pointOf(one, finish, function* (draft) {
					draft.L.splice(0);
					draft.L.push(
						yield* mint({
							Text: "kept"
						})
					);
					draft.Done = true;
				});
				expect(point.differences).toEqual({
					state: [
						{
							path: "L[0].$Id",
							expected: "~step1-1",
							actual: "~restore-1"
						}
					]
				});
			});

			it("shows two that swap places with the fields their places give them at their $Ids", async () => {
				const rank: IBuild = function* (draft) {
					draft.L.forEach((e: ITree, i: number) => {
						e.Rank = i;
					});
				};
				const point = await pointOf(
					function* (draft) {
						draft.L.push(
							yield* mint({
								Rank: -1
							}),
							yield* mint({
								Rank: -1
							})
						);
					},
					rank,
					function* (draft) {
						draft.L.reverse();
						yield* rank(draft);
					}
				);
				expect(point.differences).toEqual({
					state: [
						{
							path: "L[0].$Id",
							expected: "~step1-1",
							actual: "~step1-2"
						},
						{
							path: "L[1].$Id",
							expected: "~step1-2",
							actual: "~step1-1"
						}
					]
				});
			});

			it("shows a new entity that takes the place of one which sits elsewhere in the restored run", async () => {
				const point = await pointOf(
					function* (draft) {
						draft.L.push(
							yield* mint({
								V: "a"
							})
						);
					},
					function* (draft) {
						draft.L.push(
							yield* mint({
								V: "b"
							})
						);
					},
					function* (draft) {
						draft.L[0].V = "b";
						draft.L.unshift(
							yield* mint({
								V: "a"
							})
						);
					}
				);
				expect(point.differences).toEqual({
					state: [
						{
							path: "L[0].$Id",
							expected: "~step1-1",
							actual: "~restore-1"
						},
						{
							path: "L[1].$Id",
							expected: "~step2-1",
							actual: "~step1-1"
						}
					]
				});
			});

			it("reads one nothing touches as same, beside entities each run minted after the point under its own names", async () => {
				const more: IBuild = function* (draft) {
					draft.L.push(
						yield* mint({
							Text: "new"
						})
					);
				};
				const point = await pointOf(one, more, more);
				expect(point.differences).toEqual({});
			});

			it("shows one the restored run removes at its place", async () => {
				const point = await pointOf(one, finish, function* (draft) {
					draft.L.splice(0);
					draft.Done = true;
				});
				expect(point.differences).toEqual({
					state: [
						{
							path: "L[0]",
							expected: {
								$Id: "~step1-1",
								Text: "kept"
							},
							actual: undefined
						}
					]
				});
			});

			it("shows one the restored run moves to another list at both places", async () => {
				const point = await pointOf(one, finish, function* (draft) {
					draft.M.push(draft.L.splice(0)[0]);
					draft.Done = true;
				});
				expect(point.differences).toEqual({
					state: [
						{
							path: "L[0]",
							expected: {
								$Id: "~step1-1",
								Text: "kept"
							},
							actual: undefined
						},
						{
							path: "M[0]",
							expected: undefined,
							actual: {
								$Id: "~step1-1",
								Text: "kept"
							}
						}
					]
				});
			});
		});
	});

	describe("each kind of difference", () => {
		const placeAndPay = (
			outcome:
				| {
						value: string;
				  }
				| {
						error: unknown;
				  }
		) => [
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			settleStep(chargeCard, outcome)
		];

		it("a diag the restored run raises", async () => {
			const report = await differentialRestore(
				app({
					repair: (runtime) => runtime.dispatch(noop, "gone").catch(() => {})
				}),
				placeAndPay({
					value: "r-10"
				})
			);
			expect(report.points[0]!.differences.diags).toEqual({
				missing: [],
				extra: [
					{
						code: "dispatch/unresolved-entity",
						severity: "warn",
						message: expect.stringContaining('no entity "gone"')
					}
				]
			});
			expect(drainReports()).toEqual([]);
		});

		it("a diag the restore raises as it loads, such as a binding whose receiver its setup doesn't register", async () => {
			const Listener = receiver<IShop>("Diff/Listener")({
				["Diff/Heard" as any]: function* () {}
			});
			function* listenThenCharge(draft: IShop): IActionGenerator {
				bind(draft, Listener);
				yield* placeOrder(draft, 10);
			}
			let calls = 0;
			const report = await differentialRestore(
				app({
					setup: (runtime) => {
						if (++calls < 3) runtime.registerReceiver(Listener);
					}
				}),
				[
					dispatchStep(listenThenCharge, "shop"),
					settleStep(chargeCard, {
						value: "r-10"
					})
				]
			);
			const diags = report.points[0]!.differences.diags!;
			expect(diags.missing).toEqual([]);
			expect(diags.extra.map((d) => d.code)).toEqual([
				"restore/unresolved-receiver",
				"receiver/unresolved"
			]);
		});

		it("a failure the uninterrupted run has and the restored one doesn't, with no onError kind when the app passes no onError", async () => {
			const report = await differentialRestore(
				app({
					options: {
						allowFailures: [
							charge
						]
					}
				}),
				placeAndPay({
					error: new Error("declined")
				})
			);
			expect(report.points[0]!.differences).toEqual({
				failures: {
					missing: [
						{
							Name: "Diff/Charge",
							Label: "charge",
							EntityId: "~step1-1",
							Status: "errored",
							Close: false,
							Taken: true,
							Error: "Error: declined"
						}
					],
					extra: []
				}
			});
		});

		it("the calls the app's onError received, when it passes one", async () => {
			const calls: string[] = [];
			const report = await differentialRestore(
				app({
					options: {
						allowFailures: [
							charge
						],
						onError: (error) => {
							calls.push(String(error));
						}
					}
				}),
				placeAndPay({
					error: new Error("declined")
				})
			);
			expect(report.points[0]!.differences.onError).toEqual({
				missing: [
					{
						Name: "Diff/Charge",
						Label: "charge",
						EntityId: "~step1-1",
						Error: "Error: declined"
					}
				],
				extra: []
			});
			expect(calls).toEqual([
				"Error: declined"
			]);
		});

		it("a repair that throws", async () => {
			const report = await differentialRestore(
				app({
					hold: [
						ping
					],
					repair: () => {
						throw new Error("repair broke");
					}
				}),
				[
					dispatchStep(audit, "shop"),
					settleStep(ping, {
						value: undefined
					})
				]
			);
			expect(report.points[0]!.result.repairError).toBeInstanceOf(Error);
			expect(report.points[0]!.differences).toEqual({
				repairError: "Error: repair broke"
			});
			expect(report.differing).toHaveLength(1);
		});

		it("a restored run that ends with work in flight and effects still held, though nothing else differs", async () => {
			const report = await differentialRestore(
				app({
					hold: [
						ping
					],
					repair: (runtime) => {
						void runtime.dispatch(audit, "shop");
						void runtime.dispatch(audit, "shop");
					}
				}),
				[
					dispatchStep(audit, "shop"),
					settleStep(ping, {
						value: undefined
					})
				]
			);
			const point = report.points[0]!;
			expect(point.skipped).toEqual([]);
			expect(point.differences).toEqual({
				unfinished: {
					inFlight: [
						{
							Name: "Diff/Audit",
							Label: "audit",
							EntityId: "shop",
							State: "holding"
						}
					],
					held: [
						{
							Type: "Diff/Ping",
							EntityId: "shop"
						}
					]
				}
			});
			expect(point.same).toBe(false);
		});

		it("a restored run that ends with work in flight and nothing held", async () => {
			const report = await differentialRestore(
				app({
					hold: [
						ping
					],
					effectStubs: () => ({
						[stamp.Type]: () => new Promise<number>(() => {})
					}),
					repair: (runtime) => {
						void runtime.dispatch(takeStamp, "shop");
					}
				}),
				[
					dispatchStep(audit, "shop"),
					settleStep(ping, {
						value: undefined
					})
				]
			);
			expect(report.points[0]!.differences).toEqual({
				unfinished: {
					inFlight: [
						{
							Name: "Diff/TakeStamp",
							Label: "takeStamp",
							EntityId: "shop",
							State: "holding"
						}
					],
					held: []
				}
			});
		});

		it("an event the restored run raises twice and the uninterrupted run once, as one extra", async () => {
			const report = await differentialRestore(
				app({
					hold: [
						ping
					],
					options: {
						allowFailures: [
							boom
						]
					},
					repair: (runtime) => {
						void runtime.dispatch(boom, "shop", "a");
					}
				}),
				[
					dispatchStep(audit, "shop"),
					settleStep(ping, {
						value: undefined
					}),
					dispatchStep(boom, "shop", [
						"a"
					])
				]
			);
			expect(report.points[0]!.differences).toEqual({
				failures: {
					missing: [],
					extra: [
						expect.objectContaining({
							Label: "boom",
							Error: "Error: a"
						})
					]
				}
			});
		});

		it("a repair that restarts the dropped work twice leaves the second running", async () => {
			const report = await differentialRestore(
				app({
					repair: (runtime, outcome) => {
						for (const dropped of outcome.dropped) {
							void runtime.dispatch(charge, dropped.entityId);
							void runtime.dispatch(charge, dropped.entityId);
						}
					}
				}),
				placeAndPay({
					value: "r-10"
				})
			);
			expect(report.points[0]!.differences.unfinished).toEqual({
				inFlight: [
					{
						Name: "Diff/Charge",
						Label: "charge",
						EntityId: "~step1-1",
						State: "holding"
					}
				],
				held: [
					{
						Type: "Diff/Charge",
						EntityId: "~step1-1"
					}
				]
			});
		});

		it("an onError that throws in the restored run is recorded, not reported", async () => {
			const report = await differentialRestore(
				app({
					options: {
						onError: () => {
							throw new Error("onError broke");
						}
					}
				}),
				[
					...placeAndPay({
						value: "r-10"
					}),
					dispatchStep(ship, "shop", (runtime) => [
						first(runtime)
					])
				]
			);
			expect(report.points[0]!.differences.onError?.extra).toEqual([
				{
					Name: "Diff/Ship",
					Label: "ship",
					EntityId: "shop",
					Error: "Error: ~step1-1 is not paid",
					Threw: "Error: onError broke"
				}
			]);
			expect(drainReports()).toEqual([]);
		});

		it("an onError that throws in the uninterrupted run fails the test", async () => {
			await differentialRestore(
				app({
					hold: [],
					options: {
						allowFailures: [
							ship
						],
						onError: () => {
							throw new Error("onError broke");
						}
					}
				}),
				[
					dispatchStep(ship, "shop", [
						"~id-9"
					])
				]
			);
			expect(drainReports().map((r) => (r as Error).message)).toEqual([
				expect.stringContaining('[treflex] differentialRestore: onError threw while taking the failure of action "Diff/Ship"')
			]);
		});

		it("a diag the uninterrupted run raises that options don't allow fails the test, naming differentialRestore as the call to pass them to", async () => {
			await differentialRestore(
				app({
					hold: []
				}),
				[
					dispatchStep(stray, "shop")
				]
			);
			expect(drainReports().map((r) => (r as Error).message)).toEqual([
				expect.stringContaining(
					'[treflex] differentialRestore: an unexpected diag, "dispatch/unresolved-entity". If the test expects it, pass options: { allowDiags: ["dispatch/unresolved-entity"] } to differentialRestore'
				)
			]);
		});

		it("not the order of the events, so a restored run that raises the same two in the other order is the same", async () => {
			let uninterrupted: IRuntime<IShop> | undefined;
			const report = await differentialRestore(
				app({
					hold: [
						ping
					],
					options: {
						allowFailures: [
							boom
						]
					},
					setup: (runtime) => {
						uninterrupted ??= runtime;
					},
					repair: (runtime) => {
						void runtime.dispatch(boom, "shop", "b");
					}
				}),
				[
					dispatchStep(audit, "shop"),
					settleStep(ping, {
						value: undefined
					}),
					dispatchStep(boom, "shop", [
						"a"
					]),
					dispatchStep(boom, (runtime) => (runtime === uninterrupted ? "shop" : "nowhere"), [
						"b"
					])
				]
			);
			expect(report.points).toEqual([
				expect.objectContaining({
					after: 1,
					skipped: [
						expect.objectContaining({
							step: 2
						}),
						expect.objectContaining({
							step: 4
						})
					],
					differences: {},
					same: true
				})
			]);
		});

		it("only what was raised after the point, so the uninterrupted run's earlier diag, failure and onError call are not missing", async () => {
			const report = await differentialRestore(
				app({
					options: {
						allowDiags: [
							"dispatch/unresolved-entity"
						],
						allowFailures: [
							ship
						],
						onError: () => {}
					}
				}),
				[
					dispatchStep(stray, "shop"),
					dispatchStep(ship, "shop", [
						"~id-9"
					]),
					...placeAndPay({
						value: "r-10"
					})
				]
			);
			expect(report.quiet).toBe(2);
			expect(
				report.points.map((p) => [
					p.after,
					Object.keys(p.differences)
				])
			).toEqual([
				[
					3,
					[
						"state"
					]
				]
			]);
		});
	});

	describe("two held effects of one type", () => {
		const script = (last: IDifferentialStep<IShop>) => [
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			dispatchStep(
				placeOrder,
				"shop",
				[
					20
				]
			),
			settleStep(
				chargeCard,
				{
					value: "r-20"
				},
				{
					on: (runtime: IRuntime<IShop>) => runtime.state.Orders[1]!.$Id
				}
			),
			last
		];

		it("settles the one its on and where pick", async () => {
			const report = await differentialRestore(
				app(),
				script(
					settleStep(
						chargeCard,
						{
							value: "r-10"
						},
						{
							where: (effect) => effect.Amount === 10
						}
					)
				)
			);
			expect(
				report.points.map((p) => [
					p.after,
					p.differences.state?.map((d) => `${d.path}: ${String(d.expected)}`)
				])
			).toEqual([
				[
					1,
					[
						"Orders[0].Status: paid",
						"Orders[0].Receipt: r-10"
					]
				],
				[
					2,
					[
						"Orders[0].Status: paid",
						"Orders[0].Receipt: r-10",
						"Orders[1].Status: paid",
						"Orders[1].Receipt: r-20"
					]
				],
				[
					3,
					[
						"Orders[0].Status: paid",
						"Orders[0].Receipt: r-10"
					]
				]
			]);
		});

		it("settles by where alone two open on different entities", async () => {
			const report = await differentialRestore(app(), [
				dispatchStep(
					placeOrder,
					"shop",
					[
						10
					]
				),
				dispatchStep(
					placeOrder,
					"shop",
					[
						20
					]
				),
				settleStep(
					chargeCard,
					{
						value: "r-20"
					},
					{
						where: (effect) => effect.Amount === 20
					}
				),
				settleStep(
					chargeCard,
					{
						value: "r-10"
					},
					{
						where: (effect) => effect.Amount === 10
					}
				)
			]);
			expect(
				report.points.map((p) => [
					p.after,
					p.skipped.map((s) => s.step)
				])
			).toEqual([
				[
					1,
					[
						4
					]
				],
				[
					2,
					[
						3,
						4
					]
				],
				[
					3,
					[
						4
					]
				]
			]);
		});

		it("skips a settle in a restored run whose where throws, and rejects one that throws uninterrupted", async () => {
			const where = (effect: { Amount: number }) => {
				if (effect.Amount === 99) throw new Error("no 99");
				return effect.Amount === 10;
			};
			const report = await differentialRestore(
				app({
					repair: (runtime) => {
						void runtime.dispatch(placeOrder, "shop", 99);
					}
				}),
				[
					dispatchStep(
						placeOrder,
						"shop",
						[
							10
						]
					),
					settleStep(
						chargeCard,
						{
							value: "r-10"
						},
						{
							where
						}
					)
				]
			);
			expect(report.points[0]!.skipped).toEqual([
				{
					step: 2,
					reason: "its where threw: Error: no 99"
				}
			]);
			await expect(
				differentialRestore(app(), [
					dispatchStep(
						placeOrder,
						"shop",
						[
							99
						]
					),
					settleStep(
						chargeCard,
						{
							value: "r"
						},
						{
							where
						}
					)
				])
			).rejects.toThrow(
				'[treflex] differentialRestore: step 2, settle "Diff/Charge", can\'t run uninterrupted: its where threw: Error: no 99.'
			);
		});

		it("rejects a settle that matches both", async () => {
			await expect(
				differentialRestore(app(), [
					dispatchStep(
						placeOrder,
						"shop",
						[
							10
						]
					),
					dispatchStep(
						placeOrder,
						"shop",
						[
							20
						]
					),
					settleStep(chargeCard, {
						value: "r"
					})
				])
			).rejects.toThrow(
				'[treflex] differentialRestore: step 3, settle "Diff/Charge", can\'t run uninterrupted: 2 "Diff/Charge" are held open, so it is ambiguous: ' +
					'"Diff/Charge" on "~step1-1" {"Amount":10,"Type":"Diff/Charge"}, "Diff/Charge" on "~step2-1" {"Amount":20,"Type":"Diff/Charge"}. Narrow it with on or where.'
			);
		});
	});

	it("turns a differing point into a same one when the repair restarts the dropped work", async () => {
		const script = [
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			settleStep(chargeCard, {
				value: "r-10"
			})
		];
		const restart: IDifferentialOptions<IShop>["repair"] = async (runtime, outcome) => {
			for (const dropped of outcome.dropped) {
				if (dropped.name === "Diff/Charge") await runtime.dispatch(charge, dropped.entityId);
			}
		};
		expect((await differentialRestore(app(), script)).differing.map((p) => p.after)).toEqual([
			1
		]);
		const mended = await differentialRestore(
			app({
				repair: (runtime, outcome) => {
					void restart(runtime, outcome);
				}
			}),
			script
		);
		expect(
			mended.points.map((p) => [
				p.after,
				p.same,
				p.skipped
			])
		).toEqual([
			[
				1,
				true,
				[]
			]
		]);
		expect(mended.differing).toEqual([]);
	});

	it("restores a point whose only work is on a transient entity, which its snapshot doesn't list", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					ping
				]
			}),
			[
				dispatchStep(queueNote, "shop", [
					"hello"
				]),
				settleStep(ping, {
					value: undefined
				})
			]
		);
		expect(drainReports()).toEqual([]);
		expect(report.quiet).toBe(0);
		expect(report.points).toEqual([
			expect.objectContaining({
				after: 1,
				inFlight: [],
				skipped: [
					{
						step: 2,
						reason: 'no "Diff/Ping" is held open; open: none'
					}
				],
				differences: {
					state: [
						{
							path: "Notes[0]",
							expected: {
								$Id: "~step2-1",
								Text: "sent hello"
							},
							actual: undefined
						}
					]
				}
			})
		]);
	});

	it("skips a step in a restored run whose on or args throws because the entity it reads is gone", async () => {
		const report = await differentialRestore(
			app({
				repair: (runtime) => {
					void runtime.dispatch(cancelOrders, "shop");
				}
			}),
			[
				dispatchStep(
					placeOrder,
					"shop",
					[
						10
					]
				),
				settleStep(chargeCard, {
					value: "r-10"
				}),
				dispatchStep(ship, "shop", (runtime) => [
					first(runtime)
				]),
				dispatchStep(settleOrder, first)
			]
		);
		expect(report.points[0]!.skipped).toEqual([
			{
				step: 2,
				reason: 'no "Diff/Charge" is held open; open: none'
			},
			{
				step: 3,
				reason: "its args threw: TypeError: Cannot read properties of undefined (reading '$Id')"
			},
			{
				step: 4,
				reason: "its on threw: TypeError: Cannot read properties of undefined (reading '$Id')"
			}
		]);
	});

	it("skips a dispatch in a restored run onto an entity its tree doesn't hold, or whose on returns no $Id", async () => {
		const report = await differentialRestore(
			app({
				repair: (runtime) => {
					void runtime.dispatch(cancelOrders, "shop");
				}
			}),
			[
				dispatchStep(
					placeOrder,
					"shop",
					[
						10
					]
				),
				settleStep(chargeCard, {
					value: "r-10"
				}),
				dispatchStep(settleOrder, "~step1-1"),
				dispatchStep(settleOrder, (runtime) => runtime.state.Orders.find((o) => o.Amount === 10)?.$Id as string)
			]
		);
		expect(report.points[0]!.skipped).toEqual([
			{
				step: 2,
				reason: 'no "Diff/Charge" is held open; open: none'
			},
			{
				step: 3,
				reason: 'no entity "~step1-1" is in the tree'
			},
			{
				step: 4,
				reason: "its on returned undefined, not an $Id"
			}
		]);
	});

	it("lets go of a held effect whose action is cancelled", async () => {
		const report = await differentialRestore(app(), [
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			dispatchStep(cancelOrders, "shop")
		]);
		expect(
			report.points.map((p) => [
				p.after,
				p.same
			])
		).toEqual([
			[
				1,
				true
			]
		]);
	});

	it("holds a type setup also implements, without installing setup's implementation", async () => {
		const report = await differentialRestore(
			app({
				setup: (runtime) => {
					runtime.registerImplementation(chargeCard.Type, () => "from setup");
				}
			}),
			[
				dispatchStep(
					placeOrder,
					"shop",
					[
						10
					]
				),
				settleStep(chargeCard, {
					value: "r-10"
				})
			]
		);
		expect(report.points).toHaveLength(1);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("holds an effect that work setup starts yields at once", async () => {
		function* awaitPing(draft: IShop): IActionGenerator {
			yield* ping();
			draft.Shipped.push("pinged");
		}
		named(awaitPing, "Diff/AwaitPing");
		const report = await differentialRestore(
			app({
				hold: [
					ping
				],
				setup: (runtime) => {
					void runtime.dispatch(awaitPing, "shop");
				}
			}),
			[
				settleStep(ping, {
					value: undefined
				}),
				dispatchStep(audit, "shop"),
				settleStep(ping, {
					value: undefined
				})
			]
		);
		expect(
			report.points.map((p) => [
				p.after,
				p.skipped,
				p.differences
			])
		).toEqual([
			[
				2,
				[],
				{
					state: [
						{
							path: "Shipped[1]",
							expected: undefined,
							actual: "pinged"
						}
					]
				}
			]
		]);
	});

	describe("effect stubs given as a function", () => {
		const script = [
			dispatchStep(takeStamp, "shop"),
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			settleStep(chargeCard, {
				value: "r-10"
			}),
			dispatchStep(takeStamp, "shop")
		];
		const restart: IDifferentialOptions<IShop>["repair"] = (runtime, outcome) => {
			for (const dropped of outcome.dropped) void runtime.dispatch(charge, dropped.entityId);
		};

		it("gives each restored point stubs that have seen its own run to the point, so a count read on both sides of it is no difference", async () => {
			let calls = 0;
			const counted = app({
				repair: restart,
				effectStubs: () => {
					calls++;
					let n = 0;
					return {
						[stamp.Type]: () => ++n
					};
				}
			});
			const once = await differentialRestore(counted, script);
			expect(calls).toBe(2);
			expect(once.points.map((p) => p.after)).toEqual([
				2
			]);
			expect(once.differing).toEqual([]);
			expect(await differentialRestore(counted, script)).toEqual(once);
		});

		describe("as a fake server", () => {
			interface IDesk extends IEntity {
				Notes: INote[];
				Pending: string[];
				Errors: string[];
			}

			const desk: IDesk = {
				$Id: "desk",
				Notes: [],
				Pending: [],
				Errors: []
			};

			const create = defineEffect<
				{
					Type: "Diff/Create";
					Key: string;
				},
				void
			>("Diff/Create");

			const send = defineEffect<
				{
					Type: "Diff/Send";
					Key: string;
				},
				void
			>("Diff/Send");

			function* submit(draft: IDesk, key: string): IActionGenerator {
				if (!draft.Pending.includes(key)) draft.Pending.push(key);
				try {
					yield* create({
						Key: key
					});
				} catch (error) {
					draft.Errors.push(String(error));
					return;
				}
				yield* send({
					Key: key
				});
				draft.Pending.splice(draft.Pending.indexOf(key), 1);
			}
			named(submit, "Diff/Submit");

			const resubmit: IDifferentialOptions<IDesk>["repair"] = (runtime) => {
				for (const key of [
					...runtime.state.Pending
				])
					void runtime.dispatch(submit, "desk", key);
			};

			const twoKeys = [
				dispatchStep(submit, "desk", [
					"a"
				]),
				dispatchStep(submit, "desk", [
					"b"
				]),
				settleStep(
					send,
					{
						value: undefined
					},
					{
						where: (e) => e.Key === "a"
					}
				),
				settleStep(
					send,
					{
						value: undefined
					},
					{
						where: (e) => e.Key === "b"
					}
				)
			];

			const server = (): Record<string, IEffectStub> => {
				const taken = new Set<string>();
				return {
					[create.Type]: (effect: { Key: string }) => {
						if (taken.has(effect.Key)) throw new Error(`409 ${effect.Key} exists`);
						taken.add(effect.Key);
					}
				};
			};

			it("shows a repair that sends again a create the server took before the point", async () => {
				const report = await differentialRestore(
					{
						seed: desk,
						hold: [
							send
						],
						effectStubs: server,
						repair: resubmit
					},
					[
						dispatchStep(submit, "desk", [
							"k1"
						]),
						settleStep(send, {
							value: undefined
						})
					]
				);
				expect(report.points.map((p) => p.after)).toEqual([
					1
				]);
				expect(report.points[0]!.skipped.map((s) => s.step)).toEqual([
					2
				]);
				expect(report.points[0]!.differences).toEqual({
					state: [
						{
							path: "Pending[0]",
							expected: undefined,
							actual: "k1"
						},
						{
							path: "Errors[0]",
							expected: undefined,
							actual: "Error: 409 k1 exists"
						}
					]
				});
			});

			it("calls the function once for the uninterrupted run and once per point, whose run to the point and restore share its stubs", async () => {
				const logs: string[][] = [];
				const report = await differentialRestore(
					{
						seed: desk,
						hold: [
							send
						],
						setup: () => {
							logs.at(-1)!.push("setup");
						},
						effectStubs: () => {
							const log: string[] = [];
							logs.push(log);
							return {
								[create.Type]: (effect: { Key: string }) => {
									log.push(effect.Key);
								}
							};
						}
					},
					twoKeys
				);
				expect(report.points.map((p) => p.after)).toEqual([
					1,
					2,
					3
				]);
				expect(logs).toEqual([
					[
						"setup",
						"a",
						"b"
					],
					[
						"setup",
						"a",
						"setup",
						"b"
					],
					[
						"setup",
						"a",
						"setup"
					],
					[
						"setup",
						"a",
						"b",
						"setup"
					]
				]);
			});

			it("uses a map's stubs as they are, in every run", async () => {
				const log: string[] = [];
				await differentialRestore(
					{
						seed: desk,
						hold: [
							send
						],
						setup: () => {
							log.push("setup");
						},
						effectStubs: {
							[create.Type]: (effect: { Key: string }) => {
								log.push(effect.Key);
							}
						}
					},
					twoKeys
				);
				expect(log).toEqual([
					"setup",
					"a",
					"b",
					...[
						"setup",
						"a",
						"setup",
						"b"
					],
					...[
						"setup",
						"a",
						"setup"
					],
					...[
						"setup",
						"a",
						"b",
						"setup"
					]
				]);
			});

			it("shows a repair that sends again a create a stub took through its action context", async () => {
				const report = await differentialRestore(
					{
						seed: desk,
						hold: [
							send
						],
						setup: (runtime) =>
							runtime.set("diff:session", {
								token: "t"
							}),
						repair: resubmit,
						effectStubs: () => {
							const taken = new Set<string>();
							return {
								[create.Type]: (
									effect: {
										Key: string;
									},
									action?: IActionContext
								) => {
									const key = `${action!.get("diff:session").token}:${effect.Key}`;
									if (taken.has(key)) throw new Error(`409 ${effect.Key} exists`);
									taken.add(key);
								}
							};
						}
					},
					[
						dispatchStep(submit, "desk", [
							"k1"
						]),
						settleStep(send, {
							value: undefined
						})
					]
				);
				expect(report.points[0]!.differences.state).toContainEqual({
					path: "Errors[0]",
					expected: undefined,
					actual: "Error: 409 k1 exists"
				});
			});

			it("ends a call still open at the point as a reload does, by aborting its action", async () => {
				const watch = defineEffect<
					{
						Type: "Diff/Watch";
					},
					void
				>("Diff/Watch");
				const gate = defineEffect<
					{
						Type: "Diff/Gate";
					},
					void
				>("Diff/Gate");
				function* watchUntil(draft: IDesk): IActionGenerator {
					try {
						yield* parallel(
							(function* () {
								yield* watch();
							})(),
							(function* () {
								yield* gate();
								throw new Error("stop watching");
							})()
						);
					} catch {
						draft.Pending.push("watched");
					}
				}
				named(watchUntil, "Diff/WatchUntil");
				const aborted: number[] = [];
				let runs = 0;
				const report = await differentialRestore(
					{
						seed: desk,
						hold: [
							send,
							gate
						],
						effectStubs: () => {
							const run = ++runs;
							return {
								[create.Type]: () => {},
								[watch.Type]: (_effect: unknown, action?: IActionContext) =>
									new Promise<void>((_, reject) =>
										action!.signal.addEventListener("abort", () => {
											aborted.push(run);
											reject(new Error("aborted"));
										})
									)
							};
						}
					},
					[
						dispatchStep(watchUntil, "desk"),
						settleStep(gate, {
							value: undefined
						}),
						dispatchStep(submit, "desk", [
							"k1"
						]),
						settleStep(send, {
							value: undefined
						})
					]
				);
				expect(report.points.map((p) => p.after)).toEqual([
					1,
					3
				]);
				expect(report.points[0]!.differences.state).toEqual([
					{
						path: "Pending[0]",
						expected: "watched",
						actual: undefined
					}
				]);
				expect(aborted).toEqual([
					1,
					2,
					3
				]);
			});

			it("unwinds the aborted action when it disposes a point's run without sending what its finally yields, so the restore meets the world the reload left", async () => {
				interface IJob extends IEntity {
					Status: string;
				}
				const acquire = defineEffect<
					{
						Type: "Diff/Acquire";
					},
					boolean
				>("Diff/Acquire");
				const release = defineEffect<
					{
						Type: "Diff/Release";
					},
					void
				>("Diff/Release");
				const wait = defineEffect<
					{
						Type: "Diff/Wait";
					},
					void
				>("Diff/Wait");
				const unwound: boolean[] = [];
				function* work(draft: IJob): IActionGenerator {
					if (!(yield* acquire())) {
						draft.Status = "busy";
						return;
					}
					try {
						draft.Status = "working";
						yield* wait();
						draft.Status = "done";
					} finally {
						unwound.push(true);
						yield* release();
					}
				}
				named(work, "Diff/Work");
				const logs: string[][] = [];
				const report = await differentialRestore<IJob>(
					{
						seed: {
							$Id: "job",
							Status: "new"
						},
						hold: [
							wait
						],
						effectStubs: () => {
							const server = {
								locked: false
							};
							const log: string[] = [];
							logs.push(log);
							return {
								[acquire.Type]: () => {
									log.push("acquire");
									if (server.locked) {
										return false;
									}
									server.locked = true;
									return true;
								},
								[release.Type]: () => {
									log.push("release");
									server.locked = false;
								}
							};
						},
						repair: (runtime, result) => {
							for (const dropped of result.dropped) {
								void runtime.dispatch(work, dropped.entityId).catch(() => {});
							}
						}
					},
					[
						dispatchStep(work, "job"),
						settleStep(wait, {
							value: undefined
						})
					]
				);
				expect(unwound).toEqual([
					true,
					true
				]);
				expect(logs).toEqual([
					[
						"acquire",
						"release"
					],
					[
						"acquire",
						"acquire"
					]
				]);
				expect(report.points[0]!.differences).toEqual({
					state: [
						{
							path: "Status",
							expected: "done",
							actual: "busy"
						}
					]
				});
			});
		});

		it("disposes a point's run before the restore, so the repair meets the server as the reload's aborts left it", async () => {
			interface ILine extends IEntity {
				Done: boolean;
			}
			const connect = defineEffect<
				{
					Type: "Diff/Connect";
				},
				void
			>("Diff/Connect");
			const hang = defineEffect<
				{
					Type: "Diff/Hang";
				},
				void
			>("Diff/Hang");
			function* call(draft: ILine): IActionGenerator {
				yield* connect();
				yield* hang();
				draft.Done = true;
			}
			named(call, "Diff/Call");
			let server = {
				open: 0
			};
			const report = await differentialRestore<ILine>(
				{
					seed: {
						$Id: "line",
						Done: false
					},
					hold: [
						hang
					],
					effectStubs: () => {
						const mine = {
							open: 0
						};
						server = mine;
						return {
							[connect.Type]: (_effect: unknown, action?: IActionContext) => {
								mine.open++;
								action!.signal.addEventListener(
									"abort",
									() => {
										mine.open--;
									},
									{
										once: true
									}
								);
							}
						};
					},
					repair: (runtime) => {
						if (server.open === 0) void runtime.dispatch(call, "line").catch(() => {});
					}
				},
				[
					dispatchStep(call, "line"),
					settleStep(hang, {
						value: undefined
					})
				]
			);
			expect(
				report.points.map((p) => [
					p.after,
					p.differences
				])
			).toEqual([
				[
					1,
					{}
				]
			]);
		});

		it("rejects a point whose run to it doesn't reach the uninterrupted run's state there, naming the step", async () => {
			let runs = 0;
			await expect(
				differentialRestore(
					app({
						effectStubs: () => {
							const run = ++runs;
							return {
								[stamp.Type]: () => run
							};
						}
					}),
					[
						dispatchStep(takeStamp, "shop"),
						dispatchStep(
							placeOrder,
							"shop",
							[
								10
							]
						),
						settleStep(chargeCard, {
							value: "r-10"
						})
					]
				)
			).rejects.toThrow(
				'[treflex] differentialRestore: the run to the point after step 2 differs from the uninterrupted run once both have played step 1, dispatch takeStamp, at AppState.Notes[0].Text: "1" uninterrupted, "2" in this run. The script, a stub that keeps state across runs, or the app\'s setup does something different each time it runs;'
			);
		});

		it("rejects a point whose run to it can't play a step the uninterrupted run played, naming it", async () => {
			let calls = 0;
			await expect(
				differentialRestore(app(), [
					dispatchStep(noop, () => (++calls === 1 ? "shop" : "gone")),
					dispatchStep(
						placeOrder,
						"shop",
						[
							10
						]
					),
					settleStep(chargeCard, {
						value: "r-10"
					})
				])
			).rejects.toThrow(
				"[treflex] differentialRestore: the run to the point after step 2 couldn't play step 1, dispatch noop, which the uninterrupted run played: no entity \"gone\" is in the tree. The script, a stub that keeps state across runs, or the app's setup does something different each time it runs;"
			);
		});

		it("refuses a function that returns the same map, or the same stub, on a later call", async () => {
			const shared = {
				[stamp.Type]: () => 1
			};
			const script = [
				dispatchStep(
					placeOrder,
					"shop",
					[
						10
					]
				),
				settleStep(chargeCard, {
					value: "r-10"
				})
			];
			await expect(
				differentialRestore(
					app({
						effectStubs: () => shared
					}),
					script
				)
			).rejects.toThrow(
				"[treflex] differentialRestore: effectStubs returned the same map on two calls, so runs would share it. A function must return fresh stubs each call; stubs every run shares, which must keep no state, are given as a map."
			);
			await expect(
				differentialRestore(
					app({
						effectStubs: () => ({
							...shared
						})
					}),
					script
				)
			).rejects.toThrow('effectStubs returned the same stub for "Diff/Stamp" on two calls');
		});

		it("refuses what it returns each time it is read, not only the first", async () => {
			const lates: Record<string, IEffectStub>[] = [
				{
					generateGuid: () => "x"
				},
				{
					[chargeCard.Type]: () => "r"
				}
			];
			for (const late of lates) {
				let calls = 0;
				await expect(
					differentialRestore(
						app({
							effectStubs: () => ({
								[stamp.Type]: () => 1,
								...(++calls > 1 ? late : {})
							})
						}),
						script
					)
				).rejects.toThrow("generateGuid" in late ? "leave generateGuid out of effectStubs" : '"Diff/Charge" is both held and stubbed');
				expect(calls).toBe(2);
			}
		});

		it("refuses what it returns as it refuses a map", async () => {
			await expect(
				differentialRestore(
					app({
						effectStubs: () => ({
							[chargeCard.Type]: () => "r"
						})
					}),
					script
				)
			).rejects.toThrow('[treflex] differentialRestore: "Diff/Charge" is both held and stubbed');
		});
	});

	describe("a restore that hasn't finished in restoreTimeoutMs", () => {
		const script = [
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			settleStep(chargeCard, {
				value: "r-10"
			})
		];
		const restart: IDifferentialOptions<IShop>["repair"] = (runtime, outcome) => {
			for (const dropped of outcome.dropped) void runtime.dispatch(charge, dropped.entityId);
		};

		it("is rejected, naming the effects held open, when the repair awaits work waiting on one, and its runtime disposed", async () => {
			let restored: IRuntime<IShop> | undefined;
			await expect(
				differentialRestore(
					app({
						restoreTimeoutMs: 20,
						setup: (runtime) => {
							restored = runtime;
						},
						repair: async (runtime, outcome) => {
							for (const dropped of outcome.dropped) await runtime.dispatch(charge, dropped.entityId);
						}
					}),
					script
				)
			).rejects.toMatchObject({
				message:
					"[treflex] differentialRestore: the restore of the snapshot after step 1 hadn't finished in 20ms, its restoreTimeoutMs. " +
					'Effects held open then: "Diff/Charge" on "~step1-1" {"Amount":10,"Type":"Diff/Charge"}. Only a settle step answers a held effect, ' +
					"so a repair must not await work that waits on one; have it start that work without awaiting it."
			});
			expect((restored as IRuntimeInternal<IShop>).disposed()).toBe(true);
		});

		it("is rejected when the repair awaits a promise that never settles, with nothing held, and its runtime disposed", async () => {
			let restored: IRuntime<IShop> | undefined;
			await expect(
				differentialRestore(
					app({
						restoreTimeoutMs: 20,
						setup: (runtime) => {
							restored = runtime;
						},
						repair: () => new Promise(() => {})
					}),
					script
				)
			).rejects.toMatchObject({
				message: "[treflex] differentialRestore: the restore of the snapshot after step 1 hadn't finished in 20ms, its restoreTimeoutMs."
			});
			expect((restored as IRuntimeInternal<IShop>).disposed()).toBe(true);
			expect(drainReports()).toEqual([]);
		});

		it("leaves nothing writing to the disposed runtime when work the repair started answers late", async () => {
			let restored: IRuntime<IShop> | undefined;
			let calls = 0;
			await expect(
				differentialRestore(
					app({
						restoreTimeoutMs: 20,
						effectStubs: () => ({
							[stamp.Type]: () => new Promise<number>((resolve) => setTimeout(() => resolve(7), 60))
						}),
						setup: (runtime) => {
							if (++calls > 1) restored = runtime;
						},
						repair: async (runtime, outcome) => {
							void runtime.dispatch(takeStamp, "shop").catch(() => {});
							for (const dropped of outcome.dropped) await runtime.dispatch(charge, dropped.entityId);
						}
					}),
					script
				)
			).rejects.toThrow("hadn't finished in 20ms");
			const before = JSON.stringify(restored!.state);
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(JSON.stringify(restored!.state)).toBe(before);
			expect(restored!.state.Notes).toEqual([]);
			expect(drainReports()).toEqual([]);
		});

		it("is rejected under a caller's fake timers too", async () => {
			vi.useFakeTimers();
			await expect(
				differentialRestore(
					app({
						restoreTimeoutMs: 20,
						repair: () => new Promise(() => {})
					}),
					script
				)
			).rejects.toThrow("hadn't finished in 20ms");
		}, 2000);

		it.each([
			0,
			-5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"20"
		])("refuses a restoreTimeoutMs of %s before anything runs", async (limit) => {
			let calls = 0;
			const rejection = await differentialRestore(
				app({
					restoreTimeoutMs: limit as number,
					setup: () => {
						calls++;
					}
				}),
				script
			).catch((error: unknown) => error);
			expect(rejection).toBeInstanceOf(TypeError);
			expect((rejection as Error).message).toBe(
				`[treflex] differentialRestore: restoreTimeoutMs is ${String(limit)}; it takes a positive finite number of milliseconds.`
			);
			expect(calls).toBe(0);
		});

		it("is not rejected when the repair finishes inside it, however many ticks it takes", async () => {
			const report = await differentialRestore(
				app({
					restoreTimeoutMs: 200,
					repair: async (runtime, outcome) => {
						restart(runtime, outcome);
						for (let tick = 0; tick < 3; tick++) await new Promise((resolve) => setTimeout(resolve, 5));
					}
				}),
				script
			);
			expect(report.points).toHaveLength(1);
			expect(report.differing).toEqual([]);
		});
	});

	describe("a setup that returns a promise", () => {
		const script = [
			dispatchStep(
				placeOrder,
				"shop",
				[
					10
				]
			),
			settleStep(chargeCard, {
				value: "r-10"
			})
		];

		it("is refused in the uninterrupted run with AsyncSetupError", async () => {
			await expect(
				differentialRestore(
					app({
						setup: async () => {}
					}),
					script
				)
			).rejects.toBeInstanceOf(AsyncSetupError);
		});

		it("is refused when what it returns is a thenable that isn't a Promise", async () => {
			await expect(
				differentialRestore(
					app({
						setup: () => ({
							// biome-ignore lint/suspicious/noThenProperty: the thenable is what the test refuses
							then() {}
						})
					}),
					script
				)
			).rejects.toBeInstanceOf(AsyncSetupError);
		});

		it("is refused in a restore with AsyncSetupError, naming the step", async () => {
			let calls = 0;
			const rejection = await differentialRestore(
				app({
					setup: () => (++calls > 2 ? Promise.resolve() : undefined)
				}),
				script
			).catch((error: unknown) => error as Error);
			expect(rejection).toMatchObject({
				message: expect.stringContaining(
					"[treflex] differentialRestore: the restore of the snapshot after step 1 rejected: AsyncSetupError: [treflex] restore: setup returned a promise."
				)
			});
			expect((rejection as Error).cause).toBeInstanceOf(AsyncSetupError);
		});

		it("is refused in a point's run with AsyncSetupError, naming the step", async () => {
			let calls = 0;
			const rejection = await differentialRestore(
				app({
					setup: () => (++calls === 2 ? Promise.resolve() : undefined)
				}),
				script
			).catch((error: unknown) => error as Error);
			expect(rejection).toMatchObject({
				message: expect.stringContaining(
					"[treflex] differentialRestore: the run to the point after step 1 threw in setup: AsyncSetupError: [treflex] restore: setup returned a promise."
				)
			});
			expect((rejection as Error).cause).toBeInstanceOf(AsyncSetupError);
			expect(calls).toBe(2);
		});
	});

	it.each([
		[
			2,
			"the run to the point after step 1 threw in setup: Error: setup broke"
		],
		[
			3,
			"the restore of the snapshot after step 1 rejected: Error: setup broke"
		]
	])("rejects when setup's call %i, a point's run or its restore, throws, naming the step, with the error as its cause", async (breaks, message) => {
		let calls = 0;
		const broke = new Error("setup broke");
		const rejection = await differentialRestore(
			app({
				setup: () => {
					if (++calls === breaks) throw broke;
				}
			}),
			[
				dispatchStep(
					placeOrder,
					"shop",
					[
						10
					]
				),
				settleStep(chargeCard, {
					value: "r-10"
				})
			]
		).catch((error: unknown) => error as Error);
		expect((rejection as Error).message).toBe(`[treflex] differentialRestore: ${message}`);
		expect((rejection as Error).cause).toBe(broke);
	});

	it("rejects a point whose run differs from the uninterrupted run once setup has run, naming setup", async () => {
		let calls = 0;
		await expect(
			differentialRestore(
				app({
					setup: (runtime) => {
						if (++calls > 1) void runtime.dispatch(note, "shop", "late");
					}
				}),
				[
					dispatchStep(
						placeOrder,
						"shop",
						[
							10
						]
					),
					settleStep(chargeCard, {
						value: "r-10"
					})
				]
			)
		).rejects.toThrow(
			'[treflex] differentialRestore: the run to the point after step 1 differs from the uninterrupted run once setup has run, at AppState.Notes[0]: nothing uninterrupted, {"$Id":"~setup-1","Text":"late"} in this run.'
		);
	});

	it("refuses a seed whose root has no $Id", async () => {
		await expect(
			differentialRestore(
				{
					seed: {
						Orders: []
					} as unknown as IShop
				},
				[]
			)
		).rejects.toThrow("[treflex] differentialRestore: the seed's root needs a $Id, the rootId each restore checks.");
	});

	describe("a script the uninterrupted run can't play", () => {
		it("settles an effect nothing holds open", async () => {
			await expect(
				differentialRestore(app(), [
					dispatchStep(
						placeOrder,
						"shop",
						[
							10
						]
					),
					settleStep(
						chargeCard,
						{
							value: "r"
						},
						{
							on: "~id-9"
						}
					),
					settleStep(chargeCard, {
						value: "r"
					})
				])
			).rejects.toThrow(
				'[treflex] differentialRestore: step 2, settle "Diff/Charge", can\'t run uninterrupted: no "Diff/Charge" on "~id-9" is held open; ' +
					'open: "Diff/Charge" on "~step1-1" {"Amount":10,"Type":"Diff/Charge"}.'
			);
		});

		it("ends with work in flight", async () => {
			await expect(
				differentialRestore(app(), [
					dispatchStep(
						placeOrder,
						"shop",
						[
							10
						]
					)
				])
			).rejects.toThrow(
				"[treflex] differentialRestore: the script ends with work in flight, so the uninterrupted run has no outcome to compare with. " +
					'In flight: Diff/Charge on "~step1-1". Held open: "Diff/Charge" on "~step1-1" {"Amount":10,"Type":"Diff/Charge"}. Add the steps that finish it.'
			);
		});

		it("dispatches onto an entity the tree doesn't hold", async () => {
			await expect(
				differentialRestore(app(), [
					dispatchStep(audit, "nowhere")
				])
			).rejects.toThrow(
				'[treflex] differentialRestore: step 1, dispatch audit, can\'t run uninterrupted: no entity "nowhere" is in the tree.'
			);
			expect(drainReports()).toEqual([]);
		});

		it("stubs generateGuid, or stubs a held type", async () => {
			await expect(
				differentialRestore(
					app({
						effectStubs: {
							generateGuid: () => "x"
						}
					}),
					[]
				)
			).rejects.toThrow(
				"[treflex] differentialRestore: the tool mints ids itself, named for the step that mints them; leave generateGuid out of effectStubs."
			);
			await expect(
				differentialRestore(
					app({
						effectStubs: {
							"Diff/Charge": () => "r"
						}
					}),
					[]
				)
			).rejects.toThrow('"Diff/Charge" is both held and stubbed');
		});

		it("holds a type declared settles: sync", async () => {
			await expect(
				differentialRestore(
					app({
						hold: [
							readClock
						]
					}),
					[
						dispatchStep(readTime, "shop")
					]
				)
			).rejects.toThrow(
				'[treflex] differentialRestore: "Diff/ReadClock" is declared settles: "sync", so it can\'t be held open; take it out of hold.'
			);
		});

		it("holds a type the uninterrupted run never yields", async () => {
			await expect(
				differentialRestore(
					app({
						hold: [
							chargeCard,
							"Diff/Chrage"
						]
					}),
					[
						dispatchStep(
							placeOrder,
							"shop",
							[
								10
							]
						),
						settleStep(chargeCard, {
							value: "r-10"
						})
					]
				)
			).rejects.toThrow(
				'[treflex] differentialRestore: "Diff/Chrage" is in hold, and the uninterrupted run never yields it: either hold misnames the type or the script doesn\'t reach it.'
			);
		});
	});

	it("checks a script's arguments and values against the action and the effect", () => {
		dispatchStep(placeOrder, "shop", [
			// @ts-expect-error placeOrder takes a number
			"10"
		]);
		// @ts-expect-error placeOrder needs its amount
		dispatchStep(placeOrder, "shop");
		// @ts-expect-error a charge settles to a string
		settleStep(chargeCard, {
			value: 10
		});
		const steps: IDifferentialStep<IShop>[] = [
			dispatchStep(ship, "shop", (runtime) => [
				// @ts-expect-error the state has no Missing
				runtime.state.Missing
			]),
			dispatchStep(ship, "shop", (runtime) => [
				runtime.state.Orders[0]!.$Id
			])
		];
		expect(steps).toHaveLength(2);
	});
});
