import type { IActionGenerator, IEffect, IRuntime } from "treflex";
import type { IDifferences, IDifferentialReport, IDifferentialSkip, IDifferentialStep, IRestorePoint } from "treflex/snapshot";
import type { ICharge, ILedger } from "../server/effects";
import type { IFakeServer } from "../server/fakeServer";
import type { IGates } from "../testing/gates";
import type { ICheckoutRequest, IShop } from "./shop";
import { defineEffect, guids, named, settled } from "treflex";
import { differentialRestore, dispatchStep, restoreTestRuntime } from "treflex/snapshot";
import { describe, expect, it } from "vitest";
import { createFakeServer, serverImplementations } from "../server/fakeServer";
import { ADA, askAt } from "../testing/boot";
import { createGates } from "../testing/gates";
import { PAID_BEFORE_RELOAD, QUANTITY_LOST, RELOADED, repairRestore, VOUCHER_LOST } from "./repair";
import {
	ADDRESS,
	APPLY_VOUCHER_NAME,
	answerAddress,
	answerConfirm,
	answerDelivery,
	applyVoucher,
	CHECKOUT_NAME,
	CONFIRM,
	checkout,
	DELIVERY,
	atServerOf as factsOf,
	getDefaultState,
	ORDER_ID,
	readServer,
	SET_QUANTITY_NAME,
	SHOP_ID,
	SUGGEST_NAME,
	setQuantity,
	suggest
} from "./shop";

const QUOTE = "Server/QuoteDelivery";
const RESERVE = "Server/ReserveStock";
const PAY = "Server/Pay";
const VOUCHER = "Server/CheckVoucher";
const SUGGESTIONS = "Server/FetchSuggestions";

const RESUMING = {
	build: "test",
	resume: true
} as const;

interface IRelease extends IEffect {
	Type: "Test/Release";
	Kind: string;
}

const releaseRequest = defineEffect<IRelease, void>("Test/Release");

function* release(_draft: IShop, kind: string): IActionGenerator {
	yield* releaseRequest({
		Kind: kind
	});
}
named(release, "Test/Release");

let gates: IGates;
/** Each run's fake server, in the order the tool asks for stubs: the uninterrupted run's, then each restored run's. */
const servers: IFakeServer[] = [];

function stubs() {
	const server = createFakeServer();
	servers.push(server);
	const run = createGates([
		QUOTE,
		RESERVE,
		PAY,
		VOUCHER,
		SUGGESTIONS
	]);
	gates = run;
	return {
		...serverImplementations(server, run.wait),
		"Test/Release": ({ Kind }: IRelease) => {
			run.release(Kind);
		}
	};
}

/** Lets the server answer one waiting request of `type`; a run where none waits skips the step. */
const answered = (type: string): IDifferentialStep<IShop> =>
	dispatchStep<
		IShop,
		[
			string
		]
	>(release, SHOP_ID, () => {
		if (gates.waiting(type) === 0) throw new Error(`no ${type} request is waiting`);
		return [
			type
		];
	});

const start: IDifferentialStep<IShop> = dispatchStep(checkout, ORDER_ID);

const address: IDifferentialStep<IShop> = dispatchStep(answerAddress, ORDER_ID, (runtime) => [
	askAt(runtime, ADDRESS),
	ADA
]);

const standard: IDifferentialStep<IShop> = dispatchStep(answerDelivery, ORDER_ID, (runtime) => [
	askAt<string>(runtime, DELIVERY),
	"standard"
]);

const confirm: IDifferentialStep<IShop> = dispatchStep(answerConfirm, ORDER_ID, (runtime) => [
	askAt<boolean>(runtime, CONFIRM),
	true
]);

const decline: IDifferentialStep<IShop> = dispatchStep(answerConfirm, ORDER_ID, (runtime) => [
	askAt<boolean>(runtime, CONFIRM),
	false
]);

const read: IDifferentialStep<IShop> = dispatchStep(readServer, ORDER_ID);

const voucherStep = (): IDifferentialStep<IShop> =>
	dispatchStep(applyVoucher, ORDER_ID, [
		"SAVE10"
	]);

const quantityStep = (sku: string, quantity: number): IDifferentialStep<IShop> =>
	dispatchStep(setQuantity, ORDER_ID, [
		sku,
		quantity
	]);

/** A step of its own, so it can be taken out of a script by reference without taking out another use of `step`. */
const again = (step: IDifferentialStep<IShop>): IDifferentialStep<IShop> => ({
	...step
});

const straight = {
	voucher: voucherStep(),
	quantity: quantityStep("tea", 4)
};

const changes = {
	voucher: voucherStep(),
	voucherAnswer: answered(VOUCHER),
	confirmAgain: again(confirm)
};

const suggestions = {
	suggest: dispatchStep(suggest, "Suggestions", [
		[
			"tea",
			"mug"
		]
	]),
	suggestAnswer: answered(SUGGESTIONS)
};

const regaining = {
	voucher: voucherStep(),
	voucherAnswer: answered(VOUCHER)
};

const queued = {
	voucher: voucherStep(),
	voucherAnswer: answered(VOUCHER),
	quantity: quantityStep("mug", 3),
	reserveAgain: answered(RESERVE),
	confirmAgain: again(confirm)
};

