import type { IActionGenerator, IEntity, IOpenGenerator, IRuntime } from "../../src/index";
import type { IRegion, ISide, ITrace } from "../../src/Snapshot/differentialRestore";
import type { IDiagSummary, IDifferentialOptions, IDifferentialStep, IRestoreResult } from "../../src/Snapshot/index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineEffect, entity, generateGuid, named, open, resumable } from "../../src/index";
import { compareSides, pairingOf, regionOf, stateDifferences } from "../../src/Snapshot/differentialRestore";
import { differentialRestore, dispatchStep, settleStep } from "../../src/Snapshot/index";
import { drainReports } from "../../src/Testing/reports";

interface INote extends IEntity {
	Text: string;
}

interface ILine extends IEntity {
	Qty: number;
}

interface IOrder extends IEntity {
	Base: number;
	Discount: number;
	Total: number;
	Touched: number;
	Started: boolean;
	Done: boolean;
	Lines: ILine[];
}

interface IShop extends IEntity {
	Orders: IOrder[];
	Notes: Record<string, INote>;
	Paid: number;
	Started: boolean;
	Pick: string;
	Side: ILine;
}

const seed = (): IShop => ({
	$Id: "shop",
	Orders: [
		{
			$Id: "o1",
			Base: 100,
			Discount: 0,
			Total: 0,
			Touched: 0,
			Started: false,
			Done: false,
			Lines: [
				{
					$Id: "l1",
					Qty: 0
				}
			]
		}
	],
	Notes: {},
	Paid: 0,
	Started: false,
	Pick: "",
	Side: {
		$Id: "side",
		Qty: 0
	}
});

const quote = defineEffect<
	{
		Type: "Cmp/Quote";
	},
	number
>("Cmp/Quote", {
	idempotent: true
});

const confirm = defineEffect<
	{
		Type: "Cmp/Confirm";
	},
	boolean
>("Cmp/Confirm", {
	idempotent: true
});

const voucher = defineEffect<
	{
		Type: "Cmp/Voucher";
	},
	number
>("Cmp/Voucher");

const resuming = {
	build: "test",
	resume: true
} as const;

// Set by setup from the tree it is given: only a restored runtime's setup sees a started flow.
let bias = 0;

const biasing = (runtime: IRuntime<IShop>): void => {
	bias = runtime.state.Started || runtime.state.Orders[0]?.Started ? 1000 : 0;
};

function* priced(draft: IOrder): IActionGenerator {
	draft.Total = yield* quote();
}
named(priced, "Cmp/Priced");
resumable(priced);

function* pricedUnmarked(draft: IOrder): IActionGenerator {
	draft.Total = yield* quote();
}
named(pricedUnmarked, "Cmp/PricedUnmarked");

function* biased(draft: IOrder): IActionGenerator {
	draft.Started = true;
	const add = bias;
	draft.Total = (yield* quote()) + add;
}
named(biased, "Cmp/Biased");
resumable(biased);

function* opens(draft: IShop): IActionGenerator {
	draft.Started = true;
	const add = bias;
	const total = (yield* quote()) + add;
	draft.Orders.push(
		yield* entity<IOrder>({
			Base: 0,
			Discount: 0,
			Total: total,
			Touched: 0,
			Started: false,
			Done: false,
			Lines: []
		})
	);
}
named(opens, "Cmp/Opens");
resumable(opens);

function* addNote(draft: IShop, skip: boolean): IActionGenerator {
	if (skip) {
		yield* generateGuid();
	}
	const note = yield* entity<INote>({
		Text: "repaired"
	});
	draft.Notes[note.$Id] = note;
}
named(addNote, "Cmp/AddNote");

function* check(draft: IOrder): IActionGenerator {
	if (draft.Total === 0) {
		throw new Error("unpriced");
	}
}
named(check, "Cmp/Check");

function* vouch(draft: IOrder): IActionGenerator {
	draft.Discount = yield* voucher();
}
named(vouch, "Cmp/Vouch");
resumable(vouch);

function* holder(draft: IOrder): IActionGenerator {
	draft.Total = yield* quote();
}
named(holder, "Cmp/Holder");
resumable(holder);

