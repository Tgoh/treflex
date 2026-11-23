import type { IActionGenerator, IOpenGenerator, IRuntime } from "../../src/index";
import type { IWithResume } from "../../src/Resume/createKeeper";
import type { IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IOrder, IShop } from "./resumeHarness";
import { writeSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ask } from "../../src/Effects/ask";
import { defineEffect } from "../../src/Effects/defineEffect";
import { generateGuid } from "../../src/Effects/generateGuid";
import { DEFAULT_HISTORY_BUDGET } from "../../src/Resume/createKeeper";
import { resumable } from "../../src/Resume/resumable";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import * as reactive from "../reactive";
import { restoreWithResume, runEngine } from "./replayHarness";
import { answerOn, harness, shop, until, wait } from "./resumeHarness";

function* waits(_draft: IOrder): IOpenGenerator {
	yield* open(wait("forever"));
}
named(waits, "ResumeCost/Waits");
resumable(waits);

const idle = defineEffect<
	{
		Type: "ResumeCost/Idle";
	},
	void
>("ResumeCost/Idle", {
	idempotent: true
});

function* rootWaits(_draft: IShop): IOpenGenerator {
	yield* open(idle());
}
named(rootWaits, "ResumeCost/RootWaits");
resumable(rootWaits);

function* setQty(draft: IOrder, qty: number): IActionGenerator {
	draft.Qty = qty;
}

function* setTwo(draft: IOrder, at: number): IActionGenerator {
	if (at % 2 === 0) {
		draft.Note = `n${at}`;
	} else {
		draft.Qty = at;
	}
}

const TREFLEX_COST_LARGE = process.env.TREFLEX_COST_LARGE !== undefined;

function report(line: string): void {
	writeSync(2, `[resume cost] ${line}\n`);
}

interface IArm {
	options: Omit<IRuntimeOptions, "resume"> & IWithResume;
	stepTap?: boolean;
	marked?: boolean;
	alternate?: boolean;
	target: "o1" | "o2";
}

const ITERATIONS = 2000;

async function timeArm(arm: IArm): Promise<number> {
	return reactive.root(async (dispose) => {
		const runtime = createRuntime<IShop>(shop(), {
			verifyIndex: false,
			build: "test",
			...arm.options
		} as IRuntimeOptions);
		runtime.registerImplementation("Resume/Wait", () => new Promise(() => {}));
		if (arm.stepTap) {
			runtime.on("record", () => {}, {
				kinds: [
					"step"
				]
			});
		}
		if (arm.marked) {
			void runtime.dispatch(waits, "o1");
			await Promise.resolve();
		}
		const write = arm.alternate ? setTwo : setQty;
		const warm = ITERATIONS / 5;
		for (let at = 0; at < warm; at++) {
			await runtime.dispatch(write, arm.target, at);
		}
		const start = performance.now();
		for (let at = 0; at < ITERATIONS; at++) {
			await runtime.dispatch(write, arm.target, warm + at);
		}
		const elapsed = performance.now() - start;
		dispose();
		runtime.dispose();
		return elapsed;
	});
}

async function compare(base: IArm, against: IArm): Promise<number> {
	let baseBest = Number.POSITIVE_INFINITY;
	let againstBest = Number.POSITIVE_INFINITY;
	for (let round = 0; round < 5; round++) {
		baseBest = Math.min(baseBest, await timeArm(base));
		againstBest = Math.min(againstBest, await timeArm(against));
	}
	return againstBest / baseBest;
}

const resumeOn: IWithResume = {
	resume: true
};