const SCRIPTS: Record<string, IDifferentialStep<IShop>[]> = {
	straight: [
		start,
		address,
		answered(QUOTE),
		standard,
		answered(RESERVE),
		confirm,
		straight.voucher,
		straight.quantity,
		answered(PAY),
		read
	],
	changes: [
		start,
		quantityStep("tea", 2),
		address,
		answered(QUOTE),
		standard,
		answered(RESERVE),
		changes.voucher,
		changes.voucherAnswer,
		confirm,
		changes.confirmAgain,
		answered(PAY),
		read
	],
	suggestions: [
		start,
		suggestions.suggest,
		address,
		answered(QUOTE),
		suggestions.suggestAnswer,
		standard,
		answered(RESERVE),
		confirm,
		answered(PAY),
		read
	],
	regaining: [
		start,
		address,
		regaining.voucher,
		answered(QUOTE),
		regaining.voucherAnswer,
		standard,
		answered(RESERVE),
		confirm,
		answered(PAY),
		read
	],
	queued: [
		queued.voucher,
		start,
		queued.voucherAnswer,
		address,
		answered(QUOTE),
		standard,
		queued.quantity,
		answered(RESERVE),
		confirm,
		queued.reserveAgain,
		queued.confirmAgain,
		answered(PAY),
		read
	],
	cancel: [
		start,
		address,
		answered(QUOTE),
		standard,
		answered(RESERVE),
		decline,
		read
	]
};

/** Per script, the steps each action a restore can drop beside the flow dispatches or needs, by its durable name. */
const DROPPABLE: Record<string, Record<string, IDifferentialStep<IShop>[]>> = {
	straight: {
		[APPLY_VOUCHER_NAME]: [
			straight.voucher
		],
		[SET_QUANTITY_NAME]: [
			straight.quantity
		]
	},
	changes: {
		[APPLY_VOUCHER_NAME]: [
			changes.voucher,
			changes.voucherAnswer,
			changes.confirmAgain
		]
	},
	suggestions: {
		[SUGGEST_NAME]: [
			suggestions.suggest,
			suggestions.suggestAnswer
		]
	},
	regaining: {
		[APPLY_VOUCHER_NAME]: [
			regaining.voucher,
			regaining.voucherAnswer
		]
	},
	queued: {
		[APPLY_VOUCHER_NAME]: [
			queued.voucher,
			queued.voucherAnswer
		],
		[SET_QUANTITY_NAME]: [
			queued.quantity,
			queued.reserveAgain,
			queued.confirmAgain
		]
	},
	cancel: {}
};

const NOTICES: Record<string, string> = {
	[RELOADED]: "reloaded",
	[PAID_BEFORE_RELOAD]: "paid before reload",
	[VOUCHER_LOST]: "voucher lost",
	[`${RELOADED} ${VOUCHER_LOST}`]: "reloaded, voucher lost",
	[QUANTITY_LOST]: "quantity lost",
	[`${RELOADED} ${QUANTITY_LOST}`]: "reloaded, quantity lost"
};

