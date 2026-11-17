import * as tree from "../../src/index";

export type ILib = typeof tree;

// extractBaseline.mjs writes REF last, so it marks a whole extraction. A glob that matches nothing is no error,
// where an import of a missing file is. Vite's glob transform fails on a pattern with no wildcard in it.
const baselineRefFile = Object.values(
	import.meta.glob<string>("./baseline/REF*", {
		query: "?raw",
		import: "default",
		eager: true
	})
)[0];

export const baselineRef = baselineRefFile?.trim() ?? null;

export const baselineMissing =
	baselineRef === null
		? "no baseline engine in packages/core/tests/SideBySide/baseline: run node packages/core/tests/SideBySide/extractBaseline.mjs [ref]"
		: null;

export async function loadEngines(): Promise<{
	tree: ILib;
	baseline: ILib;
} | null> {
	if (baselineRef === null) {
		return null;
	}
	// Untyped on purpose: a static import would put the baseline in this package's program.
	const baseline = (await import(/* @vite-ignore */ new URL("./baseline/packages/core/src/index.ts", import.meta.url).href)) as ILib;
	return {
		tree,
		baseline
	};
}

/** What one engine did in one scenario, in the form the two engines are compared in. */
export interface IRun {
	/** Lines the scenario logged, from its action code and from its driver, in order. */
	code: string[];
	/** `onError` calls, `failure` events and diags, in order. */
	reports: string[];
	/** Records, in the order the record tap heard them. */
	records: string[];
	/** Promise rejections nothing handled while the scenario ran. */
	unhandled: string[];
}

export interface IDeferred {
	promise: Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

function deferred(): IDeferred {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {
		promise,
		resolve,
		reject
	};
}

export interface IWorld {
	runtime: any;
	/** The deferred behind a `wait` effect with this `Key`, made on first use. */
	get(key: string): IDeferred;
}

export interface IOpenOptions {
	/** Leaves `onError` unset, so a failure nothing takes is an unhandled rejection. */
	noOnError?: true;
}

export interface IScenarioApi {
	lib: ILib;
	log(line: string): void;
	/** A test runtime whose records, failures, diags and `onError` calls go into this run. A `wait` effect parks on `get(Key)`. */
	open(state?: object, stubs?: Record<string, (effect: any) => unknown>, options?: IOpenOptions): IWorld;
	/** Runs out the microtask queue and one macrotask turn. */
	flush(): Promise<void>;
	/** Logs `tick` one microtask from now. */
	tick(): void;
}

export type IScenario = (api: IScenarioApi) => Promise<void>;

export function* wait(key: string): Generator<any, any, any> {
	return yield {
		Type: "wait",
		Key: key
	};
}

function describeRecord(record: any, sym: (id: unknown) => string, effectBySeq: Map<number, string>): string {
	switch (record.Kind) {
		case "effect":
			effectBySeq.set(record.Seq, record.Type);
			return `effect ${record.Type} br=${sym(record.BranchId)}`;
		case "response":
			return `response ${effectBySeq.get(record.ForSeq) ?? "?"}${"Error" in record ? " ERR" : ""}`;
		case "step":
			return `step br=${sym(record.BranchId)} n=${record.Changes.length}${record.Cancelling ? " cancelling" : ""}`;
		case "branch:start":
			return `branch:start br=${sym(record.BranchId)} parent=${sym(record.ParentBranchId)}`;
		case "branch:end":
			return `branch:end br=${sym(record.BranchId)} ${record.Status}${record.Error ? ` ${record.Error.Message ?? ""}` : ""}`;
		case "action:start":
			return `action:start ${sym(record.ActionId)} ${record.Label}`;
		case "action:end":
			return `action:end ${sym(record.ActionId)} ${record.Status}`;
		default:
			return record.Kind;
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 40; i++) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (let i = 0; i < 40; i++) {
		await Promise.resolve();
	}
}

function message(error: any): string {
	return error?.message ?? String(error);
}

interface INodeProcess {
	listeners(event: "unhandledRejection"): ((reason: unknown) => void)[];
	removeAllListeners(event: "unhandledRejection"): void;
	on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
	off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
}

export async function runOn(lib: ILib, scenario: IScenario): Promise<IRun> {
	const run: IRun = {
		code: [],
		reports: [],
		records: [],
		unhandled: []
	};
	const api: IScenarioApi = {
		lib,
		log: (line) => {
			run.code.push(line);
		},
		open: (state, stubs, options) => {
			const deferreds: Record<string, IDeferred> = {};
			const get = (key: string): IDeferred => {
				deferreds[key] ??= deferred();
				return deferreds[key];
			};
			const runtime: any = lib.createTestRuntime(
				(state ?? {
					$Id: "e1",
					items: [] as string[]
				}) as any,
				{
					wait: (effect: any) => get(effect.Key).promise,
					...stubs
				},
				options?.noOnError
					? undefined
					: {
							onError: (error: unknown) => {
								run.reports.push(`onError ${message(error)}`);
							}
						}
			);
			const ids = new Map<string, string>();
			const sym = (id: unknown): string => {
				const key = String(id);
				if (!ids.has(key)) {
					ids.set(key, `#${ids.size + 1}`);
				}
				return ids.get(key)!;
			};
			const effectBySeq = new Map<number, string>();
			runtime.on("record", (record: unknown) => {
				run.records.push(describeRecord(record, sym, effectBySeq));
			});
			runtime.on("failure", (failure: any) => {
				run.reports.push(`failure ${message(failure.Error)} status=${failure.Status} close=${failure.Close} taken=${failure.Taken}`);
			});
			runtime.on("diag", (diag: any) => {
				run.reports.push(`diag ${diag.code}`);
			});
			return {
				runtime,
				get
			};
		},
		flush,
		tick: () => {
			void Promise.resolve().then(() => {
				run.code.push("tick");
			});
		}
	};
	// The runner's own listener fails the run on any unhandled rejection; here one is part of what is compared.
	const node = (
		globalThis as unknown as {
			process: INodeProcess;
		}
	).process;
	const runnerListeners = node.listeners("unhandledRejection");
	const hear = (reason: unknown): void => {
		run.unhandled.push(message(reason));
	};
	node.removeAllListeners("unhandledRejection");
	node.on("unhandledRejection", hear);
	try {
		await scenario(api);
		await flush();
		await flush();
	} finally {
		node.off("unhandledRejection", hear);
		for (const listener of runnerListeners) {
			node.on("unhandledRejection", listener);
		}
	}
	return run;
}
