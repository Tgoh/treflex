import type { IRuntime } from "../../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../../src/Runtime/internals";
import type { IDifferentialReport, IEventDifference, IFailureSummary, IRestorePoint } from "../../../src/Snapshot/index";
import type { IBoard } from "./boardApp";
import type { IGenerated } from "./generate";
import { beforeAll, describe, expect, it } from "vitest";
import { differentialRestore } from "../../../src/Snapshot/index";
import { ALL_ACTIONS, allItems, counterStubs, faithfulRepair, seed } from "./boardApp";
import { generate } from "./generate";

const host = (
	globalThis as {
		process?: {
			env?: Record<string, string | undefined>;
			getActiveResourcesInfo?: () => string[];
		};
	}
).process;

const SEEDS = Number(host?.env?.TREFLEX_RESTORE_SEEDS ?? 20);

const lengthOf = (s: number): number => 10 + (s % 21);

const timeouts = (): number => (host?.getActiveResourcesInfo?.() ?? []).filter((r) => r === "Timeout").length;

interface ICall {
	report?: IDifferentialReport;
	threw?: unknown;
	runtimes: IRuntime<IBoard>[];
	timersBefore: number;
	timersAfter: number;
}

async function call(g: IGenerated, repair: boolean): Promise<ICall> {
	const runtimes: IRuntime<IBoard>[] = [];
	const timersBefore = timeouts();
	try {
		const report = await differentialRestore(
			{
				seed,
				hold: g.hold,
				effectStubs: counterStubs,
				options: {
					allowFailures: ALL_ACTIONS
				},
				setup: (runtime) => {
					runtimes.push(runtime);
				},
				...(repair
					? {
							repair: faithfulRepair
						}
					: {})
			},
			g.steps
		);
		return {
			report,
			runtimes,
			timersBefore,
			timersAfter: timeouts()
		};
	} catch (threw) {
		return {
			threw,
			runtimes,
			timersBefore,
			timersAfter: timeouts()
		};
	}
}

interface IFound {
	determinism: string[];
	faithful: string[];
	unrepaired: string[];
	ids: string[];
	hygiene: string[];
}

const nothingFound = (): IFound => ({
	determinism: [],
	faithful: [],
	unrepaired: [],
	ids: [],
	hygiene: []
});

// The report doesn't expose the tool's pairing, so the test pairs ids by what the model knows: an item's Key names
// the same item in every run.
const itemKeys = (runtime: IRuntime<IBoard>): Map<string, string> =>
	new Map(
		allItems(JSON.parse(JSON.stringify(runtime.state)) as IBoard).map((item) => [
			item.$Id,
			item.Key
		])
	);

function onlySameItemDifferences(p: IRestorePoint, before: Map<string, string>, after: Map<string, string>): boolean {
	const { state, diags, failures, onError, ...others } = p.differences;
	if (Object.keys(others).length > 0) {
		return false;
	}
	const sameItem = (e: unknown, a: unknown): boolean =>
		typeof e === "string" && typeof a === "string" && before.has(e) && before.get(e) === after.get(a);
	if (!(state ?? []).every((d) => sameItem(d.expected, d.actual))) {
		return false;
	}
	const rest = (event: unknown): string =>
		JSON.stringify({
			...(event as object),
			EntityId: null
		});
	const events: (IEventDifference<unknown> | undefined)[] = [
		diags,
		failures,
		onError
	];
	return events.every((kind) => {
		const unmatched = [
			...((kind?.extra ?? []) as IFailureSummary[])
		];
		for (const missing of (kind?.missing ?? []) as IFailureSummary[]) {
			const i = unmatched.findIndex((extra) => rest(extra) === rest(missing) && sameItem(missing.EntityId, extra.EntityId));
			if (i < 0) {
				return false;
			}
			unmatched.splice(i, 1);
		}
		return unmatched.length === 0;
	});
}

const disposed = (runtime: IRuntime<IBoard>): boolean => (runtime as IRuntimeInternal<IBoard>).disposed();