const short = (name: string | null): string => (name ?? "(anonymous)").replace(/^(Checkout|Server)\//, "");

/** One runtime the tool built, in the order it built them. */
interface IBuilt {
	runtime: IRuntime<IShop>;
	wait: string | null;
	setupAt: number;
	repairAt?: number;
}

interface IRestoredRun {
	differences: IDifferences;
	skipped: IDifferentialSkip[];
	ended: IShop;
	endedWait: string | null;
	ledger: ILedger;
	ms: number;
}

interface IPlayedPoint {
	point: IRestorePoint;
	wait: string | null;
	resumed: IRestoredRun;
	dataOnly?: IRestoredRun;
}

interface IPlayed {
	report: IDifferentialReport;
	uninterrupted: IShop;
	uninterruptedLedger: ILedger;
	points: IPlayedPoint[];
}

const copy = (state: IShop): IShop => JSON.parse(JSON.stringify(state));

function watch(built: IBuilt): void {
	const flows = new Set<string>();
	built.runtime.on(
		"record",
		(record) => {
			if (record.Kind === "action:start") {
				if (record.Name === CHECKOUT_NAME) flows.add(record.ActionId);
				return;
			}
			if (!flows.has(record.ActionId) || record.Type === "generateGuid") return;
			built.wait =
				record.Type === "ask"
					? (
							record.Descriptor as {
								Request: ICheckoutRequest;
							}
						).Request.Path
					: record.Type;
		},
		{
			kinds: [
				"action:start",
				"effect"
			]
		}
	);
}

/**
 * Plays a script with `compareDataOnly` and resume on, or without the option and with resume off. The tool builds
 * the uninterrupted run's runtime and then, per point, the run to the point and its restore: twice, the resumed
 * run's and then the data-only run's, with the option.
 */
async function play(script: IDifferentialStep<IShop>[], compared: boolean): Promise<IPlayed> {
	const built: IBuilt[] = [];
	servers.length = 0;
	const report = await differentialRestore(
		{
			seed: getDefaultState(),
			setup: (runtime) => {
				const entry: IBuilt = {
					runtime,
					wait: null,
					setupAt: performance.now()
				};
				built.push(entry);
				watch(entry);
			},
			repair: (runtime, result) => {
				const entry = built.find((b) => b.runtime === runtime)!;
				entry.repairAt = performance.now();
				return repairRestore(runtime, result);
			},
			effectStubs: stubs,
			...(compared
				? {
						options: RESUMING,
						compareDataOnly: true
					}
				: {})
		},
		script
	);
	const runs = compared ? 2 : 1;
	expect(built).toHaveLength(1 + 2 * runs * report.points.length);
	expect(servers).toHaveLength(1 + runs * report.points.length);
	const restored = (run: number, differences: IDifferences, skipped: IDifferentialSkip[]): IRestoredRun => {
		const at = 2 + 2 * run;
		return {
			differences,
			skipped,
			ended: copy(built[at]!.runtime.state),
			endedWait: built[at]!.wait,
			ledger: servers[1 + run]!.ledger(),
			ms: built[at]!.repairAt! - built[at]!.setupAt
		};
	};
	return {
		report,
		uninterrupted: copy(built[0]!.runtime.state),
		uninterruptedLedger: servers[0]!.ledger(),
		points: report.points.map((point, i) => ({
			point,
			wait: built[1 + 2 * runs * i]!.wait,
			resumed: restored(runs * i, point.differences, point.skipped),
			...(compared
				? {
						dataOnly: restored(runs * i + 1, point.dataOnly!.differences, point.dataOnly!.skipped)
					}
				: {})
		}))
	};
}

const plays = new Map<string, Promise<IPlayed>>();

function played(name: string, compared = true): Promise<IPlayed> {
	const key = `${name} ${compared}`;
	let found = plays.get(key);
	if (!found) {
		found = play(SCRIPTS[name]!, compared);
		plays.set(key, found);
	}
	return found;
}

const caughtOf = (point: IRestorePoint, wait: string | null): string =>
	point.inFlight
		.map(
			(entry) =>
				`${short(entry.Name)} ${entry.State}${entry.Name === CHECKOUT_NAME && entry.State !== "queued" ? ` at ${short(wait)}` : ""}`
		)
		.join(", ");

interface IOutcome {
	Paid: number | null;
	AtServer: string;
	Charges: number;
	Unfinished: string[];
	Notice: string | null;
	Skipped: number[];
	Differ: string[];
}

const atServerOf = (ledger: ILedger): string => {
	const server = factsOf(ledger, ORDER_ID);
	return server.Status === null ? "none" : `${server.Status}: ${server.Lines.map((line) => `${line.Sku} ${line.Quantity}`).join(", ")}`;
};

/** A path's first two segments, or three under the order's server facts. */
const placeOf = (path: string): string => {
	const segments = path.split(/[.[]/);
	return segments.slice(0, segments[1] === "Server" ? 3 : 2).join(".");
};

function outcomeOf(run: IRestoredRun): IOutcome {
	return {
		Paid: run.ended.Order.Receipt?.Total ?? null,
		AtServer: atServerOf(run.ledger),
		Charges: factsOf(run.ledger, ORDER_ID).Charges.length,
		Unfinished: (run.differences.unfinished?.inFlight ?? []).map(
			(entry) => `${short(entry.Name)} ${entry.State}${entry.Name === CHECKOUT_NAME ? ` at ${short(run.endedWait)}` : ""}`
		),
		Notice: run.ended.Order.Notice === null ? null : (NOTICES[run.ended.Order.Notice] ?? run.ended.Order.Notice),
		Skipped: run.skipped.map((skip) => skip.step),
		Differ: [
			...new Set((run.differences.state ?? []).map((d) => placeOf(d.path)))
		]
	};
}

type IRow = [
	after: number,
	caught: string,
	outcome: IOutcome
];

const tableOf = (run: IPlayed, which: "resumed" | "dataOnly"): IRow[] =>
	run.points.map((p) => [
		p.point.after,
		caughtOf(p.point, p.wait),
		outcomeOf(p[which]!)
	]);

const SERVER = [
	"Order.Server.Status",
	"Order.Server.Lines",
	"Order.Server.Charges"
];

const STATUS_AND_CHARGES = [
	"Order.Server.Status",
	"Order.Server.Charges"
];

const sameAs = (paid: number | null, atServer: string): IOutcome => ({
	Paid: paid,
	AtServer: atServer,
	Charges: paid === null ? 0 : 1,
	Unfinished: [],
	Notice: null,
	Skipped: [],
	Differ: []
});

const carriedOn = (paid: number | null, atServer: string): IOutcome => ({
	...sameAs(paid, atServer),
	Notice: "reloaded",
	Differ: [
		"Order.Notice"
	]
});

const paidBeforeReload = (paid: number, atServer: string, skipped: number): IOutcome => ({
	...sameAs(paid, atServer),
	Notice: "paid before reload",
	Skipped: [
		skipped
	],
	Differ: [
		"Order.Notice"
	]
});

const backToAddress = (
	atServer: string,
	skipped: number[],
	{
		also = [],
		notice = "reloaded",
		running = [],
		server = SERVER
	}: {
		also?: string[];
		notice?: string;
		running?: string[];
		server?: string[];
	} = {}
): IOutcome => ({
	Paid: null,
	AtServer: atServer,
	Charges: 0,
	Unfinished: [
		"Checkout open at Address",
		...running
	],
	Notice: notice,
	Skipped: skipped,
	Differ: [
		...also,
		"Order.PaymentKey",
		"Order.Receipt",
		"Order.Notice",
		...server
	]
});

const backToAddressUnpaid = (atServer: string, skipped: number[], also: string[] = []): IOutcome => ({
	Paid: null,
	AtServer: atServer,
	Charges: 0,
	Unfinished: [
		"Checkout open at Address"
	],
	Notice: "reloaded",
	Skipped: skipped,
	Differ: [
		"Order.Notice",
		...also
	]
});

const fullPrice = (
	paid: number,
	atServer: string,
	notice: string | null,
	skipped: number[] = [
		3
	]
): IOutcome => ({
	Paid: paid,
	AtServer: atServer,
	Charges: 1,
	Unfinished: [],
	Notice: notice,
	Skipped: skipped,
	Differ: [
		"Order.Voucher",
		"Order.Receipt",
		...(notice === null
			? []
			: [
					"Order.Notice"
				]),
		"Order.Server.Charges"
	]
});

interface IExpected {
	paid: number | null;
	atServer: string;
	dataOnly: IRow[];
	resumed: IRow[];
	/** Per point, each drop's name and reason, and the comparison's `changed` and `reported` paths. */
	compared: [
		after: number,
		dropped: string[],
		changed: string[],
		reported: string[]
	][];
}

// biome-ignore format: one row per restore point
const EXPECTED: Record<string, IExpected> = {
	straight: {
		paid: 5400,
		atServer: "paid: tea 1, mug 2",
		dataOnly: [
			[1, "Checkout open at Address", carriedOn(5400, "paid: tea 1, mug 2")],
			[2, "Checkout open at QuoteDelivery", backToAddress("none", [3, 4, 5, 6, 9], { running: ["ApplyVoucher holding", "SetQuantity queued", "ReadServer queued"] })],
			[3, "Checkout open at Delivery", backToAddress("none", [4, 5, 6, 9], { running: ["ApplyVoucher holding", "SetQuantity queued", "ReadServer queued"] })],
			[4, "Checkout holding at ReserveStock", backToAddress("released: tea 1, mug 2", [5, 6, 9], { running: ["ApplyVoucher holding", "SetQuantity queued", "ReadServer queued"] })],
			[5, "Checkout open at Confirm", backToAddress("released: tea 1, mug 2", [6, 9], { running: ["ApplyVoucher holding", "SetQuantity queued", "ReadServer queued"] })],
			[6, "Checkout holding at Pay", paidBeforeReload(5400, "paid: tea 1, mug 2", 9)],
			[7, "Checkout holding at Pay, ApplyVoucher queued", paidBeforeReload(5400, "paid: tea 1, mug 2", 9)],
			[8, "Checkout holding at Pay, ApplyVoucher queued, SetQuantity queued", paidBeforeReload(5400, "paid: tea 1, mug 2", 9)]
		],
		resumed: [
			[1, "Checkout open at Address", sameAs(5400, "paid: tea 1, mug 2")],
			[2, "Checkout open at QuoteDelivery", sameAs(5400, "paid: tea 1, mug 2")],
			[3, "Checkout open at Delivery", sameAs(5400, "paid: tea 1, mug 2")],
			[4, "Checkout holding at ReserveStock", sameAs(5400, "paid: tea 1, mug 2")],
			[5, "Checkout open at Confirm", sameAs(5400, "paid: tea 1, mug 2")],
			[6, "Checkout holding at Pay", paidBeforeReload(5400, "paid: tea 1, mug 2", 9)],
			[7, "Checkout holding at Pay, ApplyVoucher queued", paidBeforeReload(5400, "paid: tea 1, mug 2", 9)],
			[8, "Checkout holding at Pay, ApplyVoucher queued, SetQuantity queued", paidBeforeReload(5400, "paid: tea 1, mug 2", 9)]
		],
		compared: [
			[1, [], [], []],
			[2, [], [], []],
			[3, [], [], []],
			[4, [], [], []],
			[5, [], [], []],
			[6, ["Checkout not-idempotent"], [], []],
			[7, ["Checkout not-idempotent", "ApplyVoucher not-marked"], [], []],
			[8, ["Checkout not-idempotent", "ApplyVoucher not-marked", "SetQuantity not-marked"], [], []]
		]
	},
	changes: {
		paid: 6000,
		atServer: "paid: tea 2, mug 2",
		dataOnly: [
			[1, "Checkout open at Address", carriedOn(6000, "paid: tea 2, mug 2")],
			[2, "Checkout open at Address", carriedOn(6000, "paid: tea 2, mug 2")],
			[3, "Checkout open at QuoteDelivery", backToAddress("none", [4, 5, 6, 9, 10, 11])],
			[4, "Checkout open at Delivery", backToAddress("none", [5, 6, 9, 10, 11])],
			[5, "Checkout holding at ReserveStock", backToAddress("released: tea 2, mug 2", [6, 9, 10, 11], { server: STATUS_AND_CHARGES })],
			[6, "Checkout open at Confirm", backToAddress("released: tea 2, mug 2", [9, 10, 11], { server: STATUS_AND_CHARGES })],
			[7, "Checkout open at Confirm, ApplyVoucher holding", backToAddress("released: tea 2, mug 2", [8, 9, 10, 11], { also: ["Order.Voucher"], notice: "reloaded, voucher lost", server: STATUS_AND_CHARGES })],
			[8, "Checkout open at Confirm", backToAddress("released: tea 2, mug 2", [9, 10, 11], { server: STATUS_AND_CHARGES })],
			[9, "Checkout open at Confirm", backToAddress("released: tea 2, mug 2", [10, 11], { server: STATUS_AND_CHARGES })],
			[10, "Checkout holding at Pay", paidBeforeReload(6000, "paid: tea 2, mug 2", 11)]
		],
		resumed: [
			[1, "Checkout open at Address", sameAs(6000, "paid: tea 2, mug 2")],
			[2, "Checkout open at Address", sameAs(6000, "paid: tea 2, mug 2")],
			[3, "Checkout open at QuoteDelivery", sameAs(6000, "paid: tea 2, mug 2")],
			[4, "Checkout open at Delivery", sameAs(6000, "paid: tea 2, mug 2")],
			[5, "Checkout holding at ReserveStock", sameAs(6000, "paid: tea 2, mug 2")],
			[6, "Checkout open at Confirm", sameAs(6000, "paid: tea 2, mug 2")],
			[7, "Checkout open at Confirm, ApplyVoucher holding", fullPrice(6600, "paid: tea 2, mug 2", "voucher lost", [8, 10])],
			[8, "Checkout open at Confirm", sameAs(6000, "paid: tea 2, mug 2")],
			[9, "Checkout open at Confirm", sameAs(6000, "paid: tea 2, mug 2")],
			[10, "Checkout holding at Pay", paidBeforeReload(6000, "paid: tea 2, mug 2", 11)]
		],
		compared: [
			[1, [], [], []],
			[2, [], [], []],
			[3, [], [], []],
			[4, [], [], []],
			[5, [], [], []],
			[6, [], [], []],
			[7, ["ApplyVoucher not-marked"], ["Order.Notice"], []],
			[8, [], [], []],
			[9, [], [], []],
			[10, ["Checkout not-idempotent"], [], []]
		]
	},
	suggestions: {
		paid: 5400,
		atServer: "paid: tea 1, mug 2",
		dataOnly: [
			[1, "Checkout open at Address", carriedOn(5400, "paid: tea 1, mug 2")],
			[2, "Checkout open at Address, Suggest holding", carriedOn(5400, "paid: tea 1, mug 2")],
			[3, "Checkout open at QuoteDelivery, Suggest holding", backToAddress("none", [4, 6, 7, 8, 9])],
			[4, "Checkout open at Delivery, Suggest holding", backToAddress("none", [6, 7, 8, 9])],
			[5, "Checkout open at Delivery", backToAddress("none", [6, 7, 8, 9])],
			[6, "Checkout holding at ReserveStock", backToAddress("released: tea 1, mug 2", [7, 8, 9], { server: STATUS_AND_CHARGES })],
			[7, "Checkout open at Confirm", backToAddress("released: tea 1, mug 2", [8, 9], { server: STATUS_AND_CHARGES })],
			[8, "Checkout holding at Pay", paidBeforeReload(5400, "paid: tea 1, mug 2", 9)]
		],
		resumed: [
			[1, "Checkout open at Address", sameAs(5400, "paid: tea 1, mug 2")],
			[2, "Checkout open at Address, Suggest holding", sameAs(5400, "paid: tea 1, mug 2")],
			[3, "Checkout open at QuoteDelivery, Suggest holding", sameAs(5400, "paid: tea 1, mug 2")],
			[4, "Checkout open at Delivery, Suggest holding", sameAs(5400, "paid: tea 1, mug 2")],
			[5, "Checkout open at Delivery", sameAs(5400, "paid: tea 1, mug 2")],
			[6, "Checkout holding at ReserveStock", sameAs(5400, "paid: tea 1, mug 2")],
			[7, "Checkout open at Confirm", sameAs(5400, "paid: tea 1, mug 2")],
			[8, "Checkout holding at Pay", paidBeforeReload(5400, "paid: tea 1, mug 2", 9)]
		],
		compared: [
			[1, [], [], []],
			[2, ["Suggest not-marked"], [], []],
			[3, ["Suggest not-marked"], [], []],
			[4, ["Suggest not-marked"], [], []],
			[5, [], [], []],
			[6, [], [], []],
			[7, [], [], []],
			[8, ["Checkout not-idempotent"], [], []]
		]
	},
	regaining: {
		paid: 4920,
		atServer: "paid: tea 1, mug 2",
		dataOnly: [
			[1, "Checkout open at Address", carriedOn(4920, "paid: tea 1, mug 2")],
			[2, "Checkout open at QuoteDelivery", backToAddress("none", [4, 6, 7, 8, 9])],
			[3, "Checkout open at QuoteDelivery, ApplyVoucher holding", backToAddress("none", [4, 5, 6, 7, 8, 9], { also: ["Order.Voucher"], notice: "reloaded, voucher lost" })],
			[4, "Checkout regaining at QuoteDelivery, ApplyVoucher holding", backToAddress("none", [5, 6, 7, 8, 9], { also: ["Order.Voucher"], notice: "reloaded, voucher lost" })],
			[5, "Checkout open at Delivery", backToAddress("none", [6, 7, 8, 9])],
			[6, "Checkout holding at ReserveStock", backToAddress("released: tea 1, mug 2", [7, 8, 9], { server: STATUS_AND_CHARGES })],
			[7, "Checkout open at Confirm", backToAddress("released: tea 1, mug 2", [8, 9], { server: STATUS_AND_CHARGES })],
			[8, "Checkout holding at Pay", paidBeforeReload(4920, "paid: tea 1, mug 2", 9)]
		],
		resumed: [
			[1, "Checkout open at Address", sameAs(4920, "paid: tea 1, mug 2")],
			[2, "Checkout open at QuoteDelivery", sameAs(4920, "paid: tea 1, mug 2")],
			[3, "Checkout open at QuoteDelivery, ApplyVoucher holding", fullPrice(5400, "paid: tea 1, mug 2", "voucher lost", [5])],
			[4, "Checkout regaining at QuoteDelivery, ApplyVoucher holding", backToAddress("none", [5, 6, 7, 8, 9], { also: ["Order.Voucher"], notice: "reloaded, voucher lost" })],
			[5, "Checkout open at Delivery", sameAs(4920, "paid: tea 1, mug 2")],
			[6, "Checkout holding at ReserveStock", sameAs(4920, "paid: tea 1, mug 2")],
			[7, "Checkout open at Confirm", sameAs(4920, "paid: tea 1, mug 2")],
			[8, "Checkout holding at Pay", paidBeforeReload(4920, "paid: tea 1, mug 2", 9)]
		],
		compared: [
			[1, [], [], []],
			[2, [], [], []],
			[3, ["ApplyVoucher not-marked"], ["Order.Notice"], []],
			[4, ["Checkout off-list", "ApplyVoucher not-marked"], [], []],
			[5, [], [], []],
			[6, [], [], []],
			[7, [], [], []],
			[8, ["Checkout not-idempotent"], [], []]
		]
	},
	queued: {
		paid: 6540,
		atServer: "paid: tea 1, mug 3",
		dataOnly: [
			[1, "ApplyVoucher holding", fullPrice(7200, "paid: tea 1, mug 3", "voucher lost")],
			[2, "ApplyVoucher holding, Checkout queued", fullPrice(7200, "paid: tea 1, mug 3", "reloaded, voucher lost")],
			[3, "Checkout open at Address", carriedOn(6540, "paid: tea 1, mug 3")],
			[4, "Checkout open at QuoteDelivery", backToAddress("none", [5, 6, 8, 9, 10, 11, 12])],
			[5, "Checkout open at Delivery", backToAddress("none", [6, 8, 9, 10, 11, 12])],
			[6, "Checkout holding at ReserveStock", backToAddress("released: tea 1, mug 2", [8, 9, 10, 11, 12])],
			[7, "Checkout holding at ReserveStock, SetQuantity queued", backToAddress("released: tea 1, mug 2", [8, 9, 10, 11, 12], { also: ["Order.Lines"], notice: "reloaded, quantity lost" })],
			[8, "Checkout open at Confirm", backToAddress("released: tea 1, mug 2", [9, 10, 11, 12])],
			[9, "Checkout holding at ReserveStock", backToAddress("released: tea 1, mug 3", [10, 11, 12], { server: STATUS_AND_CHARGES })],
			[10, "Checkout open at Confirm", backToAddress("released: tea 1, mug 3", [11, 12], { server: STATUS_AND_CHARGES })],
			[11, "Checkout holding at Pay", paidBeforeReload(6540, "paid: tea 1, mug 3", 12)]
		],
		resumed: [
			[1, "ApplyVoucher holding", fullPrice(7200, "paid: tea 1, mug 3", "voucher lost")],
			[2, "ApplyVoucher holding, Checkout queued", fullPrice(7200, "paid: tea 1, mug 3", "reloaded, voucher lost")],
			[3, "Checkout open at Address", sameAs(6540, "paid: tea 1, mug 3")],
			[4, "Checkout open at QuoteDelivery", sameAs(6540, "paid: tea 1, mug 3")],
			[5, "Checkout open at Delivery", sameAs(6540, "paid: tea 1, mug 3")],
			[6, "Checkout holding at ReserveStock", sameAs(6540, "paid: tea 1, mug 3")],
			[7, "Checkout holding at ReserveStock, SetQuantity queued", { Paid: 4920, AtServer: "paid: tea 1, mug 2", Charges: 1, Unfinished: [], Notice: "quantity lost", Skipped: [10, 11], Differ: ["Order.Lines", "Order.Receipt", "Order.Notice", "Order.Server.Lines", "Order.Server.Charges"] }],
			[8, "Checkout open at Confirm", sameAs(6540, "paid: tea 1, mug 3")],
			[9, "Checkout holding at ReserveStock", sameAs(6540, "paid: tea 1, mug 3")],
			[10, "Checkout open at Confirm", sameAs(6540, "paid: tea 1, mug 3")],
			[11, "Checkout holding at Pay", paidBeforeReload(6540, "paid: tea 1, mug 3", 12)]
		],
		compared: [
			[1, ["ApplyVoucher not-marked"], [], []],
			[2, ["ApplyVoucher not-marked", "Checkout behind"], [], []],
			[3, [], [], []],
			[4, [], [], []],
			[5, [], [], []],
			[6, [], [], []],
			[7, ["SetQuantity not-marked"], ["Order.Notice"], []],
			[8, [], [], []],
			[9, [], [], []],
			[10, [], [], []],
			[11, ["Checkout not-idempotent"], [], []]
		]
	},
	cancel: {
		paid: null,
		atServer: "released: tea 1, mug 2",
		dataOnly: [
			[1, "Checkout open at Address", carriedOn(null, "released: tea 1, mug 2")],
			[2, "Checkout open at QuoteDelivery", backToAddressUnpaid("none", [3, 4, 5, 6], ["Order.Server.Status", "Order.Server.Lines"])],
			[3, "Checkout open at Delivery", backToAddressUnpaid("none", [4, 5, 6], ["Order.Server.Status", "Order.Server.Lines"])],
			[4, "Checkout holding at ReserveStock", backToAddressUnpaid("released: tea 1, mug 2", [5, 6])],
			[5, "Checkout open at Confirm", backToAddressUnpaid("released: tea 1, mug 2", [6])]
		],
		resumed: [
			[1, "Checkout open at Address", sameAs(null, "released: tea 1, mug 2")],
			[2, "Checkout open at QuoteDelivery", sameAs(null, "released: tea 1, mug 2")],
			[3, "Checkout open at Delivery", sameAs(null, "released: tea 1, mug 2")],
			[4, "Checkout holding at ReserveStock", sameAs(null, "released: tea 1, mug 2")],
			[5, "Checkout open at Confirm", sameAs(null, "released: tea 1, mug 2")]
		],
		compared: [
			[1, [], [], []],
			[2, [], [], []],
			[3, [], [], []],
			[4, [], [], []],
			[5, [], [], []]
		]
	}
};

/** The points measure 2 exempts today, pinned so a change to the exemption's reach shows. */
const BESIDE_DROPPED: Record<string, number[]> = {
	changes: [
		7
	],
	regaining: [
		3
	],
	queued: [
		7
	]
};

const RESUMES_AT = [
	ADDRESS,
	DELIVERY,
	CONFIRM,
	QUOTE,
	RESERVE
];

/** The order's lineage: the shop above it. Its lines carry no `$Id`, so nothing is below it. */
const LINEAGE = [
	ORDER_ID,
	SHOP_ID
];

const MINTED = /^~?(step\d+|restore|setup)-\d+$/;

/**
 * A run's end, its tree without the order's notice and its server's ledger, with each id the tool minted renamed
 * by where it first appears, so two runs that minted one entity at different steps compare equal.
 */
function endOf(state: IShop, ledger: ILedger): unknown {
	const names = new Map<string, string>();
	const rename = (value: unknown): unknown => {
		if (typeof value === "string") {
			if (!MINTED.test(value)) return value;
			const bare = value.replace(/^~/, "");
			if (!names.has(bare)) names.set(bare, `minted-${names.size + 1}`);
			return `${value.startsWith("~") ? "~" : ""}${names.get(bare)}`;
		}
		if (Array.isArray(value)) return value.map(rename);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					rename(key),
					rename(item)
				])
			);
		}
		return value;
	};
	return rename({
		state: {
			...state,
			Order: {
				...state.Order,
				Notice: null
			}
		},
		ledger
	});
}

