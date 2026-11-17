import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import type { IActionContext } from "../../src/Types/IActionContext";
import type { IEffect } from "../../src/Types/IEffect";
import type { IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineEffect, implementation } from "../../src/Effects/defineEffect";
import { createDiagService } from "../../src/Runtime/createDiagService";
import { createEffectRegistry } from "../../src/Runtime/createEffectRegistry";
import { createJournal } from "../../src/Runtime/createJournal";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { declarationOf, SyncEffectPromiseError, SyncEffectWorkError, settlesSync } from "../../src/Runtime/effectDeclarations";
import { createProcessAction, type IRuntimeStoreReader } from "../../src/Runtime/processAction";
import { frameWrite, rootSetState } from "../testHelpers";

interface IWorld {
	$Id: string;
	Count: number;
	Log: string[];
	Note?: string;
}

const world = (): IWorld => ({
	$Id: "root",
	Count: 0,
	Log: [],
	Note: "x"
});

interface IStampEffect extends IEffect {
	Type: "sync/stamp";
}
const stamp = defineEffect<IStampEffect, number>("sync/stamp", {
	settles: "sync"
});

interface IOtherStampEffect extends IEffect {
	Type: "sync/otherStamp";
}
const otherStamp = defineEffect<IOtherStampEffect, number>("sync/otherStamp", {
	settles: "sync"
});

interface ISlowEffect extends IEffect {
	Type: "sync/slow";
}
const slow = defineEffect<ISlowEffect, number>("sync/slow");

function build() {
	const runtime = createRuntime<IWorld>(world(), {});
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (diag) => diags.push(diag));
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record as IRecord));
	return {
		runtime,
		diags,
		records
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a sync yield", () => {
	it("settles without an event-loop turn, where an effect that may suspend does not", () => {
		const { runtime } = build();
		runtime.registerImplementation(implementation(stamp, () => 7));
		runtime.registerImplementation(implementation(slow, () => 9));

		function* syncThenWrite(draft: IWorld): IActionGenerator {
			draft.Count = yield* stamp();
			draft.Count += yield* stamp();
		}
		function* slowThenWrite(draft: IWorld): IActionGenerator {
			draft.Note = String(yield* slow());
		}

		const syncRun = runtime.dispatch(syncThenWrite, "root");
		expect(runtime.state.Count).toBe(14);
		const slowRun = runtime.dispatch(slowThenWrite, "root");
		expect(runtime.state.Note).toBe("x");
		return Promise.all([
			syncRun,
			slowRun
		]).then(() => {
			expect(runtime.state.Note).toBe("9");
		});
	});

	it("is still recorded and keeps journal order", async () => {
		const { runtime, records } = build();
		runtime.registerImplementation(implementation(stamp, () => 3));

		function* act(draft: IWorld): IActionGenerator {
			draft.Count = yield* stamp();
		}
		await runtime.dispatch(act, "root");

		const kinds = records.filter((r) => r.Kind === "effect" || r.Kind === "response" || r.Kind === "step").map((r) => r.Kind);
		expect(kinds).toEqual([
			"effect",
			"response",
			"step"
		]);
		expect(records.find((r) => r.Kind === "response")).toMatchObject({
			Value: 3
		});
	});
});

