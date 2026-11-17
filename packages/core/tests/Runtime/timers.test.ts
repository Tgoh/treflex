import type { IRuntime, IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { ISnapshot } from "../../src/Snapshot/ISnapshot";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionTrace } from "../../src/Types/IActionTrace";
import type { IRecord } from "../../src/Types/IRecord";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTimer } from "../../src/Effects/startTimer";
import { stopTimer } from "../../src/Effects/stopTimer";
import { createJournal } from "../../src/Runtime/createJournal";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTimerTable } from "../../src/Runtime/createTimerTable";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { createTestRuntime } from "../../src/Testing/createTestRuntime";
import { minted, rawReceiver, rootSetState } from "../testHelpers";

type IChild = {
	$Id: string;
	Ticks: number;
};
type IRootState = {
	$Id: string;
	Ticks: number;
	LastPayload: string;
	LastPublisher: string;
	Children: IChild[];
};

const initialState = (): IRootState => ({
	$Id: "Root",
	Ticks: 0,
	LastPayload: "",
	LastPublisher: "",
	Children: []
});

const startTimerAny = startTimer as unknown as (
	entity: {
		$Id: string;
	},
	key: string,
	receiver: {
		Id: string;
	},
	intervalMs: number,
	payload?: Record<string, unknown>
) => Generator<any, void, any>;
const stopTimerAny = stopTimer as unknown as (
	entity: {
		$Id: string;
	},
	key: string
) => Generator<any, void, any>;

