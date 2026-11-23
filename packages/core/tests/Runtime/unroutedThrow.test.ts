import type { IActionGenerator, IActionYield } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { parallel } from "../../src/Effects/parallel";
import { resource } from "../../src/Effects/resource";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { settled } from "../../src/Testing/createTestRuntime";
import { unhandledDuring } from "../unhandledDuring";

interface IDialog {
	$Id: string;
}

interface IRoot {
	$Id: string;
	Dialogs: IDialog[];
}

function* wait(name: string): Generator<IActionYield, void, any> {
	yield {
		Type: "wait",
		Name: name
	} as IActionYield;
}

const openResourceAny = openResource as unknown as (entity: object, key: string, ...rest: unknown[]) => IActionGenerator;

let warn: MockInstance;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function build() {
	const gates = new Map<string, () => void>();
	const runtime = createRuntime<IRoot>(
		{
			$Id: "root",
			Dialogs: [
				{
					$Id: "dialog"
				}
			]
		},
		{
			onError: () => {},
			implementations: {
				wait: (effect: { Name: string }) =>
					new Promise<void>((resolve) => {
						gates.set(effect.Name, resolve);
					})
			}
		}
	);
	return {
		runtime,
		open: (name: string) => gates.get(name)?.(),
		// The console half, so what is pinned is what a runtime nobody listens to still prints.
		unrouted: () =>
			warn.mock.calls
				.map(([, data]) => data as Record<string, unknown> | undefined)
				.filter((data) => data !== undefined && "close" in data && "actionName" in data)
	};
}

function* cleansUpBadly(_draft: IDialog): IActionGenerator {
	try {
		yield* wait("dialog");
	} finally {
		(
			null as unknown as {
				close(): void;
			}
		).close();
	}
}

describe("action/unrouted-throw", () => {
	it("reports a removed entity's close throw, with nobody subscribed to failure", async () => {
		const h = build();
		const done = h.runtime.dispatch(cleansUpBadly, "dialog");
		await settled();
		await h.runtime.dispatch(function* closeDialog(draft: IRoot): IActionGenerator {
			draft.Dialogs = [];
		}, "root");
		expect(await done).toBeUndefined();
		await settled();
		expect(h.unrouted()).toEqual([
			{
				actionName: "cleansUpBadly",
				entityId: "dialog",
				close: true,
				error: expect.objectContaining({
					Name: "TypeError"
				})
			}
		]);
	});

	it("reports a parallel sibling's close throw while another branch fails the action", async () => {
		const h = build();
		const boom = new Error("boom");
		function* fansOut(_draft: IDialog): IActionGenerator {
			yield* parallel(
				(function* (): IActionGenerator {
					yield* wait("a");
					throw boom;
				})(),
				(function* (): IActionGenerator {
					try {
						yield* wait("b");
					} finally {
						// biome-ignore lint/correctness/noUnsafeFinally: the throw from a finally is the subject.
						throw new Error("sibling cleanup");
					}
				})()
			);
		}
		const done = h.runtime.dispatch(fansOut, "dialog");
		await settled();
		h.open("a");
		await expect(done).rejects.toBe(boom);
		await settled();
		expect(h.unrouted()).toEqual([
			{
				actionName: "fansOut",
				entityId: "dialog",
				close: true,
				error: expect.objectContaining({
					Message: "sibling cleanup"
				})
			}
		]);
	});

	it("reports a close throw during runtime.dispose()", async () => {
		const h = build();
		void h.runtime.dispatch(cleansUpBadly, "dialog");
		await settled();
		h.runtime.dispose();
		await settled();
		expect(
			h.unrouted().map((data) => [
				data!.actionName,
				data!.close
			])
		).toEqual([
			[
				"cleansUpBadly",
				true
			]
		]);
	});

	describe("an r.run", () => {
		const boom = new Error("run failed");
		function* failsInRun(): IActionGenerator {
			throw boom;
		}
		function* opens(draft: IDialog): IActionGenerator {
			yield* openResourceAny(draft, "Run/Probe", {
				Type: "run/probe"
			});
		}
		function withType(h: ReturnType<typeof build>, impl: (params: unknown, r: any) => void) {
			const failures: IRuntimeEventOf<"failure">[] = [];
			h.runtime.on("failure", (event) => failures.push(event));
			(
				h.runtime as unknown as {
					registerResourceType(type: string, impl: (params: unknown, r: any) => void): void;
				}
			).registerResourceType("run/probe", impl);
			return failures;
		}

		it("that fails and is handled by the resource holding its promise reports nothing", async () => {
			const h = build();
			let handled: unknown;
			const failures = withType(h, (_params, r) => {
				r.run(failsInRun()).catch((error: unknown) => {
					handled = error;
				});
			});
			await h.runtime.dispatch(opens, "dialog");
			await settled();
			expect(handled).toBe(boom);
			expect(failures).toEqual([]);
			expect(h.unrouted()).toEqual([]);
		});

		it("that fails into a method an action called is reported once, as the calling action's", async () => {
			const h = build();
			const failures = withType(h, (_params, r) => {
				r.methods({
					async load() {
						await r.run(failsInRun());
					}
				});
			});
			await h.runtime.dispatch(opens, "dialog");
			await settled();
			function* calls(_draft: IDialog): IActionGenerator {
				yield* (
					resource("dialog", "Run/Probe" as never) as unknown as {
						load(): IActionGenerator;
					}
				).load();
			}
			const copy = await h.runtime.dispatch(calls, "dialog").then(
				() => undefined,
				(error: unknown) => error
			);
			expect(copy).not.toBe(boom);
			expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
			expect((copy as Error).name).toBe("Error");
			expect((copy as Error).message).toBe("run failed");
			expect(Object.keys(copy as Error)).toEqual([]);
			await settled();
			expect(
				failures.map((failure) => [
					failure.Label,
					failure.Error,
					failure.Taken
				])
			).toEqual([
				[
					"calls",
					boom,
					true
				]
			]);
			expect(h.unrouted()).toEqual([]);
		});

		it("stopped, whose close throws, reports the close throw", async () => {
			const h = build();
			let ended!: Promise<unknown>;
			withType(h, (_params, r) => {
				ended = r.run(cleansUpBadly({} as IDialog)).then(
					() => "resolved",
					(error: unknown) => error
				);
			});
			await h.runtime.dispatch(opens, "dialog");
			await settled();
			await h.runtime.dispatch(function* closeDialog(draft: IRoot): IActionGenerator {
				draft.Dialogs = [];
			}, "root");
			await settled();
			expect(await ended).not.toBeInstanceOf(TypeError);
			expect(
				h.unrouted().map((data) => [
					data!.actionName,
					data!.close
				])
			).toEqual([
				[
					"resourceRun",
					true
				]
			]);
		});
	});

	it("stays quiet for a routed failure, which onError took or the runtime raised uncaught", async () => {
		const h = build();
		function* fails(_draft: IDialog): IActionGenerator {
			throw new Error("routed");
		}
		await h.runtime.dispatch(fails, "dialog").catch(() => {});
		const quiet = createRuntime<IRoot>({
			$Id: "root",
			Dialogs: [
				{
					$Id: "dialog"
				}
			]
		});
		const heard = await unhandledDuring(() => {
			void quiet.dispatch(fails, "dialog");
		});
		expect(heard.map(String)).toEqual([
			"Error: routed"
		]);
		expect(h.unrouted()).toEqual([]);
	});
});