function* touch(draft: IShop): IActionGenerator {
	draft.Orders[0]!.Touched++;
}
named(touch, "Cmp/Touch");

function* checkout(draft: IOrder): IOpenGenerator {
	yield* open(quote());
	draft.Total = draft.Base - draft.Discount;
	yield* confirm();
	draft.Done = true;
}
named(checkout, "Cmp/Checkout");
resumable(checkout);

function* applyVoucher(draft: IOrder): IActionGenerator {
	draft.Discount = yield* voucher();
}
named(applyVoucher, "Cmp/ApplyVoucher");

function* touchIfFull(draft: IShop): IActionGenerator {
	const order = draft.Orders[0]!;
	if (order.Discount === 0) {
		order.Touched++;
	}
}
named(touchIfFull, "Cmp/TouchIfFull");

function* settleUp(draft: IShop): IActionGenerator {
	draft.Paid = draft.Orders[0]!.Total;
}
named(settleUp, "Cmp/SettleUp");

const ping = defineEffect<
	{
		Type: "Cmp/Ping";
	},
	number
>("Cmp/Ping");

function* touchAgain(draft: IShop): IActionGenerator {
	draft.Orders[0]!.Touched++;
}
named(touchAgain, "Cmp/TouchAgain");

function* openPriced(draft: IOrder): IOpenGenerator {
	draft.Total = yield* open(quote());
}
named(openPriced, "Cmp/OpenPriced");
resumable(openPriced);

function* discountFromShop(draft: IShop): IOpenGenerator {
	draft.Orders[0]!.Discount = yield* open(ping());
}
named(discountFromShop, "Cmp/DiscountFromShop");

function* countLine(draft: ILine): IActionGenerator {
	draft.Qty = yield* ping();
}
named(countLine, "Cmp/CountLine");

function* parker(_draft: IShop): IOpenGenerator {
	yield* open(ping());
}
named(parker, "Cmp/Parker");

function* checkoutIfDiscount(draft: IOrder, strict: boolean): IOpenGenerator {
	yield* open(quote());
	draft.Total = draft.Base - draft.Discount;
	if (draft.Discount > 0) {
		yield* confirm();
	} else if (strict) {
		throw new Error("no voucher");
	}
	draft.Done = true;
}
named(checkoutIfDiscount, "Cmp/CheckoutIfDiscount");
resumable(checkoutIfDiscount);

function* pickLast(draft: IShop): IActionGenerator {
	draft.Pick = bias ? (Object.keys(draft.Notes).at(-1) ?? "") : "x";
}
named(pickLast, "Cmp/PickLast");

function* parkAside(draft: ILine): IActionGenerator {
	draft.Qty = yield* ping();
}
named(parkAside, "Cmp/ParkAside");

function* touchAside(draft: IShop): IActionGenerator {
	draft.Side.Qty++;
}
named(touchAside, "Cmp/TouchAside");

const restarting =
	(name: string, ...work: ((runtime: IRuntime<IShop>) => Promise<unknown>)[]) =>
	(runtime: IRuntime<IShop>, result: IRestoreResult): void => {
		if (result.dropped.some((drop) => drop.name === name)) {
			for (const dispatch of work) {
				void dispatch(runtime).catch(() => {});
			}
		}
	};

const app = (more: Partial<IDifferentialOptions<IShop>> = {}): IDifferentialOptions<IShop> => ({
	seed: seed(),
	hold: [
		quote
	],
	options: resuming,
	compareDataOnly: true,
	...more
});

const pricing: IDifferentialStep<IShop>[] = [
	dispatchStep(priced, "o1"),
	settleStep(quote, {
		value: 7
	})
];

beforeEach(() => {
	bias = 0;
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	expect(drainReports()).toEqual([]);
});

