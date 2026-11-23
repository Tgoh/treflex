import type { IActionContext, IActionGenerator, IAskId, IEffect, IRuntime } from "treflex";
import type { IDifferences, IDifferentialReport, IDifferentialSkip, IDifferentialStep, IRestorePoint } from "treflex/snapshot";
import type { ICheckProvider } from "../backend/backend";
import type { IWait } from "../backend/fakeBackend";
import type { IPortal } from "../portal/Portal";
import type { ITour } from "../tour/Tour";
import type { ILegKind } from "./destinations";
import type { IThreadLine, ITrip } from "./Trip";
import { defineEffect, guids, named, settled } from "treflex";
import { differentialRestore, dispatchStep, restoreTestRuntime } from "treflex/snapshot";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../backend/backend";
import { fakeBackend, providerAnswer } from "../backend/fakeBackend";
import { getDefaultState, ROOT_ID } from "../portal/Portal";
import { registerReceivers, repairRestore } from "../portal/session";
import { clock } from "../text";
import { SEARCH_NAME } from "./Leg";
import { openTrip, startTrip } from "./Planner";
import { CHOOSE_FLIGHT_NAME, carriesOn, pickFare, question, searchesOf, TripReceiver } from "./Trip";

const RESUMING = {
	build: "test",
	resume: true
} as const;

interface IAnswerProvider extends IEffect {
	Type: "Test/AnswerProvider";
	Kind: ILegKind;
	/** Answer every check of this kind from now on, not only the next one. */
	All: boolean;
}

const answerProvider = defineEffect<IAnswerProvider, void>("Test/AnswerProvider");

function* letProviderAnswer(_draft: ITour, kind: ILegKind, all: boolean): IActionGenerator {
	yield* answerProvider({
		Kind: kind,
		All: all
	});
}
named(letProviderAnswer, "Test/LetProviderAnswer");

const RETRIED: ICheckProvider = {
	Type: "Backend/CheckProvider",
	Destination: "reykjavik",
	Kind: "hotel",
	Index: 1,
	Retries: 1
};

const RETRIED_KEY = `${RETRIED.Kind}|${RETRIED.Index}`;

/** The provider checks each run asked, in the order the tool asks for stubs: the uninterrupted run's, then each restored run's. */
const runs: string[][] = [];

function providers() {
	const asked: string[] = [];
	runs.push(asked);
	const open = new Set<ILegKind>();
	const waiting: {
		kind: ILegKind;
		resolve: () => void;
	}[] = [];
	const wait: IWait = (_ms, signal, effect, attempt) => {
		asked.push(`${effect.Kind}|${effect.Index}|${attempt}`);
		if (open.has(effect.Kind)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const entry = {
				kind: effect.Kind,
				resolve
			};
			waiting.push(entry);
			signal?.addEventListener(
				"abort",
				() => {
					waiting.splice(waiting.indexOf(entry), 1);
					reject(signal.reason);
				},
				{
					once: true
				}
			);
		});
	};
	const answer = ({ Kind, All }: IAnswerProvider): void => {
		if (All) open.add(Kind);
		for (const entry of waiting.filter((w) => w.kind === Kind).slice(0, All ? undefined : 1)) {
			waiting.splice(waiting.indexOf(entry), 1);
			entry.resolve();
		}
	};
	const backend = fakeBackend(wait);
	return {
		"Backend/CheckProvider": (effect: ICheckProvider, action?: IActionContext) => backend.fn(effect, action),
		"Test/AnswerProvider": answer,
		"Backend/Now": () => 1_700_000_000_000
	};
}

const attemptsAt = (asked: readonly string[], key: string): number[] =>
	asked.filter((call) => call.startsWith(`${key}|`)).map((call) => Number(call.split("|")[2]));

const tripIn = (state: IPortal): ITrip => state.Trips.Trips[0]!;

const tripOf = (runtime: IRuntime<IPortal>): ITrip => tripIn(runtime.state);

const answered = (kind: ILegKind, all: boolean): IDifferentialStep<IPortal> =>
	dispatchStep<
		IPortal,
		[
			ILegKind,
			boolean
		]
	>(letProviderAnswer, "Tour", [
		kind,
		all
	]);

const start: IDifferentialStep<IPortal> = dispatchStep(startTrip, "Trips", [
	"reykjavik"
]);

