import type { IActionGenerator, IAskId, IEntity, IRuntime, IRuntimeEventOf } from "../../src/index";
import type { IWithResume } from "../../src/Resume/createKeeper";
import type { IHistory, ISnapshotHistory } from "../../src/Resume/history";
import type { IRuntimeOptions } from "../../src/Runtime/createRuntime";
import { answer } from "../../src/Effects/answer";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { pendingAsksOf } from "../testHelpers";

export interface ILine extends IEntity {
	Qty: number;
}

export interface IOrder extends IEntity {
	Qty: number;
	Key: string;
	Note: string;
	Lines: Record<string, ILine>;
}

export interface IShop extends IEntity {
	Clock: number;
	Orders: Record<string, IOrder>;
}

export function shop(): IShop {
	const order = (id: string): IOrder => ({
		$Id: id,
		Qty: 1,
		Key: "",
		Note: "",
		Lines: {
			[`${id}-l1`]: {
				$Id: `${id}-l1`,
				Qty: 1
			}
		}
	});
	return {
		$Id: "shop",
		Clock: 0,
		Orders: {
			o1: order("o1"),
			o2: order("o2")
		}
	};
}

export interface IWaiting {
	name: string;
	resolve: (value?: unknown) => void;
	reject: (error: unknown) => void;
}

export interface IHarness<T extends object> {
	runtime: IRuntime<T>;
	diags: IRuntimeEventOf<"diag">[];
	waiting: IWaiting[];
	release(name: string, value?: unknown): void;
	fail(name: string, error: unknown): void;
	envelope(): {
		InFlight: {
			ActionId: string;
			Name: string | null;
		}[];
		Histories?: ISnapshotHistory[];
	};
	historyOf(name: string): IHistory;
}

export function harness<T extends object>(state: T, options: IRuntimeOptions & IWithResume = {}): IHarness<T> {
	const runtime = createRuntime<T>(state, {
		verifyIndex: false,
		build: "test",
		resume: true,
		...options
	} as IRuntimeOptions);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => {
		diags.push(event);
	});
	const waiting: IWaiting[] = [];
	runtime.registerImplementation(
		"Resume/Wait",
		(effect) =>
			new Promise((resolve, reject) => {
				waiting.push({
					name: (
						effect as unknown as {
							Name: string;
						}
					).Name,
					resolve,
					reject
				});
			})
	);
	const take = (name: string): IWaiting => {
		const at = waiting.findIndex((wait) => wait.name === name);
		if (at < 0) {
			throw new Error(`nothing waits on ${name}: ${waiting.map((wait) => wait.name).join(", ")}`);
		}
		return waiting.splice(at, 1)[0]!;
	};
	const envelope = () => JSON.parse(createSnapshot(runtime));
	return {
		runtime,
		diags,
		waiting,
		release: (name, value) => take(name).resolve(value),
		fail: (name, error) => take(name).reject(error),
		envelope,
		historyOf(name) {
			const snapshot = envelope();
			const row = snapshot.InFlight.find((entry: { Name: string | null }) => entry.Name === name);
			const history = (snapshot.Histories ?? []).find((entry: ISnapshotHistory) => entry.ActionId === row?.ActionId);
			if (!history || !("Entries" in history)) {
				throw new Error(`no usable history for ${name}: ${JSON.stringify(history)}`);
			}
			return history;
		}
	};
}

export function* wait(name: string): IActionGenerator<any> {
	return yield {
		Type: "Resume/Wait",
		Name: name
	} as never;
}

function* answers(_owner: IEntity, id: IAskId<unknown>, value: unknown): IActionGenerator {
	yield* answer(id, value as never);
}

export async function answerOn(runtime: IRuntime<any>, owner: IEntity, value: unknown): Promise<void> {
	const [entry] = pendingAsksOf(runtime, owner);
	if (!entry) {
		throw new Error("no open ask");
	}
	await runtime.dispatch(answers, entry.OwnerId, entry.Id as IAskId<unknown>, value);
}

export async function until(predicate: () => boolean): Promise<void> {
	for (let turn = 0; turn < 200; turn++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("timed out");
}

export function kinds(history: IHistory): string[] {
	return history.Entries.map((entry) => entry.Kind);
}