/**
 * Measure 2's exemption: the restore reported a drop on the order or above it, and the resumed run ends as the
 * uninterrupted run of the script without the dropped work's steps does, the notice the repair writes aside.
 */
async function exempt(name: string, p: IPlayedPoint): Promise<boolean> {
	const beside = p.point.result.dropped.filter((drop) => LINEAGE.includes(drop.entityId));
	if (beside.length === 0) return false;
	const removed = new Set(
		beside.flatMap((drop) => {
			const steps = DROPPABLE[name]![drop.name ?? ""];
			if (!steps) throw new Error(`the ${name} script declares no steps for ${drop.name}, which dropped after step ${p.point.after}`);
			return steps;
		})
	);
	const without = await play(
		SCRIPTS[name]!.filter((step) => !removed.has(step)),
		false
	);
	return (
		JSON.stringify(endOf(p.resumed.ended, p.resumed.ledger)) === JSON.stringify(endOf(without.uninterrupted, without.uninterruptedLedger))
	);
}

const pathsOf = (differences: IDifferences): string[] => (differences.state ?? []).map((d) => d.path);

const mostChargesOnOneOrder = (charges: readonly ICharge[]): number =>
	Math.max(0, ...charges.map((charge) => charges.filter((c) => c.OrderId === charge.OrderId).length));