const pick: IDifferentialStep<IPortal> = dispatchStep(
	pickFare,
	(runtime) => tripOf(runtime).$Id,
	(runtime) => {
		const entry = runtime.processSelector(question, () => tripOf(runtime));
		if (!entry) throw new Error("no flight question is open");
		return [
			entry.Id as IAskId<string>,
			tripOf(runtime).Legs[0]!.Fares[0]!.Id
		];
	}
);

const tick: IDifferentialStep<IPortal> = dispatchStep(
	TripReceiver.handle,
	(runtime) => tripOf(runtime).$Id,
	(runtime) => [
		{
			Type: "Trip/Clock"
		},
		{
			publisher: {
				Id: tripOf(runtime).$Id
			}
		}
	]
);

const SCRIPTS: Record<string, IDifferentialStep<IPortal>[]> = {
	searches: [
		start,
		answered("hotel", false),
		answered("hotel", false),
		answered("hotel", false),
		answered("hotel", true),
		answered("activities", true),
		answered("flights", true),
		pick
	],
	meanwhile: [
		start,
		answered("flights", true),
		answered("hotel", false),
		tick,
		dispatchStep(openTrip, "Trips", [
			null
		]),
		dispatchStep(openTrip, "Trips", (runtime) => [
			tripOf(runtime).$Id
		]),
		answered("hotel", true),
		answered("activities", true),
		pick
	]
};

/** What a restore writes about itself whatever it resumed or dropped: the banner's notes and the tour's reload mark. */
const RECORDS = /^(Restore|Trips\.Restore|Aquarium\.Restore|Tour\.Reloaded)$/;
const THREAD = /^Trips\.Trips\[0\]\.Thread\[\d+\]/;
const LEGS = /^Trips\.Trips\[0\]\.Legs/;

