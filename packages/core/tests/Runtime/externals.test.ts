import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IExternalAnswer, IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { external } from "../../src/Reads/external";
import { select } from "../../src/Reads/select";
import { createActivityLog, type IActivityLogEntry } from "../../src/Runtime/createActivityLog";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { createSnapshot, restoreRuntime } from "../../src/Snapshot";
import * as reactive from "../reactive";

declare module "../../src/Registries/IExternalRegistry" {
	interface IExternalRegistry {
		"test/Count": number;
		"test/Box": {
			N: number;
			Note?: string | undefined;
		};
		"test/Any": unknown;
		"test/Secret": {
			Token: string;
		};
	}
}

interface IRoot {
	$Id: string;
	Title: string;
}

interface IAliasRoot {
	$Id: string;
	Items: {
		N: number;
	}[];
	First?: {
		N: number;
	};
}

function build() {
	const runtime = createRuntime<IRoot>(
		{
			$Id: "root",
			Title: ""
		},
		{
			onError: () => {}
		}
	) as IRuntimeInternal<IRoot>;
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	return {
		runtime,
		records,
		diags,
		codes: () => diags.map((event) => event.code),
		steps: () =>
			records.filter(
				(
					record
				): record is Extract<
					IRecord,
					{
						Kind: "step";
					}
				> => record.Kind === "step"
			)
	};
}

function source<T>(initial: T) {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		listeners,
		read: () => value,
		set(next: T) {
			value = next;
			for (const listener of [
				...listeners
			]) {
				listener();
			}
		},
		subscribe(changed: () => void) {
			listeners.add(changed);
			return () => {
				listeners.delete(changed);
			};
		}
	};
}

function* count(): ISelectorGenerator<number | undefined> {
	return yield* external("test/Count");
}

function* box(): ISelectorGenerator<
	| {
			N: number;
	  }
	| undefined
> {
	return yield* external("test/Box");
}