describe("a thenable from a sync dispatch", () => {
	it("throws the named error at the yield, and diags once per type", async () => {
		const { runtime, diags } = build();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		runtime.registerImplementation("sync/stamp", async () => 1);
		runtime.registerImplementation("sync/otherStamp", async () => 1);

		const caught: unknown[] = [];
		function* catches(draft: IWorld): IActionGenerator {
			try {
				yield* stamp();
			} catch (error) {
				caught.push(error);
				draft.Log.push("caught");
			}
		}
		function* catchesOther(draft: IWorld): IActionGenerator {
			try {
				yield* otherStamp();
			} catch {
				draft.Log.push("caught other");
			}
		}
		await runtime.dispatch(catches, "root");
		await runtime.dispatch(catches, "root");
		await runtime.dispatch(catchesOther, "root");

		expect(caught).toHaveLength(2);
		expect(caught[0]).toBeInstanceOf(SyncEffectPromiseError);
		expect((caught[0] as SyncEffectPromiseError).effectType).toBe("sync/stamp");
		expect((caught[0] as Error).message).toContain("its implementation returned a promise");
		expect(diags.filter((d) => d.code === "effect/sync-returned-promise").map((d) => d.data?.effectType)).toEqual([
			"sync/stamp",
			"sync/otherStamp"
		]);
		expect(runtime.state.Log).toEqual([
			"caught",
			"caught",
			"caught other"
		]);
	});

	it("reports the rejection reason in a follow-up diag, with no unhandled rejection", async () => {
		const { runtime, diags } = build();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const reason = new Error("the stub's real failure");
		runtime.registerImplementation("sync/stamp", () => Promise.reject(reason));

		function* act(): IActionGenerator {
			yield* stamp();
		}
		await expect(runtime.dispatch(act, "root")).rejects.toBeInstanceOf(SyncEffectPromiseError);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const followUp = diags.find((d) => d.code === "effect/sync-promise-rejected");
		expect(followUp?.data?.cause).toBe(reason);
		expect(followUp?.data?.effectType).toBe("sync/stamp");
	});

	it("reports every rejection, so a later, different reason is not hidden", async () => {
		const { runtime, diags } = build();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const reasons = [
			new Error("first"),
			new Error("second")
		];
		let call = 0;
		runtime.registerImplementation("sync/stamp", () => Promise.reject(reasons[call++]));

		function* act(): IActionGenerator {
			yield* stamp();
		}
		await expect(runtime.dispatch(act, "root")).rejects.toBeInstanceOf(SyncEffectPromiseError);
		await expect(runtime.dispatch(act, "root")).rejects.toBeInstanceOf(SyncEffectPromiseError);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(diags.filter((d) => d.code === "effect/sync-returned-promise")).toHaveLength(1);
		expect(diags.filter((d) => d.code === "effect/sync-promise-rejected").map((d) => d.data?.cause)).toEqual(reasons);
	});

	interface ISecretStampEffect extends IEffect {
		Type: "sync/secretStamp";
	}
	const secretStamp = defineEffect<ISecretStampEffect, number>("sync/secretStamp", {
		settles: "sync",
		redact: true
	});

	it("withholds the rejection reason of a redacted type from the follow-up diag and the console", async () => {
		const { runtime, diags } = build();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		runtime.registerImplementation("sync/secretStamp", () => Promise.reject(new Error("Bearer rejected-secret")));

		function* act(): IActionGenerator {
			yield* secretStamp();
		}
		await expect(runtime.dispatch(act, "root")).rejects.toBeInstanceOf(SyncEffectPromiseError);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const followUp = diags.find((d) => d.code === "effect/sync-promise-rejected");
		expect(followUp?.data).toEqual({
			effectType: "sync/secretStamp"
		});
		const printed = [
			...warn.mock.calls,
			...error.mock.calls
		].flat();
		expect(printed.some((arg) => arg instanceof Error && arg.message.includes("secret"))).toBe(false);
		expect(JSON.stringify(printed)).not.toMatch(/rejected-secret/);
	});

	it("diags even when the signal aborted during the dispatch and silent cancel swallows the throw", async () => {
		const emitted: IRuntimeEventOf<"diag">[] = [];
		const diag = createDiagService((event) => emitted.push(event));
		const effects = createEffectRegistry();
		const reader = ((key: string) => {
			if (key === "runtime/diag") {
				return diag;
			}
			if (key === "runtime/effects") {
				return effects;
			}
			throw new Error(`no ${key}`);
		}) as IRuntimeStoreReader;
		const controller = new AbortController();
		const loop = createProcessAction({
			effectProcessor: () => {
				controller.abort();
				return Promise.resolve(1);
			},
			runtimeStoreReader: reader,
			journal: createJournal()
		});
		const state = {
			Count: 0
		};
		function* act(draft: typeof state): IActionGenerator {
			draft.Count = yield* stamp();
		}
		const result = await loop.dispatchInternal(
			act,
			() => state,
			(fn: (s: typeof state) => void) => fn(state),
			() => "e",
			[],
			{
				signal: controller.signal
			}
		);
		expect(result).toBeUndefined();
		expect(state.Count).toBe(0);
		expect(emitted.map((d) => d.code)).toEqual([
			"effect/sync-returned-promise"
		]);
	});
});