const droppedIsSnapshots = (p: IRestorePoint): boolean =>
	JSON.stringify(
		p.inFlight.map((e) => ({
			actionId: e.ActionId,
			name: e.Name,
			label: e.Label,
			entityId: e.EntityId,
			state: e.State,
			...(e.Place !== undefined
				? {
						place: e.Place
					}
				: {}),
			reason: "resume-off"
		}))
	) === JSON.stringify(p.result.dropped);

function hygiene(where: string, c: ICall, found: IFound): void {
	if (c.threw) {
		found.hygiene.push(`${where}: threw ${String(c.threw)}`);
		return;
	}
	const runs = 1 + 2 * c.report!.points.length;
	if (c.runtimes.length !== runs) {
		found.hygiene.push(`${where}: ${c.runtimes.length} runtimes, not ${runs}`);
	}
	if (c.runtimes.some((runtime) => !disposed(runtime))) {
		found.hygiene.push(`${where}: a runtime left undisposed`);
	}
	if (c.timersAfter > c.timersBefore) {
		found.hygiene.push(`${where}: timers ${c.timersBefore} -> ${c.timersAfter}`);
	}
}

async function twice(s: number, g: IGenerated, repair: boolean, found: IFound): Promise<IDifferentialReport | undefined> {
	const where = `seed ${s} repair ${repair}`;
	const a = await call(g, repair);
	const b = await call(g, repair);
	hygiene(where, a, found);
	hygiene(where, b, found);
	if (JSON.stringify(a.report) !== JSON.stringify(b.report)) {
		found.determinism.push(`${where}: a second call gave another report`);
	}
	const uninterrupted = a.report ? itemKeys(a.runtimes[0]!) : undefined;
	for (const [i, p] of (a.report?.points ?? []).entries()) {
		if (!droppedIsSnapshots(p)) {
			found.unrepaired.push(`${where} after ${p.after}: dropped isn't the snapshot's in-flight list`);
		}
		if (!p.same && onlySameItemDifferences(p, uninterrupted!, itemKeys(a.runtimes[2 + 2 * i]!))) {
			found.ids.push(`${where} after ${p.after}: ${JSON.stringify(p.differences)}`);
		}
	}
	return a.report;
}

function faithful(s: number, g: IGenerated, report: IDifferentialReport, found: string[]): void {
	for (const p of report.points) {
		const model = g.inFlightAfter[p.after - 1]!.map((t) => g.tokenAct[t]).sort();
		const dropped = p.result.dropped.map((d) => d.name).sort();
		if (JSON.stringify(model) !== JSON.stringify(dropped)) {
			found.push(`seed ${s} after ${p.after}: dropped ${dropped}, the model ${model}`);
		}
		if (!p.same || p.skipped.length > 0) {
			found.push(
				`seed ${s} after ${p.after}: ${JSON.stringify({
					skipped: p.skipped,
					differences: p.differences
				})}`
			);
		}
	}
	const modelPoints = g.inFlightAfter.slice(0, g.steps.length - 1).flatMap((ts, i) =>
		ts.length > 0
			? [
					i + 1
				]
			: []
	);
	const points = report.points.map((p) => p.after);
	if (JSON.stringify(modelPoints) !== JSON.stringify(points)) {
		found.push(`seed ${s}: points ${points}, the model ${modelPoints}`);
	}
}