const short = (name: string | null): string => (name ?? "(anonymous)").replace(/^Trips\//, "");

interface IBuilt {
	runtime: IRuntime<IPortal>;
	setupAt: number;
	repairAt?: number;
}

interface IRestoredRun {
	differences: IDifferences;
	skipped: IDifferentialSkip[];
	atCut: IThreadLine[];
	/** The trip's working seconds at the cut, which the reload's divider is stamped with. */
	elapsed: number;
	thread: IThreadLine[];
	ended: IPortal;
	ms: number;
}

interface IPlayedPoint {
	point: IRestorePoint;
	resumed: IRestoredRun;
	dataOnly?: IRestoredRun;
	/** The provider checks of the resumed run, and then of the data-only run. */
	asked: string[][];
}

interface IPlayed {
	report: IDifferentialReport;
	uninterrupted: IPortal;
	asked: string[];
	points: IPlayedPoint[];
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * Plays a script with `compareDataOnly` and resume on, or without the option and with resume off. The tool builds
 * the uninterrupted run's runtime and then, per point, the run to the point and its restore: twice, the resumed
 * run's and then the data-only run's, with the option.
 */
async function play(script: IDifferentialStep<IPortal>[], compared: boolean): Promise<IPlayed> {
	const built: IBuilt[] = [];
	runs.length = 0;
	const report = await differentialRestore(
		{
			seed: getDefaultState(),
			setup: (runtime) => {
				registerReceivers(runtime);
				built.push({
					runtime,
					setupAt: performance.now()
				});
			},
			repair: (runtime, result) => {
				built.find((b) => b.runtime === runtime)!.repairAt = performance.now();
				return repairRestore(runtime, result);
			},
			effectStubs: providers,
			...(compared
				? {
						options: RESUMING,
						compareDataOnly: true
					}
				: {})
		},
		script
	);
	const per = compared ? 2 : 1;
	expect(built).toHaveLength(1 + 2 * per * report.points.length);
	expect(runs).toHaveLength(1 + per * report.points.length);
	const restored = (run: number, differences: IDifferences, skipped: IDifferentialSkip[]): IRestoredRun => {
		const at = 2 + 2 * run;
		return {
			differences,
			skipped,
			atCut: copy(tripOf(built[at - 1]!.runtime).Thread),
			elapsed: tripOf(built[at - 1]!.runtime).Elapsed,
			thread: copy(tripOf(built[at]!.runtime).Thread),
			ended: copy(built[at]!.runtime.state),
			ms: built[at]!.repairAt! - built[at]!.setupAt
		};
	};
	return {
		report,
		uninterrupted: copy(built[0]!.runtime.state),
		asked: runs[0]!,
		points: report.points.map((point, i) => ({
			point,
			resumed: restored(per * i, point.differences, point.skipped),
			...(compared
				? {
						dataOnly: restored(per * i + 1, point.dataOnly!.differences, point.dataOnly!.skipped)
					}
				: {}),
			asked: runs.slice(1 + per * i, 1 + per * (i + 1))
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

/** Where an entity sits on the trip: the trip itself, or a leg by its kind. */
const placeOf = (trip: ITrip, entityId: string): string =>
	entityId === trip.$Id ? "trip" : (trip.Legs.find((leg) => leg.$Id === entityId)?.Kind ?? entityId);

const caughtOf = (run: IPlayed, point: IRestorePoint): string =>
	point.inFlight.map((entry) => `${short(entry.Name)} ${entry.State} on ${placeOf(tripIn(run.uninterrupted), entry.EntityId)}`).join(", ");

interface IOutcome {
	/** The line the trip's thread says after the reload's divider, or null when the restore wrote none. */
	Back: string | null;
	Chosen: boolean;
	Skipped: number[];
	/** The state paths it differs from the uninterrupted run at, the restore's own records and the thread aside. */
	Differ: string[];
}

function outcomeOf(run: IRestoredRun): IOutcome {
	const divider = run.thread.findIndex((line, i) => line.Divider && i >= run.atCut.length);
	return {
		Back: divider === -1 ? null : (run.thread[divider + 1]?.Text ?? null),
		Chosen: tripIn(run.ended).Choice !== null,
		Skipped: run.skipped.map((skip) => skip.step),
		Differ: (run.differences.state ?? [])
			.map((d) => d.path)
			.filter((path) => !RECORDS.test(path) && !THREAD.test(path))
			.sort()
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
		caughtOf(run, p.point),
		outcomeOf(p[which]!)
	]);

const THREE = "Back. The flight, hotel and activity searches carry on where they left off.";
const CLOSED = "The flight question closed, so choose a flight when you're ready.";

const QUESTION_LOST = [
	"Tour.Answered",
	"Trips.Trips[0].Choice",
	"Trips.Trips[0].HoldUntil",
	"Trips.Trips[0].HoldCheckedAt",
	"Trips.Trips[0].Finished"
];

const carried = (back: string): IOutcome => ({
	Back: back,
	Chosen: true,
	Skipped: [],
	Differ: []
});

const asked = (back: string | null, differ: string[] = []): IOutcome => ({
	Back: back,
	Chosen: true,
	Skipped: [],
	Differ: differ
});

const closed = (back: string, skipped: number, differ: string[] = []): IOutcome => ({
	Back: back,
	Chosen: false,
	Skipped: [
		skipped
	],
	Differ: [
		...differ,
		...QUESTION_LOST
	].sort()
});

interface IExpected {
	thread: string[];
	dataOnly: IRow[];
	resumed: IRow[];
	/** Per point, each drop's name and reason, what resumed, and the comparison's `changed` and `reported` paths. */
	compared: [
		after: number,
		dropped: string[],
		resumed: string[],
		changed: string[],
		reported: string[]
	][];
}

// biome-ignore format: one row per restore point
const EXPECTED: Record<string, IExpected> = {
	searches: {
		thread: [
			"Planning **Reykjavík** for two, 20 to 25 February.",
			"Searching flights, hotels and activities at once.",
			"Checked 24 hotels. **Skuggi Suites** leads at A$154 a night.",
			"Found 8 things to do, and kept the best 3.",
			"Narrowed 43 fares to two.",
			"You chose the morning flight. **Holding it for 15 minutes.**",
			"That's everything. **Reykjavík** is ready to review."
		],
		dataOnly: [
			[1, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[2, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[3, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[4, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[5, "SearchLeg holding on flights, SearchLeg holding on activities", carried("Back. The flight and activity searches carry on where they left off.")],
			[6, "SearchLeg holding on flights", carried("Back. The flight search carries on where it left off.")],
			[7, "ChooseFlight open on trip", closed(`Back. ${CLOSED}`, 8)]
		],
		resumed: [
			[1, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[2, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[3, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[4, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[5, "SearchLeg holding on flights, SearchLeg holding on activities", carried("Back. The flight and activity searches carry on where they left off.")],
			[6, "SearchLeg holding on flights", carried("Back. The flight search carries on where it left off.")],
			[7, "ChooseFlight open on trip", asked(null)]
		],
		compared: [
			[1, ["SearchLeg not-marked", "SearchLeg not-marked", "SearchLeg not-marked"], [], [], []],
			[2, ["SearchLeg not-marked", "SearchLeg not-marked", "SearchLeg not-marked"], [], [], []],
			[3, ["SearchLeg not-marked", "SearchLeg not-marked", "SearchLeg not-marked"], [], [], []],
			[4, ["SearchLeg not-marked", "SearchLeg not-marked", "SearchLeg not-marked"], [], [], []],
			[5, ["SearchLeg not-marked", "SearchLeg not-marked"], [], [], []],
			[6, ["SearchLeg not-marked"], [], [], []],
			[7, [], ["ChooseFlight at ask"], ["Restore", "Trips.Restore"], []]
		]
	},
	meanwhile: {
		thread: [
			"Planning **Reykjavík** for two, 20 to 25 February.",
			"Searching flights, hotels and activities at once.",
			"Narrowed 43 fares to two.",
			"Checked 24 hotels. **Skuggi Suites** leads at A$154 a night.",
			"Found 8 things to do, and kept the best 3.",
			"You chose the morning flight. **Holding it for 15 minutes.**",
			"That's everything. **Reykjavík** is ready to review."
		],
		dataOnly: [
			[1, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[2, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", closed(`Back. The hotel and activity searches carry on where they left off. ${CLOSED}`, 9)],
			[3, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", closed(`Back. The hotel and activity searches carry on where they left off. ${CLOSED}`, 9)],
			[4, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", closed(`Back. The hotel and activity searches carry on where they left off. ${CLOSED}`, 9)],
			[5, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", closed(`Back. The hotel and activity searches carry on where they left off. ${CLOSED}`, 9, ["Tour.CameBack"])],
			[6, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", closed(`Back. The hotel and activity searches carry on where they left off. ${CLOSED}`, 9)],
			[7, "ChooseFlight open on trip, SearchLeg holding on activities", closed(`Back. The activity search carries on where it left off. ${CLOSED}`, 9)],
			[8, "ChooseFlight open on trip", closed(`Back. ${CLOSED}`, 9)]
		],
		resumed: [
			[1, "SearchLeg holding on flights, SearchLeg holding on hotel, SearchLeg holding on activities", carried(THREE)],
			[2, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", asked("Back. The hotel and activity searches carry on where they left off.")],
			[3, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", asked("Back. The hotel and activity searches carry on where they left off.")],
			[4, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", asked("Back. The hotel and activity searches carry on where they left off.")],
			[5, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", asked("Back. The hotel and activity searches carry on where they left off.", ["Tour.CameBack"])],
			[6, "ChooseFlight open on trip, SearchLeg holding on hotel, SearchLeg holding on activities", asked("Back. The hotel and activity searches carry on where they left off.")],
			[7, "ChooseFlight open on trip, SearchLeg holding on activities", asked("Back. The activity search carries on where it left off.")],
			[8, "ChooseFlight open on trip", asked(null)]
		],
		compared: [
			[1, ["SearchLeg not-marked", "SearchLeg not-marked", "SearchLeg not-marked"], [], [], []],
			[2, ["SearchLeg not-marked", "SearchLeg not-marked"], ["ChooseFlight at ask"], ["Restore", "Trips.Trips[0].Thread[4].Text", "Trips.Restore"], ["Trips.Trips[0].Thread[7]", "Trips.Trips[0].Thread[8]"]],
			[3, ["SearchLeg not-marked", "SearchLeg not-marked"], ["ChooseFlight at ask"], ["Restore", "Trips.Trips[0].Thread[4].Text", "Trips.Restore"], ["Trips.Trips[0].Thread[7]", "Trips.Trips[0].Thread[8]"]],
			[4, ["SearchLeg not-marked", "SearchLeg not-marked"], ["ChooseFlight at ask"], ["Restore", "Trips.Trips[0].Thread[4].Text", "Trips.Restore"], ["Trips.Trips[0].Thread[7]", "Trips.Trips[0].Thread[8]"]],
			[5, ["SearchLeg not-marked", "SearchLeg not-marked"], ["ChooseFlight at ask"], ["Restore", "Trips.Trips[0].Thread[4].Text", "Trips.Restore"], ["Trips.Trips[0].Thread[7]", "Trips.Trips[0].Thread[8]"]],
			[6, ["SearchLeg not-marked", "SearchLeg not-marked"], ["ChooseFlight at ask"], ["Restore", "Trips.Trips[0].Thread[4].Text", "Trips.Restore"], ["Trips.Trips[0].Thread[7]", "Trips.Trips[0].Thread[8]"]],
			[7, ["SearchLeg not-marked"], ["ChooseFlight at ask"], ["Restore", "Trips.Trips[0].Thread[5].Text", "Trips.Restore"], ["Trips.Trips[0].Thread[7]", "Trips.Trips[0].Thread[8]"]],
			[8, [], ["ChooseFlight at ask"], ["Restore", "Trips.Restore"], []]
		]
	}
};

/** The points measure 2 exempts by ruling 35, pinned so a change to the exemption's reach shows. */
const BESIDE_DROPPED: Record<string, number[]> = {
	meanwhile: [
		2,
		3,
		4,
		6,
		7
	]
};

/**
 * The points measure 2 passes only by ruling 37, with the differences it sets aside: the trip's away mark is a
 * transient, which no snapshot holds, so coming back after a reload between leaving and returning ticks nothing.
 */
const AS_DATA_ONLY: Record<string, Record<number, string[]>> = {
	meanwhile: {
		5: [
			"Tour.CameBack"
		]
	}
};

/**
 * What a restored run differs by that no drop beside the question explains: every path but the restore's records
 * and the thread, and a thread that isn't the uninterrupted one with the repair's two lines for the dropped searches
 * at the cut. Null when no search dropped on the trip.
 */
function unexplained(run: IPlayed, p: IPlayedPoint): string[] | null {
	const searched = new Set(p.point.result.dropped.filter((drop) => drop.name === SEARCH_NAME).map((drop) => drop.entityId));
	const kinds = tripIn(p.resumed.ended)
		.Legs.filter((leg) => searched.has(leg.$Id))
		.map((leg) => leg.Kind);
	if (kinds.length === 0) return null;
	const { atCut, elapsed } = p.resumed;
	const thread = [
		...atCut,
		{
			At: elapsed,
			Text: `Page reloaded at ${clock(elapsed)}`,
			Divider: true
		},
		{
			At: elapsed,
			Text: `Back. The ${searchesOf(kinds)} ${carriesOn(kinds)}.`
		},
		...tripIn(run.uninterrupted).Thread.slice(atCut.length)
	];
	const rest = (p.resumed.differences.state ?? []).map((d) => d.path).filter((path) => !RECORDS.test(path) && !THREAD.test(path));
	return JSON.stringify(p.resumed.thread) === JSON.stringify(thread)
		? rest
		: [
				...rest,
				"Trips.Trips[0].Thread"
			];
}

const pathsOf = (differences: IDifferences): string[] => (differences.state ?? []).map((d) => d.path);

/** Ruling 37: the data-only run differs at `path` too, from the same expected value to the same actual one. */
function asDataOnly(p: IPlayedPoint, path: string): boolean {
	const resumed = (p.point.differences.state ?? []).find((d) => d.path === path);
	const dataOnly = (p.point.dataOnly!.differences.state ?? []).find((d) => d.path === path);
	return resumed !== undefined && dataOnly !== undefined && JSON.stringify(resumed) === JSON.stringify(dataOnly);
}

describe("every restore point of the trips", () => {
	it("asks a failed provider check again, and the script reaches the failure and its retry", async () => {
		expect(() => providerAnswer(RETRIED, 0)).toThrow(ProviderError);
		expect(() => providerAnswer(RETRIED, 1)).not.toThrow();
		expect(() =>
			providerAnswer(
				{
					...RETRIED,
					Index: 0
				},
				0
			)
		).not.toThrow();
		const run = await played("searches");
		expect(attemptsAt(run.asked, RETRIED_KEY)).toEqual([
			0,
			1
		]);
		const between = run.points.find((p) => p.point.after === 3)!;
		for (const asked of between.asked) {
			expect(attemptsAt(asked, RETRIED_KEY)).toEqual([
				0,
				1,
				0,
				1
			]);
		}
	});

	for (const name of Object.keys(SCRIPTS)) {
		it(`pins what a reload does in the ${name} script, with resume and without`, async () => {
			const run = await played(name);
			const expected = EXPECTED[name]!;
			expect(run.report.quiet).toBe(0);
			expect(run.points.map((p) => p.point.after)).toEqual(SCRIPTS[name]!.slice(0, -1).map((_, i) => i + 1));
			expect(tripIn(run.uninterrupted).Thread.map((line) => line.Text)).toEqual(expected.thread);
			expect(tableOf(run, "dataOnly")).toEqual(expected.dataOnly);
			expect(tableOf(run, "resumed")).toEqual(expected.resumed);
			expect(
				run.points.map((p) => [
					p.point.after,
					p.point.result.dropped.map((drop) => `${short(drop.name)} ${drop.reason}`),
					p.point.result.resumed.map((entry) => `${short(entry.name)} at ${entry.wait}`),
					p.point.comparison!.changed.map((c) => c.path),
					pathsOf(p.point.comparison!.reported)
				])
			).toEqual(expected.compared);
		});

		it(`carries every dropped search on from where it was in the ${name} script`, async () => {
			const run = await played(name);
			const uninterrupted = tripIn(run.uninterrupted).Thread;
			for (const p of run.points) {
				for (const restored of [
					p.resumed,
					p.dataOnly!
				]) {
					expect(Object.keys(restored.differences)).toEqual([
						"state"
					]);
					expect(pathsOf(restored.differences).filter((path) => LEGS.test(path))).toEqual([]);
					expect(uninterrupted.slice(0, restored.atCut.length)).toEqual(restored.atCut);
					const differing = [
						...new Set(
							pathsOf(restored.differences)
								.filter((path) => THREAD.test(path))
								.map((path) => Number(/Thread\[(\d+)\]/.exec(path)![1]))
						)
					];
					expect(differing).toEqual(
						[
							...Array(Math.max(uninterrupted.length, restored.thread.length)).keys()
						].filter((i) => JSON.stringify(uninterrupted[i]) !== JSON.stringify(restored.thread[i]))
					);
				}
				const searches = p.point.result.dropped.filter((drop) => drop.name === SEARCH_NAME);
				const note = p.resumed.ended.Trips.Restore!.Trips[0]!;
				expect(note.CarriedOn).toHaveLength(searches.length);
				expect(note.AskedAgain).toBe(p.point.result.resumed.some((entry) => entry.name === CHOOSE_FLIGHT_NAME));
				expect(note.Unanswered).toBe(false);
				expect(p.dataOnly!.ended.Trips.Restore!.Trips[0]).toMatchObject({
					AskedAgain: false,
					Unanswered: p.point.inFlight.some((entry) => entry.Name === CHOOSE_FLIGHT_NAME)
				});
			}
		});

		it(`is never worse with resume than without it in the ${name} script`, async () => {
			const run = await played(name);
			expect(run.report.worse).toEqual([]);
		});

		it(`ends as the uninterrupted run at every point the ${name} script catches the flight question`, async () => {
			const run = await played(name);
			const caught = run.points.filter((p) =>
				p.point.inFlight.some((entry) => entry.Name === CHOOSE_FLIGHT_NAME && entry.State === "open")
			);
			expect(caught.length).toBeGreaterThan(0);
			const exempted: number[] = [];
			const setAside: Record<number, string[]> = {};
			for (const p of caught) {
				const beyond = pathsOf(p.point.differences).filter((path) => !RECORDS.test(path));
				if (beyond.length === 0) continue;
				const remaining = unexplained(run, p) ?? beyond;
				const same = remaining.filter((path) => asDataOnly(p, path));
				expect(
					remaining.filter((path) => !same.includes(path)),
					`the point after step ${p.point.after} doesn't end as the uninterrupted run, and neither a drop beside the question nor the data-only run explains it`
				).toEqual([]);
				if (same.length === 0) exempted.push(p.point.after);
				else setAside[p.point.after] = same;
			}
			expect(exempted).toEqual(BESIDE_DROPPED[name] ?? []);
			expect(setAside).toEqual(AS_DATA_ONLY[name] ?? {});
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
					const { runtime, result } = await restoreTestRuntime<IPortal>(point.snapshot, {
						rootId: ROOT_ID,
						effectStubs: {
							...providers(),
							generateGuid: guids("after")
						},
						options: {
							...options,
							allowDiags: true
						},
						setup: registerReceivers,
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
			`[portal cost] ${sizes.length} saves: with histories ${Math.min(...sizes.map(([w]) => w))} to ${worst(sizes.map(([w]) => w))} bytes, ` +
				`without ${Math.min(...sizes.map(([, o]) => o))} to ${worst(sizes.map(([, o]) => o))} bytes, histories add up to ${worst(sizes.map(([w, o]) => w - o))} bytes\n` +
				`[portal cost] setup to repair over ${added.length} points with a resumed action: resumed ${figure(resumedMs)}; data-only ${figure(dataOnlyMs)}; ` +
				`added per resumed action ${figure(added)}\n`
		);
		expect(added.length).toBeGreaterThan(0);
	}, 120_000);
});