describe("nothing inside a sync dispatch starts work or writes state", () => {
	function* noop(_draft: IWorld): IActionGenerator {}

	// Each attempt runs inside the implementation and is caught there; the
	// settlement must fail anyway.
	async function refusedFrom(attempt: (action: IActionContext, runtime: ReturnType<typeof build>["runtime"], draft: IWorld) => unknown) {
		const { runtime } = build();
		vi.spyOn(console, "error").mockImplementation(() => {});
		let held: IWorld | undefined;
		const thrown: unknown[] = [];
		runtime.registerImplementation("sync/stamp", (_effect: IEffect, action?: IActionContext) => {
			try {
				attempt(action!, runtime, held!);
			} catch (error) {
				thrown.push(error);
			}
			return 1;
		});
		let settledWith: unknown;
		function* act(draft: IWorld): IActionGenerator {
			held = draft;
			try {
				yield* stamp();
			} catch (error) {
				settledWith = error;
			}
		}
		const before = JSON.stringify(runtime.state);
		await runtime.dispatch(act, "root");
		return {
			thrown,
			settledWith,
			unchanged: JSON.stringify(runtime.state) === before
		};
	}

	const cases: [
		string,
		(action: IActionContext, runtime: ReturnType<typeof build>["runtime"], draft: IWorld) => unknown
	][] = [
		[
			"the core processAction",
			(action, runtime) =>
				action.processAction(
					noop,
					() => runtime.state,
					rootSetState(runtime),
					() => "root"
				)
		],
		[
			"runtime.dispatch captured in a closure",
			(_action, runtime) => runtime.dispatch(noop, "root")
		],
		[
			"a write through a held draft (the set trap)",
			(_action, _runtime, draft) => {
				draft.Count = 5;
			}
		],
		[
			"a delete through a held draft (the deleteProperty trap)",
			(_action, _runtime, draft) => {
				delete draft.Note;
			}
		],
		[
			"a write in an attributed frame",
			(_action, runtime) =>
				frameWrite(runtime, (s) => {
					s.Count = 5;
				})
		]
	];

	for (const [name, attempt] of cases) {
		it(`refuses ${name} at the call, and fails the settlement even though the implementation caught it`, async () => {
			const { thrown, settledWith, unchanged } = await refusedFrom(attempt);
			expect(thrown).toHaveLength(1);
			expect(thrown[0]).toBeInstanceOf(SyncEffectWorkError);
			expect((thrown[0] as Error).message).toMatch(/^\[treflex\] code tried to .+ and was refused\./);
			expect(settledWith).toBe(thrown[0]);
			expect(unchanged).toBe(true);
		});
	}

	for (const [shape, after] of [
		[
			"throws an error of its own",
			() => {
				throw new Error("the implementation's own");
			}
		],
		[
			"returns a thenable",
			() => Promise.resolve(1)
		]
	] as const) {
		it(`settles with the recorded refusal when the implementation catches it and ${shape}`, async () => {
			const { runtime } = build();
			vi.spyOn(console, "warn").mockImplementation(() => {});
			let refusal: unknown;
			runtime.registerImplementation("sync/stamp", () => {
				try {
					void runtime.dispatch(noop, "root");
				} catch (error) {
					refusal = error;
				}
				return after();
			});
			let settledWith: unknown;
			function* act(): IActionGenerator {
				try {
					yield* stamp();
				} catch (error) {
					settledWith = error;
				}
			}
			await runtime.dispatch(act, "root");
			expect(refusal).toBeInstanceOf(SyncEffectWorkError);
			expect(settledWith).toBe(refusal);
		});
	}

	it("refuses dispatchInternal, the funnel that bypasses the core processAction", async () => {
		const thrown: unknown[] = [];
		const loop = createProcessAction({
			effectProcessor: () => {
				try {
					void loop.dispatchInternal(
						function* () {},
						() => ({}),
						() => {},
						() => "other",
						[],
						{}
					);
				} catch (error) {
					thrown.push(error);
				}
				return 1;
			},
			runtimeStoreReader: ((key: string) => {
				if (key === "runtime/stateIdLookup") {
					return () => ({});
				}
				throw new Error(`no ${key}`);
			}) as IRuntimeStoreReader,
			onError: () => {},
			journal: createJournal()
		});
		const state = {};
		function* act(): IActionGenerator {
			yield* stamp();
		}
		await expect(
			loop.processAction(
				act as IAction<object>,
				() => state,
				() => {},
				() => "e"
			)
		).rejects.toBeInstanceOf(SyncEffectWorkError);
		expect(thrown[0]).toBeInstanceOf(SyncEffectWorkError);
	});

	it("leaves a dispatch with no action rejecting, rather than throwing at the call", async () => {
		const { runtime } = build();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const missing = undefined as unknown as IAction<IWorld>;
		let viaDispatch: Promise<unknown> | undefined;
		let viaProcessAction: Promise<unknown> | undefined;
		expect(() => {
			viaDispatch = runtime.dispatch(missing, "root");
			viaProcessAction = runtime.processAction(
				missing,
				() => runtime.state,
				rootSetState(runtime),
				() => "root"
			);
		}).not.toThrow();
		await expect(viaDispatch).rejects.toThrow();
		await expect(viaProcessAction).rejects.toThrow();
	});

	it("leaves the same work allowed in an implementation of a type that may suspend", async () => {
		const { runtime } = build();
		runtime.registerImplementation(
			implementation(slow, (_effect, action) => {
				void action!.processAction(
					noop,
					() => runtime.state,
					rootSetState(runtime),
					() => "root"
				);
				return 1;
			})
		);
		function* act(draft: IWorld): IActionGenerator {
			draft.Count = yield* slow();
		}
		await runtime.dispatch(act, "root");
		expect(runtime.state.Count).toBe(1);
	});
});