function unrepaired(s: number, g: IGenerated, report: IDifferentialReport, found: string[]): void {
	for (const p of report.points) {
		const droppedTokens = new Set(g.inFlightAfter[p.after - 1]);
		const skipped = new Set(p.skipped.map((k) => k.step));
		for (let j = p.after; j < g.steps.length; j++) {
			const m = g.meta[j]!;
			if (m.kind !== "settle") {
				continue;
			}
			if (droppedTokens.has(m.token) && !skipped.has(j + 1)) {
				found.push(`seed ${s} after ${p.after}: step ${j + 1} settles dropped ${m.token} and isn't skipped`);
			}
			// A dropped leading touch lets a repeat run that the uninterrupted run dropped, and that repeat then holds the
			// item against later work on it, so a live settle is skipped only on an item no touch was sent to.
			const touched = Object.keys(g.tokenAct).some(
				(o) => g.tokenAct[o] === "Board/TouchItem" && g.tokenEntity[o] === g.tokenEntity[m.token]
			);
			if (!droppedTokens.has(m.token) && skipped.has(j + 1) && !touched) {
				found.push(`seed ${s} after ${p.after}: step ${j + 1} settles live ${m.token} and is skipped`);
			}
		}
		const lost = [
			...droppedTokens
		].filter((t) => {
			if (g.outcome[t] === "errored") {
				return true;
			}
			if (g.outcome[t] !== "completed") {
				return false;
			}
			const entity = g.tokenEntity[t]!;
			// A later rename of the item writes the same job slot and title, so the dropped one's loss can vanish.
			if (g.tokenAct[t] === "Board/RenameItem") {
				const n = Number(t.slice(1));
				const later = Object.keys(g.tokenAct).some(
					(o) =>
						Number(o.slice(1)) > n && g.tokenAct[o] === "Board/RenameItem" && g.tokenEntity[o] === entity && g.outcome[o] === "completed"
				);
				if (later) {
					return false;
				}
			}
			return !entity.startsWith("item:") || g.finalItems.has(entity.slice(5));
		});
		if (lost.length > 0 && p.same) {
			found.push(`seed ${s} after ${p.after}: same, though ${lost} finished after the point uninterrupted`);
		}
	}
}

function recoverable(s: number, g: IGenerated, report: IDifferentialReport, found: string[]): void {
	for (const p of report.points) {
		if ((!p.same || p.skipped.length > 0) && g.unrecoverableAfter[p.after - 1]!.length === 0) {
			found.push(
				`seed ${s} after ${p.after}: the faithful repair differs with every running action recoverable: ${JSON.stringify({
					skipped: p.skipped,
					differences: p.differences
				})}`
			);
		}
	}
}

describe(`differentialRestore on generated board scripts, ${SEEDS} seeds`, () => {
	describe("strict scripts", () => {
		const found = nothingFound();
		beforeAll(async () => {
			for (let s = 1; s <= SEEDS; s++) {
				const g = await generate(s, lengthOf(s));
				const repaired = await twice(s, g, true, found);
				if (repaired) {
					faithful(s, g, repaired, found.faithful);
				}
				const bare = await twice(s, g, false, found);
				if (bare) {
					unrepaired(s, g, bare, found.unrepaired);
				}
			}
		}, 600_000);

		it("give the same report on a second call", () => {
			expect(found.determinism).toEqual([]);
		});

		it("end every point same with nothing skipped under the faithful repair", () => {
			expect(found.faithful).toEqual([]);
		});

		it("drop the snapshot's list and differ where work is lost without a repair", () => {
			expect(found.unrepaired).toEqual([]);
		});

		it("differ at no point whose only differences are between ids of the same item", () => {
			expect(found.ids).toEqual([]);
		});

		it("leave nothing running and throw nothing", () => {
			expect(found.hygiene).toEqual([]);
		});
	});

	describe("lax scripts, with work queued behind holds", () => {
		const found = nothingFound();
		beforeAll(async () => {
			for (let s = 1; s <= SEEDS; s++) {
				const g = await generate(s, lengthOf(s), true);
				const repaired = await twice(s, g, true, found);
				if (repaired) {
					recoverable(s, g, repaired, found.faithful);
				}
				await twice(s, g, false, found);
			}
		}, 600_000);

		it("give the same report on a second call", () => {
			expect(found.determinism).toEqual([]);
		});

		it("differ under the faithful repair only where it can't see the work", () => {
			expect(found.faithful).toEqual([]);
		});

		it("drop the snapshot's list", () => {
			expect(found.unrepaired).toEqual([]);
		});

		it("differ at no point whose only differences are between ids of the same item", () => {
			expect(found.ids).toEqual([]);
		});

		it("leave nothing running and throw nothing", () => {
			expect(found.hygiene).toEqual([]);
		});
	});
});