function watching<R>(read: () => R): {
	seen: R[];
	dispose: () => void;
} {
	const seen: R[] = [];
	const dispose = reactive.root((d) => {
		reactive.effect(() => {
			seen.push(read());
		});
		return d;
	});
	return {
		seen,
		dispose
	};
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("external: a selector's read", () => {
	it("re-runs its readers on a change, with no tree write", () => {
		const h = build();
		const counter = source(1);
		h.runtime.provideExternal("test/Count", counter);
		const view = watching(() => h.runtime.runSelector(count, () => h.runtime.state));
		counter.set(2);
		counter.set(3);
		expect(view.seen).toEqual([
			1,
			2,
			3
		]);
		expect(h.records).toEqual([]);
		view.dispose();
	});

	it("answers the cached value uncopied", () => {
		const h = build();
		const value = {
			N: 1
		};
		h.runtime.provideExternal("test/Box", {
			read: () => value
		});
		expect(h.runtime.runSelector(box, () => h.runtime.state)).toBe(value);
		expect(Object.isFrozen(value)).toBe(false);
	});

	it("reads undefined before the key is provided, says so once, and re-runs when it is", () => {
		const h = build();
		const view = watching(() => h.runtime.runSelector(count, () => h.runtime.state));
		h.runtime.processSelector(count, () => h.runtime.state);
		expect(h.codes()).toEqual([
			"external/unprovided"
		]);
		expect(h.diags[0]?.data).toEqual({
			key: "test/Count"
		});
		h.runtime.provideExternal("test/Count", {
			read: () => 7
		});
		expect(view.seen).toEqual([
			undefined,
			7
		]);
		expect(h.codes()).toEqual([
			"external/unprovided"
		]);
		view.dispose();
	});

	it("re-runs nothing for a value equals calls the same, Object.is by default", () => {
		const h = build();
		const counter = source(1);
		h.runtime.provideExternal("test/Count", counter);
		const boxes = source({
			N: 1
		});
		h.runtime.provideExternal("test/Box", {
			...boxes,
			equals: (a, b) => a.N === b.N
		});
		const counts = watching(() => h.runtime.runSelector(count, () => h.runtime.state));
		const boxed = watching(() => h.runtime.runSelector(box, () => h.runtime.state)?.N);
		counter.set(1);
		boxes.set({
			N: 1
		});
		expect(counts.seen).toEqual([
			1
		]);
		expect(boxed.seen).toEqual([
			1
		]);
		boxes.set({
			N: 2
		});
		expect(boxed.seen).toEqual([
			1,
			2
		]);
		counts.dispose();
		boxed.dispose();
	});

	it("gives every reader in one flush the same value", () => {
		const h = build();
		let calls = 0;
		const handle = h.runtime.provideExternal("test/Box", {
			read: () => ({
				N: ++calls
			})
		});
		const seen: unknown[] = [];
		const dispose = reactive.root((d) => {
			reactive.effect(() => seen.push(h.runtime.processSelector(box, () => h.runtime.state)));
			reactive.effect(() => seen.push(h.runtime.processSelector(box, () => h.runtime.state)));
			return d;
		});
		handle.changed();
		expect(calls).toBe(2);
		expect(seen).toHaveLength(4);
		expect(seen[2]).toBe(seen[3]);
		dispose();
	});

	it("records nothing for a view's selector, beside an action that selects the same one", async () => {
		const h = build();
		const counter = source(1);
		h.runtime.provideExternal("test/Count", counter);
		const view = watching(() => h.runtime.runSelector(count, () => h.runtime.state));
		function* reads(): IActionGenerator<unknown> {
			return yield* select(count);
		}
		await h.runtime.dispatch(reads, "root");
		counter.set(2);
		expect(view.seen).toEqual([
			1,
			2
		]);
		expect(h.steps().map((step) => step.ExternalAnswers)).toEqual([
			[
				{
					Key: "test/Count",
					Value: 1
				}
			]
		]);
		view.dispose();
	});
	it("calls a class instance's read, subscribe and equals with the instance as this", () => {
		class Boxes {
			private value = {
				N: 1
			};
			private readonly listeners = new Set<() => void>();
			read() {
				return this.value;
			}
			subscribe(changed: () => void) {
				this.listeners.add(changed);
				return () => {
					this.listeners.delete(changed);
				};
			}
			equals(
				a: {
					N: number;
				},
				b: {
					N: number;
				}
			) {
				return this.same(a, b);
			}
			set(n: number) {
				this.value = {
					N: n
				};
				for (const listener of this.listeners) {
					listener();
				}
			}
			private same(
				a: {
					N: number;
				},
				b: {
					N: number;
				}
			) {
				return a.N === b.N;
			}
		}
		const h = build();
		const boxes = new Boxes();
		h.runtime.provideExternal("test/Box", boxes);
		const view = watching(() => h.runtime.runSelector(box, () => h.runtime.state)?.N);
		boxes.set(1);
		boxes.set(2);
		expect(view.seen).toEqual([
			1,
			2
		]);
		view.dispose();
	});

	it("subscribes a selector memo to nothing a diag listener reads", () => {
		const h = build();
		const [heard, setHeard] = reactive.signal(0);
		h.runtime.on("diag", () => {
			heard();
		});
		let runs = 0;
		function* counted(): ISelectorGenerator<number | undefined> {
			runs++;
			return yield* external("test/Count");
		}
		const view = watching(() => h.runtime.runSelector(counted, () => h.runtime.state));
		expect(h.codes()).toEqual([
			"external/unprovided"
		]);
		setHeard(1);
		expect(runs).toBe(1);
		view.dispose();
	});

	it("subscribes a scope that provides to nothing the plain-data check reads", () => {
		const h = build();
		const [n, setN] = reactive.signal(1);
		let runs = 0;
		const dispose = reactive.root((d) => {
			reactive.effect(() => {
				runs++;
				h.runtime.provideExternal("test/Box", {
					read: () => ({
						get N() {
							return n();
						}
					})
				});
			});
			return d;
		});
		setN(2);
		expect(runs).toBe(1);
		dispose();
	});
});

describe("external: an action's read", () => {
	it("is a frozen copy, the same object its step record holds, and lands a step with no changes", async () => {
		const h = build();
		const value = {
			N: 1
		};
		h.runtime.provideExternal("test/Box", {
			read: () => value
		});
		function* reads(): IActionGenerator<unknown> {
			return yield* external("test/Box");
		}
		const got = await h.runtime.dispatch(reads, "root");
		expect(got).toEqual(value);
		expect(got).not.toBe(value);
		expect(Object.isFrozen(got)).toBe(true);
		expect(Object.isFrozen(value)).toBe(false);
		const [step] = h.steps();
		expect(step?.Changes).toEqual([]);
		expect(step?.ExternalAnswers).toEqual([
			{
				Key: "test/Box",
				Value: value
			}
		]);
		expect(step?.ExternalAnswers?.[0]?.Value).toBe(got);
	});

	it("records a nested select's reads on the action's step, in read order, and hands the select the copy", async () => {
		const h = build();
		h.runtime.provideExternal("test/Count", {
			read: () => 2
		});
		const value = {
			N: 3
		};
		h.runtime.provideExternal("test/Box", {
			read: () => value
		});
		let inSelect: unknown;
		function* both(): ISelectorGenerator<number> {
			const b = yield* external("test/Box");
			inSelect = b;
			return ((yield* external("test/Count")) ?? 0) + (b?.N ?? 0);
		}
		function* reads(draft: IRoot): IActionGenerator {
			draft.Title = String(yield* select(both));
		}
		await h.runtime.dispatch(reads, "root");
		expect(inSelect).not.toBe(value);
		expect(Object.isFrozen(inSelect)).toBe(true);
		expect(h.runtime.state.Title).toBe("5");
		const answers = h.steps().flatMap((step) => step.ExternalAnswers ?? []);
		expect(answers).toEqual([
			{
				Key: "test/Box",
				Value: value
			},
			{
				Key: "test/Count",
				Value: 2
			}
		]);
		expect(answers[0]?.Value).toBe(inSelect);
	});

	it("records what a selected guard read before it threw, on the step the throw resumes", async () => {
		const h = build();
		h.runtime.provideExternal("test/Count", {
			read: () => 0
		});
		function* guard(): ISelectorGenerator<true> {
			if ((yield* external("test/Count")) === 0) {
				throw new Error("empty");
			}
			return true;
		}
		const refused = await h.runtime.dispatch(function* guarded(_draft: IRoot): IActionGenerator<string> {
			try {
				yield* select(guard);
				return "ran";
			} catch (error) {
				return (error as Error).message;
			}
		}, "root");
		expect(refused).toBe("empty");
		expect(h.steps()).toEqual([
			expect.objectContaining({
				Changes: [],
				ExternalAnswers: [
					{
						Key: "test/Count",
						Value: 0
					}
				]
			})
		]);
	});

	it("records an unprovided key's read as the key alone", async () => {
		const h = build();
		function* reads(): IActionGenerator<unknown> {
			return yield* external("test/Count");
		}
		expect(await h.runtime.dispatch(reads, "root")).toBeUndefined();
		expect(h.steps()[0]?.ExternalAnswers).toEqual([
			{
				Key: "test/Count"
			}
		]);
		expect(h.codes()).toContain("external/unprovided");
	});

	it("records the copy the action got, where a -0 is 0", async () => {
		const h = build();
		let value: unknown = {
			N: 1,
			Note: undefined
		};
		const handle = h.runtime.provideExternal("test/Any", {
			read: () => value
		});
		function* reads(): IActionGenerator<unknown> {
			return yield* external("test/Any");
		}
		await h.runtime.dispatch(reads, "root");
		for (const next of [
			-0,
			{
				N: -0
			},
			undefined
		]) {
			value = next;
			handle.changed();
			await h.runtime.dispatch(reads, "root");
		}
		const answers = h.steps().map((step) => step.ExternalAnswers?.[0]);
		expect(answers).toEqual<IExternalAnswer[]>([
			{
				Key: "test/Any",
				Value: {
					N: 1
				}
			},
			{
				Key: "test/Any",
				Value: 0
			},
			{
				Key: "test/Any",
				Value: {
					N: 0
				}
			},
			{
				Key: "test/Any"
			}
		]);
		expect(Object.keys(answers[0]?.Value as object)).toEqual([
			"N"
		]);
		expect(Object.is(answers[1]?.Value, 0)).toBe(true);
		expect(
			Object.is(
				(
					answers[2]?.Value as {
						N: number;
					}
				).N,
				0
			)
		).toBe(true);
		expect(answers[3]).not.toHaveProperty("Value");
	});

	it("records a redacted key's read without its value, and still hands the action its copy", async () => {
		const h = build();
		h.runtime.provideExternal("test/Secret", {
			read: () => ({
				Token: "t0k3n"
			}),
			redact: true
		});
		function* reads(): IActionGenerator<unknown> {
			return yield* external("test/Secret");
		}
		const got = await h.runtime.dispatch(reads, "root");
		expect(got).toEqual({
			Token: "t0k3n"
		});
		expect(Object.isFrozen(got)).toBe(true);
		expect(h.steps()[0]?.ExternalAnswers).toEqual([
			{
				Key: "test/Secret",
				Redacted: true
			}
		]);
	});

	it("copies the same with no tap attached", async () => {
		const runtime = createRuntime<IRoot>({
			$Id: "root",
			Title: ""
		});
		const value = {
			N: 1
		};
		runtime.provideExternal("test/Box", {
			read: () => value
		});
		function* reads(): IActionGenerator<unknown> {
			return yield* external("test/Box");
		}
		const got = await runtime.dispatch(reads, "root");
		expect(got).not.toBe(value);
		expect(Object.isFrozen(got)).toBe(true);
	});

	it("carries the answers onto a trace's step entry", async () => {
		const h = build();
		h.runtime.provideExternal("test/Count", {
			read: () => 4
		});
		const traces: unknown[] = [];
		createTraceAggregator(h.runtime, (trace) => traces.push(trace));
		function* reads(): IActionGenerator<unknown> {
			return yield* external("test/Count");
		}
		await h.runtime.dispatch(reads, "root");
		expect(traces).toMatchObject([
			{
				entries: [
					{
						type: "step",
						externalAnswers: [
							{
								Key: "test/Count",
								Value: 4
							}
						]
					}
				]
			}
		]);
	});
	it("keeps the answers of a slice refused at its yield on a record of their own, and none on the retry", async () => {
		const runtime = createRuntime<IAliasRoot>({
			$Id: "root",
			Items: [
				{
					N: 1
				}
			]
		});
		const records: IRecord[] = [];
		runtime.on("record", (record) => records.push(record));
		runtime.provideExternal("test/Count", {
			read: () => 3
		});
		function* aliases(draft: IAliasRoot): IActionGenerator<string> {
			yield* external("test/Count");
			draft.First = draft.Items[0];
			try {
				yield* external("test/Count");
			} catch (error) {
				return (error as Error).name;
			}
			return "kept";
		}
		expect(await runtime.dispatch(aliases, "root")).toBe("StateAliasError");
		expect(runtime.state.First).toBeUndefined();
		expect(records.filter((record) => record.Kind === "step")).toEqual([
			expect.objectContaining({
				Changes: [],
				ExternalAnswers: [
					{
						Key: "test/Count",
						Value: 3
					}
				]
			})
		]);
	});

	it("names the key in action/large-read-copy, whose advice is a narrower key", async () => {
		const h = build();
		const rows = Array.from(
			{
				length: 10_001
			},
			(_, i) => ({
				I: i
			})
		);
		h.runtime.provideExternal("test/Any", {
			read: () => rows
		});
		function* size(): ISelectorGenerator<number> {
			return ((yield* external("test/Any")) as unknown[]).length;
		}
		function* reads(): IActionGenerator<number> {
			return yield* select(size);
		}
		expect(await h.runtime.dispatch(reads, "root")).toBe(10_001);
		const copied = h.diags.filter((event) => event.code === "action/large-read-copy");
		expect(copied).toHaveLength(1);
		expect(copied[0]?.data).toEqual({
			actionName: "reads",
			type: "external",
			key: "test/Any",
			copied: 10_002
		});
		expect(copied[0]?.message).toContain('external("test/Any")');
		expect(copied[0]?.message).toContain("narrower key");
		expect(copied[0]?.message).not.toContain("out of state");
	});
});

describe("external: plain data", () => {
	it("refuses a non-plain first value at provide, and provides nothing", () => {
		const h = build();
		expect(() =>
			h.runtime.provideExternal("test/Any", {
				read: () => new Date(0)
			})
		).toThrow(NonPlainDataError);
		expect(() =>
			h.runtime.provideExternal("test/Any", {
				read: () => Number.NaN
			})
		).toThrow(NonPlainDataError);
		expect(
			h.runtime.processSelector(
				() => external("test/Any"),
				() => h.runtime.state
			)
		).toBeUndefined();
		expect(h.codes()).toEqual([
			"external/unprovided"
		]);
	});

	it("refuses a non-plain changed value from changed(), keeping the value before it", () => {
		const h = build();
		let value: unknown = 1;
		const handle = h.runtime.provideExternal("test/Any", {
			read: () => value
		});
		value = new Map();
		expect(() => handle.changed()).toThrow(NonPlainDataError);
		expect(
			h.runtime.processSelector(
				() => external("test/Any"),
				() => h.runtime.state
			)
		).toBe(1);
	});

	it("skips the check on the table's own provide for a value plain by construction, which the activity log uses", () => {
		const h = build();
		const handle = h.runtime.get("runtime/externals").provide(
			"test/Any",
			{
				read: () => new Date(0)
			},
			{
				plainByConstruction: true
			}
		);
		expect(() => handle.changed()).not.toThrow();
		expect(
			h.runtime.processSelector(
				() => external("test/Any"),
				() => h.runtime.state
			)
		).toBeInstanceOf(Date);
	});

	it("does not freeze the provider's value", () => {
		const h = build();
		const value = {
			N: 1
		};
		h.runtime.provideExternal("test/Box", {
			read: () => value
		});
		expect(Object.isFrozen(value)).toBe(false);
	});
});

describe("external: replacing a provider", () => {
	it("stops the first subscription, kills its handle, warns, and re-runs readers on the new value", () => {
		const h = build();
		const first = source(1);
		const firstHandle = h.runtime.provideExternal("test/Count", first);
		const view = watching(() => h.runtime.runSelector(count, () => h.runtime.state));
		const second = source(10);
		h.runtime.provideExternal("test/Count", second);
		expect(first.listeners.size).toBe(0);
		expect(second.listeners.size).toBe(1);
		expect(h.codes()).toEqual([
			"external/replaced"
		]);
		expect(view.seen).toEqual([
			1,
			10
		]);
		firstHandle.changed();
		second.set(11);
		expect(view.seen).toEqual([
			1,
			10,
			11
		]);
		view.dispose();
	});

	it("keeps the first provider when the second's value is refused", () => {
		const h = build();
		const first = source<unknown>(1);
		h.runtime.provideExternal("test/Any", first);
		expect(() =>
			h.runtime.provideExternal("test/Any", {
				read: () => new Set()
			})
		).toThrow(NonPlainDataError);
		expect(first.listeners.size).toBe(1);
		expect(h.codes()).toEqual([]);
	});
});

describe("external: dispose", () => {
	it("stops each subscription in provide order, reports a throwing stop, and ignores changed after", () => {
		const h = build();
		const stopped: string[] = [];
		const handle = h.runtime.provideExternal("test/Count", {
			read: () => 1,
			subscribe: () => () => {
				stopped.push("count");
			}
		});
		h.runtime.provideExternal("test/Box", {
			read: () => ({
				N: 1
			}),
			subscribe: () => () => {
				stopped.push("box");
				throw new Error("stop threw");
			}
		});
		h.runtime.provideExternal("test/Any", {
			read: () => 1,
			subscribe: () => () => {
				stopped.push("any");
			}
		});
		h.runtime.dispose();
		expect(stopped).toEqual([
			"count",
			"box",
			"any"
		]);
		expect(h.codes()).toEqual([
			"runtime/callback-threw"
		]);
		expect(h.diags[0]?.data).toMatchObject({
			key: "test/Box"
		});
		expect(() => handle.changed()).not.toThrow();
	});

	it("refuses a provide on a disposed runtime", () => {
		const h = build();
		h.runtime.dispose();
		let subscribed = false;
		expect(() =>
			h.runtime.provideExternal("test/Count", {
				read: () => 1,
				subscribe: () => {
					subscribed = true;
					return () => {};
				}
			})
		).toThrow(/disposed/);
		expect(subscribed).toBe(false);
	});
});

describe("external: a change from inside a computation", () => {
	it("applies at once from an effect, whose own read after it gets the new value", () => {
		const h = build();
		let value = 1;
		const handle = h.runtime.provideExternal("test/Count", {
			read: () => value
		});
		const view = watching(() => h.runtime.runSelector(count, () => h.runtime.state));
		const [mirrored, setMirrored] = reactive.signal(1);
		let inEffect: number | undefined;
		const dispose = reactive.root((d) => {
			reactive.effect(() => {
				value = mirrored();
				handle.changed();
				inEffect = h.runtime.processSelector(count, () => h.runtime.state);
			});
			return d;
		});
		setMirrored(2);
		expect(inEffect).toBe(2);
		expect(view.seen).toEqual([
			1,
			2
		]);
		dispose();
		view.dispose();
	});

	it("runs an effect that read the key once more after its run, in the same flush", () => {
		const h = build();
		let value = 1;
		const handle = h.runtime.provideExternal("test/Count", {
			read: () => value
		});
		const [go, setGo] = reactive.signal(false);
		const seen: (number | undefined)[] = [];
		const dispose = reactive.root((d) => {
			reactive.effect(() => {
				const n = h.runtime.runSelector(count, () => h.runtime.state);
				seen.push(n);
				if (go() && n === 1) {
					value = 2;
					handle.changed();
					seen.push(h.runtime.runSelector(count, () => h.runtime.state));
				}
			});
			return d;
		});
		setGo(true);
		expect(seen).toEqual([
			1,
			1,
			2,
			2
		]);
		dispose();
	});

	it("applies at once from an untracked stretch inside an effect", () => {
		const h = build();
		let value = 1;
		const handle = h.runtime.provideExternal("test/Count", {
			read: () => value
		});
		let inEffect: number | undefined;
		const dispose = reactive.root((d) => {
			reactive.effect(() => {
				reactive.untrack(() => {
					value = 2;
					handle.changed();
				});
				inEffect = h.runtime.processSelector(count, () => h.runtime.state);
			});
			return d;
		});
		expect(inEffect).toBe(2);
		dispose();
	});

	it("applies at once from a memo, whose own read after it gets the new value", () => {
		const h = build();
		let value = 1;
		const handle = h.runtime.provideExternal("test/Count", {
			read: () => value
		});
		const view = watching(() => h.runtime.runSelector(count, () => h.runtime.state));
		let inMemo: number | undefined;
		const dispose = reactive.root((d) => {
			const memo = reactive.memo(() => {
				value = 5;
				handle.changed();
				inMemo = h.runtime.processSelector(count, () => h.runtime.state);
				return value;
			});
			memo();
			return d;
		});
		expect(inMemo).toBe(5);
		expect(view.seen).toEqual([
			1,
			5
		]);
		dispose();
		view.dispose();
	});

	it("applies at once from a selector's memo, whose own read after it gets the new value", () => {
		const h = build();
		let value = 1;
		const handle = h.runtime.provideExternal("test/Count", {
			read: () => value
		});
		const view = watching(() => h.runtime.runSelector(count, () => h.runtime.state));
		function* bumps(draft: IRoot): ISelectorGenerator<string> {
			value = 3;
			handle.changed();
			return `${draft.Title}${yield* external("test/Count")}`;
		}
		expect(h.runtime.runSelector(bumps, () => h.runtime.state)).toBe("3");
		expect(view.seen).toEqual([
			1,
			3
		]);
		view.dispose();
	});

	it("stops a selector that changes its key forever, throwing the runaway from the write, so the dispatch that set it off rejects", async () => {
		const errors: unknown[] = [];
		const runtime = createRuntime<IRoot>(
			{
				$Id: "root",
				Title: ""
			},
			{
				onError: (error) => errors.push(error)
			}
		) as IRuntimeInternal<IRoot>;
		const records: IRecord[] = [];
		runtime.on("record", (record) => records.push(record));
		let value = 0;
		const handle = runtime.provideExternal("test/Count", {
			read: () => value
		});
		function* spins(draft: IRoot): ISelectorGenerator<number | undefined> {
			const n = yield* external("test/Count");
			if (draft.Title === "go") {
				value = (n ?? 0) + 1;
				handle.changed();
			}
			return n;
		}
		const view = watching(() => runtime.runSelector(spins, () => runtime.state));
		function* go(draft: IRoot): IActionGenerator {
			draft.Title = "go";
		}
		await expect(runtime.dispatch(go, "root")).rejects.toThrow(/Potential infinite loop/);
		expect(runtime.state.Title).toBe("go");
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toMatch(/Potential infinite loop/);
		expect(records.some((record) => record.Kind === "step")).toBe(true);
		const end = records.find((record) => record.Kind === "action:end") as Record<string, unknown>;
		expect(end.Status).toBe("errored");
		function* stop(draft: IRoot): IActionGenerator {
			draft.Title = "stop";
		}
		await runtime.dispatch(stop, "root");
		value = 0;
		handle.changed();
		expect(view.seen.at(-1)).toBe(0);
		view.dispose();
	});
});

describe("external: restore", () => {
	it("saves nothing of an external value, and the restored runtime reads what setup provides", async () => {
		const h = build();
		h.runtime.provideExternal("test/Count", {
			read: () => 1
		});
		const json = createSnapshot(h.runtime);
		expect(json).not.toContain("test/Count");
		const { runtime } = await restoreRuntime<IRoot>(json, {
			rootId: "root",
			options: {},
			setup: (built) => {
				built.provideExternal("test/Count", {
					read: () => 2
				});
			}
		});
		expect(runtime.processSelector(count, () => runtime.state)).toBe(2);
		expect(h.runtime.processSelector(count, () => h.runtime.state)).toBe(1);
	});
});

describe("createActivityLog", () => {
	function* noop(): IActionGenerator {}

	function* logged(): ISelectorGenerator<readonly IActivityLogEntry[]> {
		return (yield* external("ActivityLog")) ?? [];
	}

	it("keeps the lifecycle kinds newest first, no step, and re-runs its readers per append", async () => {
		const h = build();
		createActivityLog(h.runtime);
		const view = watching(() => h.runtime.runSelector(logged, () => h.runtime.state).length);
		function* write(draft: IRoot): IActionGenerator {
			draft.Title = "x";
		}
		await h.runtime.dispatch(write, "root");
		const log = h.runtime.processSelector(logged, () => h.runtime.state);
		expect(log.map((entry) => entry.Kind)).toEqual([
			"action:end",
			"action:start"
		]);
		expect(log.map((entry) => entry.Seq)).toEqual([
			2,
			1
		]);
		expect(Object.isFrozen(log)).toBe(true);
		expect(view.seen).toEqual([
			0,
			1,
			2
		]);
		view.dispose();
	});

	it("keeps at most cap entries", async () => {
		const h = build();
		createActivityLog(h.runtime, {
			cap: 3
		});
		for (let i = 0; i < 4; i++) {
			await h.runtime.dispatch(noop, "root");
		}
		const log = h.runtime.processSelector(logged, () => h.runtime.state);
		expect(log.map((entry) => entry.Seq)).toEqual([
			8,
			7,
			6
		]);
	});

	it("leaves a branch:end's error out", async () => {
		const h = build();
		createActivityLog(h.runtime);
		function* fails(): IActionGenerator {
			throw new Error("secret");
		}
		function* runs(): IActionGenerator {
			yield* parallel(fails());
		}
		await h.runtime.dispatch(runs, "root").catch(() => {});
		const log = h.runtime.processSelector(logged, () => h.runtime.state);
		const ended = log.find((entry) => entry.Kind === "branch:end");
		expect(ended?.Data).toMatchObject({
			Status: "errored"
		});
		expect(ended?.Data).not.toHaveProperty("Error");
	});

	it("gives an undefined argument as null, so an action can read the log", async () => {
		const h = build();
		createActivityLog(h.runtime);
		function* takes(_draft: IRoot, _first: number | undefined, _second: number): IActionGenerator {}
		await h.runtime.dispatch(takes, "root", undefined, 2);
		function* reads(): IActionGenerator<unknown> {
			return yield* select(logged);
		}
		const log = (await h.runtime.dispatch(reads, "root")) as readonly {
			Kind: string;
			Data: {
				Label?: string;
				Args?: unknown[];
			};
		}[];
		const started = log.find((entry) => entry.Kind === "action:start" && entry.Data.Label === "takes");
		expect(started?.Data.Args).toEqual([
			null,
			2
		]);
		expect(h.codes()).toEqual([]);
	});

	it("stops tapping on its stop, keeping the last value", async () => {
		const h = build();
		const stop = createActivityLog(h.runtime);
		await h.runtime.dispatch(noop, "root");
		stop();
		await h.runtime.dispatch(noop, "root");
		const log = h.runtime.processSelector(logged, () => h.runtime.state);
		expect(log).toHaveLength(2);
		expect(h.codes()).toEqual([]);
	});

	it("is replaced by a second log on the same runtime, with external/replaced, and the key reads the second", async () => {
		const h = build();
		createActivityLog(h.runtime);
		await h.runtime.dispatch(noop, "root");
		createActivityLog(h.runtime);
		expect(h.codes()).toEqual([
			"external/replaced"
		]);
		await h.runtime.dispatch(noop, "root");
		const log = h.runtime.processSelector(logged, () => h.runtime.state);
		expect(log.map((entry) => entry.Seq)).toEqual([
			2,
			1
		]);
	});

	it("stops tapping when the runtime is disposed", () => {
		const runtime = createRuntime({
			$Id: "root"
		}) as IRuntimeInternal<object>;
		const journal = runtime.get("runtime/journal");
		createActivityLog(runtime);
		expect(journal.enabled).toBe(true);
		runtime.dispose();
		expect(journal.enabled).toBe(false);
	});
});
