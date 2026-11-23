import type { IRuntime } from "../../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../../src/Runtime/internals";
import type { IDifferentialStep } from "../../../src/Snapshot/index";
import type { IEffectStub } from "../../../src/Testing/createTestRuntime";
import type { IActionContext } from "../../../src/Types/IActionContext";
import type { IBoard } from "./boardApp";
import { dispatchStep, settleStep } from "../../../src/Snapshot/index";
import { createTestRuntime, guids, settled } from "../../../src/Testing/createTestRuntime";
import { ACTIONS, ALL_ACTIONS, allItems, counterStubs, fetchText, save, seed, transfer } from "./boardApp";

function rng(seedValue: number): () => number {
	let a = seedValue >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type IBoardRuntime = IRuntime<IBoard>;

const boardOf = (runtime: IBoardRuntime): string => runtime.state.$Id;

const listOf =
	(key: string) =>
	(runtime: IBoardRuntime): string => {
		const list = runtime.state.Lists.find((l) => l.Key === key);
		if (!list) {
			throw new Error(`no list ${key}`);
		}
		return list.$Id;
	};

const itemOf =
	(key: string) =>
	(runtime: IBoardRuntime): string => {
		const item = allItems(runtime.state).find((i) => i.Key === key);
		if (!item) {
			throw new Error(`no item ${key}`);
		}
		return item.$Id;
	};

export type IStepMeta =
	| {
			kind: "dispatch";
			token: string;
	  }
	| {
			kind: "settle";
			token: string;
	  };

export type IOutcome = "completed" | "errored" | "stopped";

export interface IGenerated {
	steps: IDifferentialStep<IBoard>[];
	meta: IStepMeta[];
	/** The tokens of the actions running after each step, by step index. */
	inFlightAfter: string[][];
	outcome: Record<string, IOutcome>;
	tokenAct: Record<string, string>;
	/** `board`, `list:<key>` or `item:<key>`. */
	tokenEntity: Record<string, string>;
	finalItems: Set<string>;
	hold: string[];
	/** By step index, the running tokens a repair can't dispatch again from state: queued, or holding an answer it hasn't written. */
	unrecoverableAfter: string[][];
}

interface IOpen {
	type: string;
	key: string;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

const ownerOf = (key: string): string => key.split("/")[0]!;

/**
 * Plays a random script on a test runtime and records what the model expects of it. `lax` drops the two rules that
 * keep a faithful repair possible: no dispatch onto a held entity, since queued work has written no job yet, and no
 * settling an open wait while another action holds its entity, since the resumed action has its answer but can't
 * write it until the hold comes back.
 */
export async function generate(seedValue: number, length: number, lax = false): Promise<IGenerated> {
	const random = rng(seedValue);
	const pick = <V>(xs: readonly V[]): V => xs[Math.floor(random() * xs.length)]!;
	const out: IGenerated = {
		steps: [],
		meta: [],
		inFlightAfter: [],
		outcome: {},
		tokenAct: {},
		tokenEntity: {},
		finalItems: new Set(),
		hold: [],
		unrecoverableAfter: []
	};
	const open: IOpen[] = [];
	const holder =
		(type: string): IEffectStub =>
		(
			effect: {
				Key: string;
			},
			action?: IActionContext
		) =>
			new Promise((resolve, reject) => {
				const entry: IOpen = {
					type,
					key: effect.Key,
					resolve,
					reject
				};
				open.push(entry);
				if (!out.hold.includes(type)) {
					out.hold.push(type);
				}
				action?.signal.addEventListener(
					"abort",
					() => {
						const at = open.indexOf(entry);
						if (at !== -1) {
							open.splice(at, 1);
						}
					},
					{
						once: true
					}
				);
			});
	const runtime = createTestRuntime<IBoard>(
		structuredClone(seed),
		{
			...counterStubs(),
			generateGuid: guids("gen"),
			[save.Type]: holder(save.Type),
			[transfer.Type]: holder(transfer.Type),
			[fetchText.Type]: holder(fetchText.Type)
		},
		{
			allowFailures: ALL_ACTIONS
		}
	);
	let tokens = 0;
	let fetched = 0;
	const unsettled = () => Object.keys(out.tokenAct).filter((t) => out.outcome[t] === undefined);
	const fetchOpen = (token: string) => open.some((o) => o.type === fetchText.Type && o.key === token);
	const boardHeldBesides = (except?: string) =>
		unsettled().some((t) => t !== except && out.tokenEntity[t] === "board" && !(out.tokenAct[t] === "Board/OpenNote" && fetchOpen(t)));
	const itemFree = (key: string, act: string) => {
		const running = unsettled().filter((t) => out.tokenEntity[t] === `item:${key}`);
		return (
			running.length === 0 || ((act === "Board/RenameItem" || act === "Board/TouchItem") && running.every((t) => out.tokenAct[t] === act))
		);
	};
	const listItemKeys = () => runtime.state.Lists.flatMap((l) => l.Items.map((i) => i.Key));
	const allItemKeys = () => allItems(runtime.state).map((i) => i.Key);
	const listKeys = runtime.state.Lists.map((l) => l.Key);

	const dispatchOptions = (): (() => void)[] => {
		const options: (() => void)[] = [];
		const add = (act: string, entity: string, on: (runtime: IBoardRuntime) => string, args: (token: string) => unknown[]) =>
			options.push(() => {
				const token = `t${++tokens}`;
				const given = args(token);
				out.tokenAct[token] = act;
				out.tokenEntity[token] = entity;
				out.steps.push(dispatchStep(ACTIONS[act]!, on, given as never));
				out.meta.push({
					kind: "dispatch",
					token
				});
				runtime.dispatch(ACTIONS[act]!, on(runtime), ...given).then(
					(value) => {
						out.outcome[token] = value === true ? "completed" : "stopped";
					},
					() => {
						out.outcome[token] = "errored";
					}
				);
			});
		if (lax || !boardHeldBesides()) {
			add("Board/AddItem", "board", boardOf, (t) => [
				t,
				pick(listKeys),
				`title-${t}`
			]);
			add("Board/OpenNote", "board", boardOf, (t) => [
				t,
				`note-${t}`
			]);
			const inLists = listItemKeys();
			if (inLists.length > 0) {
				const key = pick(inLists);
				add("Board/MoveNow", "board", boardOf, (t) => [
					t,
					key,
					pick(listKeys)
				]);
				add("Board/MoveWait", "board", boardOf, (t) => [
					t,
					key,
					pick(listKeys)
				]);
				add("Board/RemoveItem", "board", boardOf, (t) => [
					t,
					key
				]);
			}
			const known = allItemKeys();
			if (known.length > 0) {
				add("Board/SaveTwo", "board", boardOf, (t) => [
					t,
					pick(known),
					pick(known)
				]);
				add("Board/SelectItem", "board", boardOf, (t) => [
					t,
					pick(known)
				]);
			}
		}
		const listKey = pick(listKeys);
		add("Board/RenameList", `list:${listKey}`, listOf(listKey), (t) => [
			t,
			`name-${t}`
		]);
		const items = allItemKeys();
		if (items.length > 0) {
			const key = pick(items);
			for (const act of [
				"Board/RenameItem",
				"Board/TouchItem",
				"Board/CatchSave",
				"Board/CountHits"
			]) {
				if (lax || itemFree(key, act)) {
					add(act, `item:${key}`, itemOf(key), (t) =>
						act === "Board/RenameItem"
							? [
									t,
									`title-${t}`
								]
							: [
									t
								]
					);
				}
			}
		}
		return options;
	};

	const settleable = () =>
		open.filter((o) => {
			const token = ownerOf(o.key);
			return lax || !(out.tokenAct[token] === "Board/OpenNote" && boardHeldBesides(token));
		});

	const settle = (entry: IOpen, reject: boolean) => {
		const key = entry.key;
		const error = new Error(`no ${key}`);
		const value = entry.type === fetchText.Type ? `f${++fetched}` : undefined;
		out.steps.push(
			settleStep(
				entry.type,
				reject
					? {
							error
						}
					: {
							value
						},
				{
					where: (effect) =>
						(
							effect as unknown as {
								Key: string;
							}
						).Key === key
				}
			)
		);
		out.meta.push({
			kind: "settle",
			token: ownerOf(key)
		});
		open.splice(open.indexOf(entry), 1);
		if (reject) {
			entry.reject(error);
		} else {
			entry.resolve(value);
		}
	};

	const check = () => {
		const board = runtime.state;
		const jobs = new Set<string>();
		for (const job of board.Jobs) {
			jobs.add(job.Key);
		}
		for (const list of board.Lists) {
			for (const job of list.Jobs) {
				jobs.add(job.Key);
			}
		}
		for (const item of allItems(board)) {
			for (const job of item.Jobs) {
				jobs.add(job.Key === "rename" ? (job.Args[0] as string) : job.Key);
			}
		}
		const waits = new Set([
			"Board/OpenNote",
			"Board/RenameList"
		]);
		const lost = unsettled().filter((t) => !jobs.has(t) || (waits.has(out.tokenAct[t]!) && !fetchOpen(t)));
		out.unrecoverableAfter.push(lost);
		if (lax) {
			return;
		}
		for (const t of lost) {
			throw new Error(`model: ${t} (${out.tokenAct[t]}) is running without a job`);
		}
		const running = (runtime as IRuntimeInternal<IBoard>).get("runtime/inFlightActions")();
		if (running.length !== unsettled().length) {
			throw new Error(`model: the runtime has ${running.length} running, the model ${unsettled().length}`);
		}
	};

	const next = async () => {
		await settled();
		check();
		out.inFlightAfter.push(unsettled());
	};

	try {
		await settled();
		for (let i = 0; i < length; i++) {
			const can = settleable();
			if (can.length > 0 && random() < 0.45) {
				settle(pick(can), random() < 0.15);
			} else {
				pick(dispatchOptions())();
			}
			await next();
		}
		while (open.length > 0) {
			const can = settleable();
			if (can.length === 0) {
				throw new Error("model: effects are open and none can be settled");
			}
			settle(can[0]!, false);
			await next();
		}
		if (unsettled().length > 0) {
			throw new Error(`model: ends with ${unsettled().join(", ")} running`);
		}
		for (const item of allItems(runtime.state)) {
			out.finalItems.add(item.Key);
		}
	} finally {
		runtime.dispose();
	}
	return out;
}