function dispatch<A extends any[], R>(
	runtime: IRuntime<IRootState>,
	action: (draft: IRootState, ...args: A) => Generator<any, R, any>,
	...args: A
): Promise<R | undefined> {
	return runtime.processAction(
		action as any,
		() => runtime.state,
		rootSetState(runtime),
		() => "Root",
		...args
	);
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("timer table", () => {
	function buildTable() {
		const journal = createJournal();
		const stream: IRecord[] = [];
		journal.tap((r) => {
			stream.push(r);
		});
		const disposers: ((id: string) => void)[] = [];
		const table = createTimerTable({
			onDispose: (cb) => disposers.push(cb),
			journal
		});
		const timerRecords = () =>
			stream.filter(
				(r) =>
					r.Kind === "table" &&
					(
						r as {
							Table: string;
						}
					).Table === "timers"
			);
		return {
			table,
			journal,
			disposers,
			timerRecords
		};
	}

	const row = (over: Partial<Parameters<ReturnType<typeof createTimerTable>["start"]>[0]> = {}) => ({
		Key: "Tick",
		OwnerId: "Root",
		ReceiverId: "R",
		IntervalMs: 100,
		Payload: null,
		...over
	});

	it("journals start and stop at its own boundary, change-gated", () => {
		const { table, timerRecords } = buildTable();

		table.start(row());
		table.start(row());
		expect(timerRecords()).toHaveLength(1);

		table.start(
			row({
				IntervalMs: 250
			})
		);
		table.stop("Tick", "Root");
		const records = timerRecords() as any[];
		expect(records).toHaveLength(3);
		expect(records[1].Prev.IntervalMs).toBe(100);
		expect(records[1].Value.IntervalMs).toBe(250);
		expect(records[2].Value).toBeNull();
		expect(table.entries()).toHaveLength(0);
	});

	it("retracts every row an owner registered when the dispose callback fires", () => {
		const { table, disposers } = buildTable();
		table.start(row());
		table.start(
			row({
				Key: "Other"
			})
		);
		table.start(
			row({
				OwnerId: "Elsewhere"
			})
		);

		for (const cb of disposers) cb("Root");
		expect(table.entries()).toEqual([
			expect.objectContaining({
				OwnerId: "Elsewhere"
			})
		]);
	});

	it("load replaces wholesale, journal-silent, and its watchers hear every row", () => {
		const { table, timerRecords } = buildTable();
		const seen: unknown[] = [];
		table.watch((key, ownerId, value) =>
			seen.push([
				key,
				ownerId,
				value
			])
		);

		table.start(row());
		expect(seen).toHaveLength(1);

		table.load([
			row({
				Key: "Restored",
				IntervalMs: 42
			})
		]);
		expect(timerRecords()).toHaveLength(1);
		expect(seen).toEqual([
			[
				"Tick",
				"Root",
				expect.anything()
			],
			[
				"Tick",
				"Root",
				null
			],
			[
				"Restored",
				"Root",
				expect.objectContaining({
					IntervalMs: 42
				})
			]
		]);
		expect(table.entries()).toEqual([
			expect.objectContaining({
				Key: "Restored",
				IntervalMs: 42
			})
		]);
	});
});

describe("timers on the live runtime", () => {
	function tickReceiver() {
		return function* tickReceiver(draft: IRootState, data: any, ctx: any): IActionGenerator {
			draft.Ticks += 1;
			draft.LastPayload = data.Tag ?? "";
			draft.LastPublisher = ctx.publisher.Id;
		};
	}

	it("a tick dispatches the owner's receiver with the registered payload, send-to-self", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState());
				runtime.registerReceiver(rawReceiver("TickReceiver", [], tickReceiver()));

				function* arm(draft: IRootState): IActionGenerator {
					yield* startTimerAny(
						draft,
						"Tick",
						{
							Id: "TickReceiver"
						},
						100,
						{
							Tag: "captured"
						}
					);
				}
				await dispatch(runtime, arm);

				await vi.advanceTimersByTimeAsync(99);
				expect(runtime.state.Ticks).toBe(0);
				await vi.advanceTimersByTimeAsync(1);
				expect(runtime.state.Ticks).toBe(1);
				expect(runtime.state.LastPayload).toBe("captured");
				expect(runtime.state.LastPublisher).toBe("Root");

				await vi.advanceTimersByTimeAsync(100);
				expect(runtime.state.Ticks).toBe(2);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("fixed delay: the next tick arms only after the previous dispatch settles", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState());
				let releaseGate!: (v?: unknown) => void;
				runtime.registerImplementation("gate", () => {
					return new Promise((r) => {
						releaseGate = r;
					});
				});
				const slowReceiver = function* slowReceiver(draft: IRootState): IActionGenerator {
					draft.Ticks += 1;
					yield {
						Type: "gate"
					};
				};
				runtime.registerReceiver(rawReceiver("SlowReceiver", [], slowReceiver));

				function* arm(draft: IRootState): IActionGenerator {
					yield* startTimerAny(
						draft,
						"Tick",
						{
							Id: "SlowReceiver"
						},
						100
					);
				}
				await dispatch(runtime, arm);

				await vi.advanceTimersByTimeAsync(100);
				expect(runtime.state.Ticks).toBe(1);

				await vi.advanceTimersByTimeAsync(500);
				expect(runtime.state.Ticks).toBe(1);

				releaseGate();
				await vi.advanceTimersByTimeAsync(0);
				await vi.advanceTimersByTimeAsync(100);
				expect(runtime.state.Ticks).toBe(2);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("stopTimer retracts the row and no further ticks fire", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState());
				runtime.registerReceiver(rawReceiver("TickReceiver", [], tickReceiver()));

				function* arm(draft: IRootState): IActionGenerator {
					yield* startTimerAny(
						draft,
						"Tick",
						{
							Id: "TickReceiver"
						},
						100
					);
				}
				function* disarm(draft: IRootState): IActionGenerator {
					yield* stopTimerAny(draft, "Tick");
				}
				await dispatch(runtime, arm);
				await vi.advanceTimersByTimeAsync(100);
				expect(runtime.state.Ticks).toBe(1);

				await dispatch(runtime, disarm);
				await vi.advanceTimersByTimeAsync(1000);
				expect(runtime.state.Ticks).toBe(1);
				expect(vi.getTimerCount()).toBe(0);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("drops a tick queued behind a hold when stopTimer runs before it starts, recorded and traced as dropped", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState());
				runtime.registerReceiver(rawReceiver("TickReceiver", [], tickReceiver()));
				const records: IRecord[] = [];
				runtime.on("record", (record) => records.push(record));
				const traces: IActionTrace[] = [];
				createTraceAggregator(runtime, (trace) => traces.push(trace));
				let release!: () => void;
				runtime.registerImplementation(
					"slow",
					() =>
						new Promise<void>((resolve) => {
							release = resolve;
						})
				);
				function* arm(draft: IRootState): IActionGenerator {
					yield* startTimerAny(
						draft,
						"Tick",
						{
							Id: "TickReceiver"
						},
						100
					);
				}
				function* holdsThenStops(draft: IRootState): IActionGenerator {
					yield {
						Type: "slow"
					};
					yield* stopTimerAny(draft, "Tick");
				}
				await dispatch(runtime, arm);
				const holding = dispatch(runtime, holdsThenStops);
				await vi.advanceTimersByTimeAsync(100);
				expect(runtime.state.Ticks).toBe(0);
				release();
				await holding;
				await vi.advanceTimersByTimeAsync(1000);
				expect(runtime.state.Ticks).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
				expect(records.filter((r) => r.Kind === "action:end" && r.Status === "dropped")).toHaveLength(1);
				expect(traces.filter((trace) => trace.dropped === true).map((trace) => trace.entityId)).toEqual([
					"Root"
				]);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("re-registering the same key replaces the schedule — the interval-change idiom", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState());
				runtime.registerReceiver(rawReceiver("TickReceiver", [], tickReceiver()));

				function* arm(draft: IRootState, ms: number): IActionGenerator {
					yield* startTimerAny(
						draft,
						"Tick",
						{
							Id: "TickReceiver"
						},
						ms
					);
				}
				await dispatch(runtime, arm, 10_000);
				await dispatch(runtime, arm, 50);

				await vi.advanceTimersByTimeAsync(60);
				expect(runtime.state.Ticks).toBe(1);
				expect(vi.getTimerCount()).toBe(1);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("the dispose cascade retracts a leaving entity's timer mid-interval", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState());
				const childReceiver = function* childReceiver(draft: IChild): IActionGenerator {
					draft.Ticks += 1;
				};
				runtime.registerReceiver(rawReceiver("ChildReceiver", [], childReceiver));

				function* addChild(draft: IRootState): IActionGenerator {
					draft.Children.push(
						minted("child-1", {
							Ticks: 0
						})
					);
					yield* startTimerAny(
						draft.Children[0],
						"Tick",
						{
							Id: "ChildReceiver"
						},
						100
					);
				}
				function* releaseChild(draft: IRootState): IActionGenerator {
					draft.Children = draft.Children.filter((c) => c.$Id !== "~child-1");
				}
				await dispatch(runtime, addChild);
				await vi.advanceTimersByTimeAsync(100);
				expect(runtime.state.Children[0].Ticks).toBe(1);

				await dispatch(runtime, releaseChild);
				expect(vi.getTimerCount()).toBe(0);
				await vi.advanceTimersByTimeAsync(1000);
				expect(runtime.state.Children).toHaveLength(0);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("runtime.dispose clears every armed handle", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState());
				runtime.registerReceiver(rawReceiver("TickReceiver", [], tickReceiver()));
				function* arm(draft: IRootState): IActionGenerator {
					yield* startTimerAny(
						draft,
						"Tick",
						{
							Id: "TickReceiver"
						},
						100
					);
				}
				await dispatch(runtime, arm);
				expect(vi.getTimerCount()).toBe(1);
				runtime.dispose();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				dispose();
			}
		});
	});
});