describe("redact", () => {
	interface IDeclaredSecretEffect extends IEffect {
		Type: "sync/declaredSecret";
		Token: string;
	}
	const declaredSecret = defineEffect<IDeclaredSecretEffect, string>("sync/declaredSecret", {
		redact: true
	});
	interface IPlainEffect extends IEffect {
		Type: "sync/plain";
		Token: string;
	}
	const plain = defineEffect<IPlainEffect, string>("sync/plain");

	it("comes from the declaration alone, so a hand-written effect is never redacted", async () => {
		const { runtime, records } = build();
		runtime.registerImplementation(implementation(declaredSecret, () => "SECRET-A"));
		runtime.registerImplementation(implementation(plain, () => "VISIBLE"));
		runtime.registerImplementation("sync/handWritten", () => "ALSO-VISIBLE");

		function* act(): IActionGenerator {
			yield* declaredSecret({
				Token: "SECRET-A"
			});
			yield* plain({
				Token: "VISIBLE"
			});
			yield {
				Type: "sync/handWritten"
			};
		}
		await runtime.dispatch(act, "root");

		const serialized = JSON.stringify(records);
		expect(serialized).not.toContain("SECRET-A");
		expect(serialized).toContain("VISIBLE");
		expect(serialized).toContain("ALSO-VISIBLE");
	});
});

describe("declaring", () => {
	it("is a no-op for the same options and a warned replacement for changed ones", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		defineEffect<
			{
				Type: "sync/hmr";
			},
			void
		>("sync/hmr");
		defineEffect<
			{
				Type: "sync/hmr";
			},
			void
		>("sync/hmr");
		expect(warn).not.toHaveBeenCalled();
		expect(settlesSync("sync/hmr")).toBe(false);

		defineEffect<
			{
				Type: "sync/hmr";
			},
			void
		>("sync/hmr", {
			settles: "sync"
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("rename");
		expect(settlesSync("sync/hmr")).toBe(true);
	});

	it("keeps the table, the open sync call and the module results on globalThis, so a second module copy shares them", async () => {
		const first = await import("../../src/Runtime/effectDeclarations");
		first.declare("sync/shared", {
			settles: "sync",
			redact: false
		});
		const module = {};
		first.recordCodeResult(module);
		const call = first.syncCall.enter("sync/shared");
		try {
			vi.resetModules();
			const second = await import("../../src/Runtime/effectDeclarations");
			expect(second).not.toBe(first);
			expect(second.settlesSync("sync/shared")).toBe(true);
			expect(second.isCode(module)).toBe(true);
			expect(second.syncCallOpen()).toBe(true);
			expect(() => second.refuseInSyncCall("tried to write state")).toThrow(second.SyncEffectWorkError);
			expect(call.violation).toBeInstanceOf(second.SyncEffectWorkError);
		} finally {
			first.syncCall.exit(call);
		}
		expect(first.syncCallOpen()).toBe(false);
	});

	it("validates the options at runtime", () => {
		const loose = defineEffect as unknown as (type: unknown, options?: unknown) => unknown;
		expect(() => loose("sync/bad", "sync")).toThrow(/options must be an object/);
		expect(() =>
			loose("sync/bad", {
				settles: "async"
			})
		).toThrow(/settles must be "sync"/);
		expect(() =>
			loose("sync/bad", {
				redact: "yes"
			})
		).toThrow(/redact must be a boolean/);
		expect(() =>
			loose("sync/bad", {
				returns: "value"
			})
		).toThrow(/returns must be "module"/);
		expect(() =>
			loose("sync/bad", {
				replay: true
			})
		).toThrow(/unknown option "replay"/);
		expect(() => loose("")).toThrow(/non-empty string/);
		expect(declarationOf("sync/bad")).toBeUndefined();
	});

	it("declares generateGuid sync", async () => {
		await import("../../src/index");
		expect(settlesSync("generateGuid")).toBe(true);
	});
});