describe("resume cost", () => {
	it("reports a write step with the option set to off against the option absent", async () => {
		await compare(
			{
				options: {},
				target: "o1"
			},
			{
				options: resumeOn,
				marked: true,
				target: "o1"
			}
		);
		const ratio = await compare(
			{
				options: {},
				target: "o1"
			},
			{
				options: {
					resume: false
				},
				target: "o1"
			}
		);
		report(`option set to off vs option absent: ${ratio.toFixed(3)}`);
		expect(ratio).toBeLessThan(2);
	});

	it("reports a write step with resume on and nothing marked in flight, against no tap and against a step tap", async () => {
		const noTap = await compare(
			{
				options: {},
				target: "o1"
			},
			{
				options: resumeOn,
				target: "o1"
			}
		);
		report(`on, nothing marked, vs no tap: ${noTap.toFixed(3)} (budget 1.5)`);
		const beside = await compare(
			{
				options: {},
				stepTap: true,
				target: "o1"
			},
			{
				options: resumeOn,
				stepTap: true,
				target: "o1"
			}
		);
		report(`on, nothing marked, beside a step tap vs that tap alone: ${beside.toFixed(3)} (budget 1.15)`);
		expect(noTap).toBeLessThan(5);
		expect(beside).toBeLessThan(5);
	});

	it("reports a write step with a marked action in flight, into its entity and elsewhere, against no tap", async () => {
		const into = await compare(
			{
				options: {},
				marked: true,
				alternate: true,
				target: "o1"
			},
			{
				options: resumeOn,
				marked: true,
				alternate: true,
				target: "o1"
			}
		);
		report(
			`on, marked in flight, a write into its entity alternating two fields, each merged into its field's entry, vs no tap: ${into.toFixed(3)} (budget 2)`
		);
		const elsewhere = await compare(
			{
				options: {},
				marked: true,
				target: "o2"
			},
			{
				options: resumeOn,
				marked: true,
				target: "o2"
			}
		);
		report(`on, marked in flight, a write elsewhere vs no tap: ${elsewhere.toFixed(3)} (budget 1.5)`);
		expect(into).toBeLessThan(8);
		expect(elsewhere).toBeLessThan(5);
	});

	it("reports how large a flow's history is after N sets during its wait, of one field and of two in turn", async () => {
		function* flow(draft: IOrder): IOpenGenerator {
			const address = yield* open(
				ask<string>(draft, {
					Path: "Address"
				})
			);
			const quote = yield* open(wait("quote"));
			draft.Note = `${address}:${quote}`;
			draft.Key = yield* generateGuid();
			yield* wait("reserve");
			yield* open(
				ask<boolean>(draft, {
					Path: "Confirm",
					Address: address
				})
			);
		}
		named(flow, "ResumeCost/Flow");
		resumable(flow);
		const sizes: string[] = [];
		const byN = new Map<string, number>();
		for (const writer of [
			"one field",
			"two fields"
		] as const) {
			for (const n of [
				0,
				10,
				100,
				1000
			]) {
				const h = harness(shop(), {
					resume: {
						budget: 1e9
					}
				});
				const runtime = h.runtime as IRuntime<IShop>;
				void runtime.dispatch(flow, "o1");
				await until(() => runtime.state !== undefined);
				await answerOn(runtime, runtime.state.Orders.o1!, "1 High Street, Springfield");
				await until(() => h.waiting.length === 1);
				h.release("quote", {
					Option: "next-day",
					Price: 12.5
				});
				await until(() => h.waiting.some((w) => w.name === "reserve"));
				h.release("reserve");
				await until(() => h.waiting.length === 0);
				await Promise.resolve();
				for (let at = 0; at < n; at++) {
					await runtime.dispatch(writer === "one field" ? setQty : setTwo, "o1", at);
				}
				const bytes = JSON.stringify(h.historyOf("ResumeCost/Flow")).length;
				byN.set(`${writer} ${n}`, bytes);
				sizes.push(`${writer} N=${n}: ${bytes} bytes${bytes > DEFAULT_HISTORY_BUDGET ? " (over the default budget)" : ""}`);
				runtime.dispose();
			}
		}
		report(`flow history size: ${sizes.join("; ")}`);
		expect(byN.get("one field 1000")! - byN.get("one field 10")!).toBeLessThan(200);
		expect(byN.get("two fields 1000")! - byN.get("two fields 10")!).toBeLessThan(200);
	});

	it("reports the engine's run with one replay, whose plan walks the tree once, by the tree's size", async () => {
		const timings: string[] = [];
		const best = new Map<number, number>();
		const sizes = [
			1,
			3_333,
			...(TREFLEX_COST_LARGE
				? [
						33_333
					]
				: [])
		];
		for (const orders of sizes) {
			const tree = shop();
			for (let at = 0; at < orders; at++) {
				tree.Orders[`x${at}`] = {
					$Id: `x${at}`,
					Qty: 1,
					Key: "",
					Note: "",
					Lines: {
						[`x${at}-l1`]: {
							$Id: `x${at}-l1`,
							Qty: 1
						}
					}
				};
			}
			const h = harness(tree);
			void h.runtime.dispatch(waits, "o1");
			await until(() => h.waiting.length === 1);
			const json = createSnapshot(h.runtime);
			h.runtime.dispose();
			let fastest = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 5; round++) {
				const run = await restoreWithResume<IShop>(json, "shop");
				const start = performance.now();
				const engine = runEngine(run);
				fastest = Math.min(fastest, performance.now() - start);
				expect(engine.resumed).toHaveLength(1);
				run.runtime.dispose();
			}
			const nodes = 3 * orders + 3 * 2 + 2;
			best.set(orders, fastest);
			timings.push(`${nodes} objects: ${fastest.toFixed(2)}ms`);
		}
		report(`engine with one replay, best of five: ${timings.join("; ")}`);
		expect(best.get(sizes[sizes.length - 1]!)!).toBeGreaterThan(best.get(1)!);
	}, 120_000);

	it("reports the copy a restore with resume takes of an in-flight row's entity before setup, on the root of a large tree", async () => {
		const never = () => new Promise(() => {});
		const lines: string[] = [];
		for (const orders of [
			1_000,
			10_000
		]) {
			const tree = shop();
			for (let at = 0; at < orders; at++) {
				tree.Orders[`x${at}`] = {
					$Id: `x${at}`,
					Qty: 1,
					Key: "",
					Note: "",
					Lines: {
						[`x${at}-l1`]: {
							$Id: `x${at}-l1`,
							Qty: 1
						}
					}
				};
			}
			const before = createRuntime<IShop>(tree, {
				verifyIndex: false,
				build: "test",
				resume: true
			} as IRuntimeOptions);
			before.registerImplementation("ResumeCost/Idle", never);
			void before.dispatch(rootWaits, "shop");
			await Promise.resolve();
			const json = createSnapshot(before);
			before.dispose();

			const probe = createRuntime<IShop>(JSON.parse(json).AppState, {
				verifyIndex: false
			});
			const cell = (probe as unknown as IRuntimeInternal<IShop>).get("runtime/writeGateway").cellOf("shop");
			let copyBest = Number.POSITIVE_INFINITY;
			let bytes = 0;
			for (let round = 0; round < 5; round++) {
				const start = performance.now();
				bytes = JSON.stringify(cell).length;
				copyBest = Math.min(copyBest, performance.now() - start);
			}
			probe.dispose();

			const restoreOnce = async (
				options: Omit<IRuntimeOptions, "resume"> & IWithResume
			): Promise<
				[
					number,
					number
				]
			> => {
				const start = performance.now();
				const { runtime, result } = await restoreRuntime<IShop>(json, {
					rootId: "shop",
					options: {
						verifyIndex: false,
						...options
					} as IRuntimeOptions,
					setup: (fresh) => fresh.registerImplementation("ResumeCost/Idle", never)
				});
				const elapsed = performance.now() - start;
				runtime.dispose();
				return [
					elapsed,
					result.resumed.length
				];
			};
			const arms = {
				resumed: {
					build: "test",
					resume: true
				},
				"another build": {
					build: "other",
					resume: true
				},
				"resume off": {
					build: "test"
				}
			} as const;
			const best = new Map<
				string,
				[
					number,
					number
				]
			>();
			for (let round = 0; round < 5; round++) {
				for (const [arm, options] of Object.entries(arms)) {
					const [ms, count] = await restoreOnce(options);
					best.set(arm, [
						Math.min(ms, best.get(arm)?.[0] ?? Number.POSITIVE_INFINITY),
						count
					]);
				}
			}
			lines.push(
				`${orders} rows: the copy ${copyBest.toFixed(2)}ms of ${bytes} bytes; a whole restore ` +
					[
						...best
					]
						.map(([arm, [ms, count]]) => `${arm} ${ms.toFixed(2)}ms (${count} resumed)`)
						.join(", ")
			);
			expect(best.get("resumed")![1]).toBe(1);
			expect(bytes).toBeGreaterThan(orders * 40);
		}
		report(`root row's entity copied before setup, best of five: ${lines.join("; ")}`);
	}, 120_000);
});