describe("timers across snapshot/restore", () => {
	const T0 = 1_800_000_000_000;

	beforeEach(() => {
		vi.setSystemTime(T0);
	});

	const TickReceiver = rawReceiver("TickReceiver", [], function* (draft: IRootState, data: any): IActionGenerator {
		draft.Ticks += 1;
		draft.LastPayload = data.Tag ?? "";
	});

	const tableRow = {
		Key: "Tick",
		OwnerId: "Root",
		ReceiverId: "TickReceiver",
		IntervalMs: 100,
		Payload: {
			Tag: "survives"
		}
	};

	function* arm(draft: IRootState): IActionGenerator {
		yield* startTimerAny(
			draft,
			"Tick",
			{
				Id: "TickReceiver"
			},
			100,
			{
				Tag: "survives"
			}
		);
	}

	async function armed(options: IRuntimeOptions = {}): Promise<IRuntime<IRootState>> {
		const runtime = createRuntime<IRootState>(initialState(), options);
		runtime.registerReceiver(TickReceiver);
		await dispatch(runtime, arm);
		return runtime;
	}

	async function restore(envelope: string, options: IRuntimeOptions = {}): Promise<IRuntime<IRootState>> {
		const { runtime } = await restoreRuntime<IRootState>(envelope, {
			rootId: "Root",
			options,
			setup: (runtime) => {
				runtime.registerReceiver(TickReceiver);
			}
		});
		return runtime;
	}

	const savedRows = (envelope: string) => (JSON.parse(envelope) as ISnapshot).Timers;

	function withNextDue(envelope: string, nextDue: unknown): string {
		const parsed = JSON.parse(envelope) as ISnapshot;
		(
			parsed.Timers[0] as {
				NextDue?: unknown;
			}
		).NextDue = nextDue;
		return JSON.stringify(parsed);
	}

	async function savedMidInterval(elapsedMs: number): Promise<string> {
		const a = await armed();
		await vi.advanceTimersByTimeAsync(elapsedMs);
		const envelope = createSnapshot(a);
		a.dispose();
		return envelope;
	}

	it("rows ride the envelope with their next due time, and a restore arms each for then", async () => {
		const envelope = await savedMidInterval(30);
		expect(savedRows(envelope)).toStrictEqual([
			{
				...tableRow,
				NextDue: T0 + 100
			}
		]);

		const b = await restore(envelope);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(69);
		expect(b.state.Ticks).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(b.state.Ticks).toBe(1);
		expect(b.state.LastPayload).toBe("survives");
		await vi.advanceTimersByTimeAsync(99);
		expect(b.state.Ticks).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(b.state.Ticks).toBe(2);

		await vi.advanceTimersByTimeAsync(40);
		expect(savedRows(createSnapshot(b))).toStrictEqual([
			{
				...tableRow,
				NextDue: T0 + 300
			}
		]);
		b.dispose();
	});

	it("fires a row past due once, soon, then keeps its interval", async () => {
		const envelope = await savedMidInterval(30);
		vi.setSystemTime(T0 + 30 + 3_600_000);

		const b = await restore(envelope);
		await vi.advanceTimersByTimeAsync(1);
		expect(b.state.Ticks).toBe(1);
		await vi.advanceTimersByTimeAsync(99);
		expect(b.state.Ticks).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(b.state.Ticks).toBe(2);
		expect(vi.getTimerCount()).toBe(1);
		b.dispose();
	});

	it("clamps a due time more than one interval ahead to one interval", async () => {
		const envelope = withNextDue(await savedMidInterval(30), T0 + 1_000_000_000);

		const b = await restore(envelope);
		await vi.advanceTimersByTimeAsync(99);
		expect(b.state.Ticks).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(b.state.Ticks).toBe(1);
		b.dispose();
	});

	it("saves a tick whose action is still running as due now", async () => {
		const a = createRuntime<IRootState>(initialState(), {});
		let release!: () => void;
		a.registerImplementation(
			"gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		a.registerReceiver(
			rawReceiver("TickReceiver", [], function* (draft: IRootState): IActionGenerator {
				draft.Ticks += 1;
				yield {
					Type: "gate"
				};
			})
		);
		await dispatch(a, arm);
		await vi.advanceTimersByTimeAsync(100);
		expect(a.state.Ticks).toBe(1);
		await vi.advanceTimersByTimeAsync(500);

		const envelope = createSnapshot(a);
		expect(savedRows(envelope)).toStrictEqual([
			{
				...tableRow,
				NextDue: T0 + 600
			}
		]);
		release();
		a.dispose();

		const b = await restore(envelope);
		expect(b.state.Ticks).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(b.state.Ticks).toBe(2);
		b.dispose();
	});

	it("arms a row saved without a due time, as an older build writes it, a full interval from the load", async () => {
		const parsed = JSON.parse(await savedMidInterval(30)) as ISnapshot;
		delete parsed.Timers[0]!.NextDue;

		const b = await restore(JSON.stringify(parsed));
		await vi.advanceTimersByTimeAsync(99);
		expect(b.state.Ticks).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(b.state.Ticks).toBe(1);
		b.dispose();
	});

	it("treats a due time that is not a finite number as absent, and keeps it out of the table", async () => {
		const envelope = await savedMidInterval(30);
		const negativeInfinity = withNextDue(envelope, 12345).replace('"NextDue":12345', '"NextDue":-1e999');
		for (const json of [
			withNextDue(envelope, "soon"),
			withNextDue(envelope, null),
			withNextDue(envelope, true),
			withNextDue(envelope, {}),
			negativeInfinity
		]) {
			const b = await restore(json);
			expect(b.timers()).toStrictEqual([
				tableRow
			]);
			await vi.advanceTimersByTimeAsync(1);
			expect(b.state.Ticks).toBe(0);
			await vi.advanceTimersByTimeAsync(98);
			expect(b.state.Ticks).toBe(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(b.state.Ticks).toBe(1);
			b.dispose();
		}
	});

	it("writes no due time from a paused runtime, nor from one restored paused", async () => {
		const paused = await armed({
			pauseTimers: true
		});
		expect(savedRows(createSnapshot(paused))).toStrictEqual([
			tableRow
		]);
		paused.dispose();

		const test = createTestRuntime<IRootState>(initialState());
		await test.dispatch(arm as any, "Root");
		expect(savedRows(createSnapshot(test))).toStrictEqual([
			tableRow
		]);

		const b = await restore(await savedMidInterval(30), {
			pauseTimers: true
		});
		expect(savedRows(createSnapshot(b))).toStrictEqual([
			tableRow
		]);
		b.dispose();
	});

	it("keeps due times out of the table's rows, runtime.timers() and the table records", async () => {
		const a = createRuntime<IRootState>(initialState(), {});
		a.registerReceiver(TickReceiver);
		const records: IRecord[] = [];
		a.on("record", (record) => records.push(record));
		await dispatch(a, arm);
		await vi.advanceTimersByTimeAsync(130);
		const envelope = createSnapshot(a);
		expect(savedRows(envelope)[0]).toHaveProperty("NextDue");
		const timerRecords = records.filter((r) => r.Kind === "table" && (r as any).Table === "timers") as any[];
		expect(timerRecords.map((r) => r.Value)).toStrictEqual([
			tableRow
		]);
		expect(a.timers()).toStrictEqual([
			tableRow
		]);
		a.dispose();

		const b = await restore(envelope);
		const restoredRecords: IRecord[] = [];
		b.on("record", (record) => restoredRecords.push(record));
		expect(b.timers()).toStrictEqual([
			tableRow
		]);
		expect((b as IRuntimeInternal<IRootState>).get("runtime/timers").entries()).toStrictEqual([
			tableRow
		]);
		await dispatch(b, arm);
		expect(restoredRecords.filter((r) => r.Kind === "table")).toStrictEqual([]);
		b.dispose();
	});

	it("an equal startTimer keeps the running interval and its due time", async () => {
		const a = await armed();
		await vi.advanceTimersByTimeAsync(60);
		const before = savedRows(createSnapshot(a));
		await dispatch(a, arm);
		expect(savedRows(createSnapshot(a))).toStrictEqual(before);
		await vi.advanceTimersByTimeAsync(39);
		expect(a.state.Ticks).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(a.state.Ticks).toBe(1);
		a.dispose();

		const b = await restore(await savedMidInterval(30));
		await vi.advanceTimersByTimeAsync(20);
		await dispatch(b, arm);
		await vi.advanceTimersByTimeAsync(49);
		expect(b.state.Ticks).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(b.state.Ticks).toBe(1);
		b.dispose();
	});
});

describe("timers under the createTestRuntime preset", () => {
	it("records timer intent without ever firing a tick", async () => {
		const runtime = createTestRuntime<{
			$Id: string;
		}>({
			$Id: "test"
		});
		const effectRecords: any[] = [];
		runtime.on("record", (record) => {
			if (record.Kind === "effect") effectRecords.push(record);
		});

		function* arm(draft: { $Id: string }): IActionGenerator {
			yield* startTimerAny(
				draft,
				"Tick",
				{
					Id: "TickReceiver"
				},
				5
			);
		}
		await runtime.dispatch(arm as any, "test");

		expect(effectRecords).toEqual([
			expect.objectContaining({
				Type: "startTimer"
			})
		]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