describe("differentialRestore's compareDataOnly", () => {
	it("refuses the option without resume or without a build, before anything runs", async () => {
		const setup = vi.fn();
		for (const options of [
			{
				build: "test"
			},
			{
				resume: true
			},
			{
				build: "test",
				resume: false
			}
		] as const) {
			await expect(
				differentialRestore(
					app({
						setup,
						options
					}),
					pricing
				)
			).rejects.toThrow(TypeError);
		}
		expect(setup).not.toHaveBeenCalled();
	});

	it("restores the resumed run and then the data-only run at each point, and leaves the fields out without the option", async () => {
		const heard: string[] = [];
		const report = await differentialRestore(
			app({
				setup: () => {
					heard.push("setup");
				},
				repair: (_runtime, result) => {
					heard.push(result.resumed.length > 0 ? "resumed" : `dropped ${result.dropped.map((drop) => drop.reason)}`);
				}
			}),
			pricing
		);
		expect(heard).toEqual([
			"setup",
			"setup",
			"setup",
			"resumed",
			"setup",
			"setup",
			"dropped resume-off"
		]);
		const [point] = report.points;
		expect(point!.same).toBe(true);
		expect(point!.dataOnly).toMatchObject({
			same: false,
			skipped: [
				{
					step: 2
				}
			],
			differences: {
				state: [
					{
						path: "Orders[0].Total",
						expected: 7,
						actual: 0
					}
				]
			}
		});
		expect(point!.comparison).toEqual({
			worse: {},
			reported: {},
			changed: [],
			diagCounts: []
		});
		expect(report.worse).toEqual([]);
		expect(JSON.parse(point!.snapshot).Histories).toHaveLength(1);

		const without = await differentialRestore(
			app({
				compareDataOnly: undefined
			}),
			pricing
		);
		expect(without.worse).toBeUndefined();
		expect(without.points[0]!.dataOnly).toBeUndefined();
		expect(without.points[0]!.comparison).toBeUndefined();
		expect(without.points[0]!.snapshot).toBe(point!.snapshot);
	});

	it("catches a resumed run that ends worse than the data-only one", async () => {
		const report = await differentialRestore(
			app({
				setup: biasing,
				repair: (runtime, result) => {
					bias = 0;
					if (result.dropped.length > 0) {
						void runtime.dispatch(biased, "o1");
					}
				}
			}),
			[
				dispatchStep(biased, "o1"),
				settleStep(quote, {
					value: 7
				})
			]
		);
		const [point] = report.points;
		expect(point!.dataOnly!.same).toBe(true);
		expect(point!.comparison!.worse).toEqual({
			state: [
				{
					path: "Orders[0].Total",
					expected: 7,
					actual: 1007
				}
			]
		});
		expect(report.worse).toEqual([
			point
		]);
	});

	it("lists a path both runs differ at with other values as changed, not worse", async () => {
		const report = await differentialRestore(
			app({
				setup: biasing
			}),
			[
				dispatchStep(biased, "o1"),
				settleStep(quote, {
					value: 7
				})
			]
		);
		expect(report.points[0]!.comparison).toEqual({
			worse: {},
			reported: {},
			changed: [
				{
					path: "Orders[0].Total",
					expected: 7,
					actual: 1007,
					dataOnly: 0
				}
			],
			diagCounts: []
		});
	});

	it("covers a wrong field by the data-only run's loss of the record it is in", async () => {
		const report = await differentialRestore(
			app({
				setup: biasing
			}),
			[
				dispatchStep(opens, "shop"),
				settleStep(quote, {
					value: 7
				})
			]
		);
		const [point] = report.points;
		expect(point!.differences.state).toEqual([
			{
				path: "Orders[1].Total",
				expected: 7,
				actual: 1007
			}
		]);
		expect(point!.dataOnly!.differences.state).toEqual([
			{
				path: "Orders[1]",
				expected: expect.objectContaining({
					Total: 7
				}),
				actual: undefined
			}
		]);
		expect(point!.comparison).toEqual({
			worse: {},
			reported: {},
			changed: [],
			diagCounts: []
		});
	});

	it("compares ids neither run paired by the step that minted them", async () => {
		const report = await differentialRestore(
			app({
				repair: (runtime, result) => {
					void runtime.dispatch(addNote, "shop", result.resumed.length > 0);
				}
			}),
			pricing
		);
		const [point] = report.points;
		expect(point!.differences.state!.map((d) => d.path)).toEqual([
			"Notes.~restore-2"
		]);
		expect(point!.dataOnly!.differences.state!.map((d) => d.path)).toEqual([
			"Orders[0].Total",
			"Notes.~restore-1"
		]);
		expect(point!.comparison).toEqual({
			worse: {},
			reported: {},
			changed: [],
			diagCounts: []
		});
	});

	it("covers an event the data-only run raises too, each once", async () => {
		const report = await differentialRestore(
			app({
				repair: (runtime, result) => {
					if (result.dropped.some((drop) => drop.reason === "not-marked")) {
						void runtime.dispatch(check, "o1");
					}
				}
			}),
			[
				dispatchStep(pricedUnmarked, "o1"),
				settleStep(quote, {
					value: 7
				}),
				dispatchStep(check, "o1")
			]
		);
		const [point] = report.points;
		const unpriced = {
			Name: "Cmp/Check",
			Label: "check",
			EntityId: "o1",
			Status: "errored",
			Close: false,
			Taken: true,
			Error: "Error: unpriced"
		};
		expect(point!.differences.failures).toEqual({
			missing: [],
			extra: [
				unpriced,
				unpriced
			]
		});
		expect(point!.dataOnly!.differences.failures!.extra).toHaveLength(1);
		expect(point!.comparison!.worse).toEqual({
			failures: {
				missing: [],
				extra: [
					unpriced
				]
			}
		});
	});

	it("leaves resume's own diags out of both runs", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					voucher
				]
			}),
			[
				dispatchStep(vouch, "o1"),
				settleStep(voucher, {
					value: 5
				})
			]
		);
		const [point] = report.points;
		expect(point!.result.dropped.map((drop) => drop.reason)).toEqual([
			"not-idempotent"
		]);
		expect(point!.differences.diags!.extra.map((diag) => diag.code)).toEqual([
			"resume/never-resumes"
		]);
		expect(point!.comparison).toEqual({
			worse: {},
			reported: {},
			changed: [],
			diagCounts: []
		});
	});

	it("doesn't count a code the uninterrupted run raised before the point that the resumed run raises again", async () => {
		const script: IDifferentialStep<IShop>[] = [
			dispatchStep(holder, "o1"),
			dispatchStep(touch, "shop"),
			dispatchStep(touch, "shop"),
			settleStep(quote, {
				value: 7
			})
		];
		const options = {
			...resuming,
			allowDiags: [
				"entity/written-while-held"
			]
		};
		const report = await differentialRestore(
			app({
				options
			}),
			script
		);
		const afterTwo = report.points.find((point) => point.after === 2)!;
		expect(afterTwo.differences.diags!.extra.map((diag) => diag.code)).toEqual([
			"entity/written-while-held"
		]);
		expect(afterTwo.dataOnly!.differences.diags).toBeUndefined();
		expect(afterTwo.comparison!.worse).toEqual({});
		expect(report.worse).toEqual([]);
	});

	it("reports, and doesn't count as worse, what is in the region of an action resumed beside dropped work", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					quote,
					confirm,
					voucher
				],
				options: {
					...resuming,
					allowDiags: [
						"entity/written-while-held"
					]
				},
				repair: (runtime, result) => {
					if (result.dropped.some((drop) => drop.name === "Cmp/Checkout")) {
						void runtime.dispatch(applyVoucher, "o1");
						void runtime.dispatch(checkout, "o1");
					}
				}
			}),
			[
				dispatchStep(checkout, "o1"),
				dispatchStep(applyVoucher, "o1"),
				settleStep(voucher, {
					value: 5
				}),
				settleStep(quote, {
					value: 0
				}),
				dispatchStep(touchIfFull, "shop"),
				settleStep(confirm, {
					value: true
				}),
				dispatchStep(settleUp, "shop")
			]
		);
		const afterTwo = report.points.find((point) => point.after === 2)!;
		expect(afterTwo.result.resumed.map((entry) => entry.name)).toEqual([
			"Cmp/Checkout"
		]);
		expect(
			afterTwo.result.dropped.map((drop) => [
				drop.name,
				drop.reason
			])
		).toEqual([
			[
				"Cmp/ApplyVoucher",
				"not-marked"
			]
		]);
		expect(afterTwo.dataOnly!.same).toBe(true);
		expect(afterTwo.comparison).toEqual({
			worse: {
				state: [
					{
						path: "Paid",
						expected: 95,
						actual: 100
					}
				]
			},
			reported: {
				state: [
					{
						path: "Orders[0].Discount",
						expected: 5,
						actual: 0
					},
					{
						path: "Orders[0].Total",
						expected: 95,
						actual: 100
					},
					{
						path: "Orders[0].Touched",
						expected: 0,
						actual: 1
					}
				],
				diags: {
					missing: [],
					extra: [
						expect.objectContaining({
							code: "entity/written-while-held"
						})
					]
				}
			},
			changed: [],
			diagCounts: [
				{
					code: "entity/written-while-held",
					uninterrupted: 0,
					dataOnly: 0,
					resumed: 1
				}
			]
		});
		expect(report.worse).toEqual([
			afterTwo
		]);
	});

	it("never excuses the repair's error", async () => {
		const report = await differentialRestore(
			app({
				repair: (_runtime, result) => {
					if (result.resumed.length > 0) {
						throw new Error("repair failed");
					}
				}
			}),
			pricing
		);
		expect(report.points[0]!.comparison!.worse).toEqual({
			repairError: "Error: repair failed"
		});
	});

	it("doesn't count a code two writers raised before the point and raise again after it", async () => {
		const report = await differentialRestore(
			app({
				options: {
					...resuming,
					allowDiags: [
						"entity/written-while-held"
					]
				}
			}),
			[
				dispatchStep(holder, "o1"),
				dispatchStep(touch, "shop"),
				dispatchStep(touchAgain, "shop"),
				dispatchStep(touch, "shop"),
				dispatchStep(touchAgain, "shop"),
				settleStep(quote, {
					value: 7
				})
			]
		);
		const afterThree = report.points.find((point) => point.after === 3)!;
		expect(afterThree.differences.diags!.extra.map((diag) => diag.code)).toEqual([
			"entity/written-while-held",
			"entity/written-while-held"
		]);
		expect(afterThree.comparison!.worse).toEqual({});
		expect(report.worse).toEqual([]);
	});

	it("counts a code the data-only run raises too only in diagCounts, however often the resumed run raises it", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					quote,
					confirm,
					voucher,
					ping
				],
				options: {
					...resuming,
					allowDiags: [
						"entity/written-while-held"
					]
				},
				setup: (runtime) => {
					void runtime.dispatch(parkAside, "side").catch(() => {});
				},
				repair: restarting(
					"Cmp/Checkout",
					(runtime) => runtime.dispatch(applyVoucher, "o1"),
					(runtime) => runtime.dispatch(checkout, "o1")
				)
			}),
			[
				settleStep(ping, {
					value: 1
				}),
				dispatchStep(checkout, "o1"),
				dispatchStep(applyVoucher, "o1"),
				settleStep(voucher, {
					value: 5
				}),
				settleStep(quote, {
					value: 0
				}),
				dispatchStep(touchIfFull, "shop"),
				dispatchStep(touchAside, "shop"),
				settleStep(confirm, {
					value: true
				})
			]
		);
		const afterThree = report.points.find((point) => point.after === 3)!;
		expect(afterThree.differences.diags!.extra.map((diag) => diag.code)).toEqual([
			"entity/written-while-held",
			"entity/written-while-held"
		]);
		expect(afterThree.dataOnly!.differences.diags!.extra).toHaveLength(1);
		expect(afterThree.comparison!.worse).toEqual({});
		expect(afterThree.comparison!.reported.diags).toBeUndefined();
		expect(afterThree.comparison!.diagCounts).toEqual([
			{
				code: "entity/written-while-held",
				uninterrupted: 0,
				dataOnly: 1,
				resumed: 2
			}
		]);
	});

	it("opens a region for a drop on the resumed action's parent entity", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					quote,
					ping
				],
				repair: restarting(
					"Cmp/Priced",
					(runtime) => runtime.dispatch(discountFromShop, "shop"),
					(runtime) => runtime.dispatch(priced, "o1")
				)
			}),
			[
				dispatchStep(priced, "o1"),
				dispatchStep(discountFromShop, "shop"),
				settleStep(quote, {
					value: 7
				}),
				settleStep(ping, {
					value: 5
				})
			]
		);
		const afterTwo = report.points.find((point) => point.after === 2)!;
		expect(afterTwo.dataOnly!.same).toBe(true);
		expect(afterTwo.comparison).toEqual({
			worse: {},
			reported: {
				state: [
					{
						path: "Orders[0].Discount",
						expected: 5,
						actual: 0
					}
				]
			},
			changed: [],
			diagCounts: []
		});
	});

	it("opens a region for a drop on a child entity of the resumed action's", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					quote,
					ping
				],
				repair: restarting(
					"Cmp/OpenPriced",
					(runtime) => runtime.dispatch(countLine, "l1"),
					(runtime) => runtime.dispatch(openPriced, "o1")
				)
			}),
			[
				dispatchStep(openPriced, "o1"),
				dispatchStep(countLine, "l1"),
				settleStep(quote, {
					value: 7
				}),
				settleStep(ping, {
					value: 3
				})
			]
		);
		const afterTwo = report.points.find((point) => point.after === 2)!;
		expect(afterTwo.dataOnly!.same).toBe(true);
		expect(afterTwo.comparison).toEqual({
			worse: {},
			reported: {
				state: [
					{
						path: "Orders[0].Lines[0].Qty",
						expected: 3,
						actual: 0
					}
				]
			},
			changed: [],
			diagCounts: []
		});
	});

	it("opens a region for a resumed action with resource work beside it", () => {
		const tree = seed();
		const trace: ITrace = {
			diffs: [],
			places: []
		};
		const pairing = pairingOf(new Set(), new Set());
		stateDifferences(pairing, tree, tree, trace);
		const resumed = (resourceWork: IRestoreResult["resumed"][number]["resourceWork"]): IRestoreResult => ({
			resumed: [
				{
					actionId: "a1",
					name: "Cmp/Priced",
					entityId: "o1",
					resourceWork
				}
			],
			dropped: [],
			unresolved: [],
			sweptOrphanedRows: 0,
			savedBuild: "test",
			sameBuild: true
		});
		expect(
			regionOf(
				tree,
				resumed([
					{
						key: "feed",
						ownerId: "o1"
					}
				]),
				{
					pairing,
					trace
				}
			)
		).toEqual({
			ids: [
				new Set([
					"o1",
					"l1"
				]),
				new Set([
					"o1",
					"l1"
				])
			],
			places: [
				"Orders[0]",
				"Orders[0].Lines[0]",
				"Orders[0]",
				"Orders[0].Lines[0]"
			]
		});
		expect(
			regionOf(tree, resumed([]), {
				pairing,
				trace
			}).places
		).toEqual([]);
	});

	it("covers an unfinished action, a held effect and an onError call the data-only run has too", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					quote,
					ping
				],
				options: {
					...resuming,
					onError: () => {}
				},
				setup: (runtime) => {
					void runtime.dispatch(parker, "shop").catch(() => {});
				}
			}),
			[
				settleStep(ping, {
					value: 1
				}),
				dispatchStep(pricedUnmarked, "o1"),
				settleStep(quote, {
					value: 7
				}),
				dispatchStep(check, "o1")
			]
		);
		const afterTwo = report.points.find((point) => point.after === 2)!;
		expect(afterTwo.differences).toMatchObject({
			onError: {
				extra: [
					expect.objectContaining({
						Name: "Cmp/Check"
					})
				]
			},
			unfinished: {
				inFlight: [
					expect.objectContaining({
						Name: "Cmp/Parker"
					})
				],
				held: [
					{
						Type: "Cmp/Ping",
						EntityId: "shop"
					}
				]
			}
		});
		expect(afterTwo.comparison!.worse).toEqual({});
	});

	it("reports a code the resumed run no longer raises while the data-only run does, in the region", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					quote,
					confirm,
					voucher
				],
				options: {
					...resuming,
					allowDiags: [
						"entity/written-while-held"
					]
				},
				repair: restarting(
					"Cmp/CheckoutIfDiscount",
					(runtime) => runtime.dispatch(applyVoucher, "o1"),
					(runtime) => runtime.dispatch(checkoutIfDiscount, "o1", false)
				)
			}),
			[
				dispatchStep(checkoutIfDiscount, "o1", [
					false
				]),
				dispatchStep(applyVoucher, "o1"),
				settleStep(voucher, {
					value: 5
				}),
				settleStep(quote, {
					value: 0
				}),
				dispatchStep(touch, "shop"),
				settleStep(confirm, {
					value: true
				})
			]
		);
		const afterTwo = report.points.find((point) => point.after === 2)!;
		expect(afterTwo.dataOnly!.same).toBe(true);
		expect(afterTwo.comparison!.worse).toEqual({});
		expect(afterTwo.comparison!.reported.diags).toEqual({
			missing: [
				expect.objectContaining({
					code: "entity/written-while-held"
				})
			],
			extra: []
		});
	});

	it("reports a failure on an entity of the region", async () => {
		const report = await differentialRestore(
			app({
				hold: [
					quote,
					confirm,
					voucher
				],
				repair: restarting(
					"Cmp/CheckoutIfDiscount",
					(runtime) => runtime.dispatch(applyVoucher, "o1"),
					(runtime) => runtime.dispatch(checkoutIfDiscount, "o1", true)
				)
			}),
			[
				dispatchStep(checkoutIfDiscount, "o1", [
					true
				]),
				dispatchStep(applyVoucher, "o1"),
				settleStep(voucher, {
					value: 5
				}),
				settleStep(quote, {
					value: 0
				}),
				settleStep(confirm, {
					value: true
				})
			]
		);
		const afterTwo = report.points.find((point) => point.after === 2)!;
		expect(afterTwo.dataOnly!.same).toBe(true);
		expect(afterTwo.comparison!.worse).toEqual({});
		expect(afterTwo.comparison!.reported.failures).toEqual({
			missing: [],
			extra: [
				expect.objectContaining({
					Name: "Cmp/CheckoutIfDiscount",
					EntityId: "o1",
					Error: "Error: no voucher"
				})
			]
		});
	});

	it("tells apart an id one run paired and the other didn't", async () => {
		const report = await differentialRestore(
			app({
				setup: biasing,
				repair: restarting(
					"Cmp/Biased",
					(runtime) => runtime.dispatch(addNote, "shop", false),
					(runtime) => runtime.dispatch(biased, "o1")
				)
			}),
			[
				dispatchStep(biased, "o1"),
				dispatchStep(addNote, "shop", [
					false
				]),
				settleStep(quote, {
					value: 7
				}),
				dispatchStep(pickLast, "shop")
			]
		);
		const [afterOne] = report.points;
		expect(afterOne!.comparison!.changed).toContainEqual({
			path: "Pick",
			expected: "x",
			actual: "~step2-1",
			dataOnly: "~step2-1"
		});
	});
});