describe("every restore point of the checkout", () => {
	for (const name of Object.keys(SCRIPTS)) {
		it(`pins what a reload does in the ${name} script, with resume and without`, async () => {
			const run = await played(name);
			const expected = EXPECTED[name]!;
			expect(run.uninterrupted.Order.Receipt?.Total ?? null).toBe(expected.paid);
			expect(factsOf(run.uninterruptedLedger, ORDER_ID).Charges).toHaveLength(expected.paid === null ? 0 : 1);
			expect(atServerOf(run.uninterruptedLedger)).toBe(expected.atServer);
			expect(tableOf(run, "dataOnly")).toEqual(expected.dataOnly);
			expect(tableOf(run, "resumed")).toEqual(expected.resumed);
			expect(
				run.points.map((p) => [
					p.point.after,
					p.point.result.dropped.map((drop) => `${short(drop.name)} ${drop.reason}`),
					p.point.comparison!.changed.map((c) => c.path),
					pathsOf(p.point.comparison!.reported)
				])
			).toEqual(expected.compared);
		});

		it(`is never worse with resume than without it in the ${name} script`, async () => {
			const run = await played(name);
			expect(run.report.worse).toEqual([]);
		});

		it(`ends as the uninterrupted run at every point the ${name} script catches the flow at a question, a quote or a reservation`, async () => {
			const run = await played(name);
			const caught = run.points.filter((p) =>
				p.point.inFlight.some(
					(entry) => entry.Name === CHECKOUT_NAME && (entry.State === "open" || entry.State === "holding") && RESUMES_AT.includes(p.wait!)
				)
			);
			const exempted: number[] = [];
			for (const p of caught.filter((c) => !c.point.same)) {
				expect(
					await exempt(name, p),
					`the point after step ${p.point.after} doesn't end as the uninterrupted run, and no drop beside the flow explains it`
				).toBe(true);
				exempted.push(p.point.after);
			}
			expect(exempted).toEqual(BESIDE_DROPPED[name] ?? []);
		});

		it(`keeps the data-only table with resume off in the ${name} script`, async () => {
			const run = await played(name, false);
			expect(run.report.points.flatMap((point) => point.result.dropped.map((drop) => drop.reason))).toSatisfy((reasons: string[]) =>
				reasons.every((reason) => reason === "resume-off")
			);
			expect(tableOf(run, "resumed")).toEqual(EXPECTED[name]!.dataOnly);
			const compared = await played(name);
			expect(
				run.points.map((p) => [
					p.point.differences,
					p.point.skipped,
					p.resumed.ended
				])
			).toEqual(
				compared.points.map((p) => [
					p.point.dataOnly!.differences,
					p.point.dataOnly!.skipped,
					p.dataOnly!.ended
				])
			);
		});

		it(`restores each point of the ${name} script into another build as with resume off`, async () => {
			const run = await played(name);
			for (const { point } of run.points) {
				const restoreAs = async (options: object) => {
					const { runtime, result } = await restoreTestRuntime<IShop>(point.snapshot, {
						rootId: SHOP_ID,
						effectStubs: {
							...stubs(),
							generateGuid: guids("after")
						},
						options: {
							...options,
							allowDiags: true
						},
						repair: repairRestore
					});
					await settled();
					const state = copy(runtime.state);
					runtime.dispose();
					return {
						result,
						state
					};
				};
				const other = await restoreAs({
					build: "other",
					resume: true
				});
				const off = await restoreAs({
					build: "test"
				});
				expect(other.result.resumed).toEqual([]);
				expect(other.result.dropped.map((drop) => drop.reason)).toEqual(point.inFlight.map(() => "other-build"));
				expect(other.state).toEqual(off.state);
			}
		});
	}

	it("catches the checkout in every state and at every wait, and never charges an order twice", async () => {
		const states = new Set<string>();
		const waits = new Set<string>();
		for (const name of Object.keys(SCRIPTS)) {
			const run = await played(name);
			expect(mostChargesOnOneOrder(run.uninterruptedLedger.Charges)).toBeLessThanOrEqual(1);
			for (const p of run.points) {
				expect(mostChargesOnOneOrder(p.resumed.ledger.Charges)).toBeLessThanOrEqual(1);
				expect(mostChargesOnOneOrder(p.dataOnly!.ledger.Charges)).toBeLessThanOrEqual(1);
				for (const entry of p.point.inFlight) {
					if (entry.Name !== CHECKOUT_NAME) continue;
					states.add(entry.State!);
					if (entry.State === "open" || entry.State === "holding") waits.add(p.wait!);
				}
			}
		}
		expect(
			[
				...states
			].sort()
		).toEqual([
			"holding",
			"open",
			"queued",
			"regaining"
		]);
		expect(
			[
				...waits
			].sort()
		).toEqual(
			[
				ADDRESS,
				QUOTE,
				DELIVERY,
				RESERVE,
				CONFIRM,
				PAY
			].sort()
		);
	});

	it("reports the size of each save and the time each restore takes, with resume and without", async () => {
		const sizes: [
			number,
			number
		][] = [];
		const added: number[] = [];
		const resumedMs: number[] = [];
		const dataOnlyMs: number[] = [];
		for (const name of Object.keys(SCRIPTS)) {
			const run = await played(name);
			for (const p of run.points) {
				const saved = JSON.parse(p.point.snapshot) as {
					Histories?: unknown;
				};
				sizes.push([
					p.point.snapshot.length,
					JSON.stringify({
						...saved,
						Histories: undefined
					}).length
				]);
				const resumed = p.point.result.resumed.length;
				if (resumed > 0) {
					resumedMs.push(p.resumed.ms);
					dataOnlyMs.push(p.dataOnly!.ms);
					added.push((p.resumed.ms - p.dataOnly!.ms) / resumed);
				}
			}
		}
		const median = (values: number[]): number =>
			[
				...values
			].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
		const worst = (values: number[]): number => Math.max(...values);
		const figure = (values: number[]): string => `median ${median(values).toFixed(2)}ms, worst ${worst(values).toFixed(2)}ms`;
		(
			globalThis as {
				process?: {
					stderr?: {
						write(text: string): void;
					};
				};
			}
		).process?.stderr?.write(
			`[checkout cost] ${sizes.length} saves: with histories ${Math.min(...sizes.map(([w]) => w))} to ${worst(sizes.map(([w]) => w))} bytes, ` +
				`without ${Math.min(...sizes.map(([, o]) => o))} to ${worst(sizes.map(([, o]) => o))} bytes, histories add up to ${worst(sizes.map(([w, o]) => w - o))} bytes\n` +
				`[checkout cost] setup to repair over ${added.length} points with a resumed action: resumed ${figure(resumedMs)}; data-only ${figure(dataOnlyMs)}; ` +
				`added per resumed action ${figure(added)}\n`
		);
		expect(added.length).toBeGreaterThan(0);
	}, 120_000);
});