describe("compareDataOnly's diags, by presence", () => {
	/** An occurrence written `code@entityId`. */
	const raised = (
		occurrence: string
	): IDiagSummary & {
		data: unknown;
	} => {
		const [code, entityId] = occurrence.split("@") as [
			string,
			string
		];
		return {
			code: `test/${code}`,
			severity: "info",
			message: occurrence,
			data: {
				entityId
			}
		};
	};
	const side = (diags: ReturnType<typeof raised>[]): ISide => ({
		differences: {},
		pairing: pairingOf(new Set(), new Set()),
		trace: {
			diffs: [],
			places: []
		},
		diags: diags.map(({ data: _, ...summary }) => summary),
		diagData: diags.map((diag) => diag.data)
	});
	const NO_REGION: IRegion = {
		ids: [
			new Set(),
			new Set()
		],
		places: []
	};
	const compare = (
		uninterrupted: string[],
		resumed: string[],
		dataOnly: string[],
		{
			prior = [],
			region = NO_REGION
		}: {
			prior?: string[];
			region?: IRegion;
		} = {}
	) =>
		compareSides(
			side(resumed.map(raised)),
			side(dataOnly.map(raised)),
			{
				diags: uninterrupted.map(raised).map(({ data: _, ...summary }) => summary),
				diagData: uninterrupted.map((id) => raised(id).data),
				raisedBefore: new Set(prior.map((id) => raised(id).code))
			},
			region
		);
	const summary = (occurrence: string) => {
		const { data: _, ...rest } = raised(occurrence);
		return rest;
	};
	const REGION: IRegion = {
		ids: [
			new Set([
				"o1"
			]),
			new Set([
				"o1"
			])
		],
		places: []
	};

	it("counts a code only the resumed run raises as worse, listing its occurrences", () => {
		expect(
			compare(
				[
					"known@x"
				],
				[
					"new@x",
					"new@o1",
					"known@x"
				],
				[
					"known@x"
				]
			)
		).toEqual({
			worse: {
				diags: {
					missing: [],
					extra: [
						summary("new@x"),
						summary("new@o1")
					]
				}
			},
			reported: {},
			changed: [],
			diagCounts: [
				{
					code: "test/new",
					uninterrupted: 0,
					dataOnly: 0,
					resumed: 2
				}
			]
		});
	});

	it("reports a new code when every one of its occurrences names the region", () => {
		expect(
			compare(
				[],
				[
					"new@o1",
					"new@o1"
				],
				[],
				{
					region: REGION
				}
			)
		).toMatchObject({
			worse: {},
			reported: {
				diags: {
					extra: [
						summary("new@o1"),
						summary("new@o1")
					]
				}
			}
		});
		expect(
			compare(
				[],
				[
					"new@o1",
					"new@x"
				],
				[],
				{
					region: REGION
				}
			).worse.diags?.extra
		).toHaveLength(2);
	});

	it("counts a code the uninterrupted run raised before the point only in diagCounts", () => {
		expect(
			compare(
				[],
				[
					"once@x"
				],
				[],
				{
					prior: [
						"once@y"
					]
				}
			)
		).toEqual({
			worse: {},
			reported: {},
			changed: [],
			diagCounts: [
				{
					code: "test/once",
					uninterrupted: 0,
					dataOnly: 0,
					resumed: 1
				}
			]
		});
	});

	it("counts a known code raised more or fewer times only in diagCounts", () => {
		expect(
			compare(
				[
					"known@x"
				],
				[
					"known@x",
					"known@y",
					"known@z"
				],
				[
					"known@x"
				]
			)
		).toEqual({
			worse: {},
			reported: {},
			changed: [],
			diagCounts: [
				{
					code: "test/known",
					uninterrupted: 1,
					dataOnly: 1,
					resumed: 3
				}
			]
		});
		expect(
			compare(
				[
					"known@x",
					"known@y"
				],
				[
					"known@x"
				],
				[]
			).worse
		).toEqual({});
		expect(
			compare(
				[
					"known@x"
				],
				[
					"known@x"
				],
				[
					"known@x"
				]
			).diagCounts
		).toEqual([]);
	});

	it("counts a code the resumed run no longer raises after the point while the data-only run does", () => {
		expect(
			compare(
				[
					"gone@x"
				],
				[],
				[
					"gone@x"
				]
			).worse
		).toEqual({
			diags: {
				missing: [
					summary("gone@x")
				],
				extra: []
			}
		});
		expect(
			compare(
				[
					"gone@o1"
				],
				[],
				[
					"gone@o1"
				],
				{
					region: REGION
				}
			).reported.diags?.missing
		).toEqual([
			summary("gone@o1")
		]);
		expect(
			compare(
				[
					"gone@x"
				],
				[],
				[]
			).worse
		).toEqual({});
	});

	it("reports a missing code when every one of the uninterrupted run's occurrences names the region", () => {
		expect(
			compare(
				[
					"gone@o1",
					"gone@o1"
				],
				[],
				[
					"gone@o1"
				],
				{
					region: REGION
				}
			)
		).toMatchObject({
			worse: {},
			reported: {
				diags: {
					missing: [
						summary("gone@o1"),
						summary("gone@o1")
					],
					extra: []
				}
			}
		});
		expect(
			compare(
				[
					"gone@o1",
					"gone@x"
				],
				[],
				[
					"gone@o1"
				],
				{
					region: REGION
				}
			)
		).toMatchObject({
			worse: {
				diags: {
					missing: [
						summary("gone@o1"),
						summary("gone@x")
					]
				}
			},
			reported: {}
		});
	});
});
