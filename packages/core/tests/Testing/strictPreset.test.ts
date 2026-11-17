import type { ITestRuntimeOptions } from "../../src/Testing/createTestRuntime";
import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../../src/Effects/start";
import { leading } from "../../src/Runtime/arrivalPolicy";
import { bind } from "../../src/Runtime/bind";
import { receiver as receiverTyped } from "../../src/Runtime/receiver";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createTestRuntime, settled } from "../../src/Testing/createTestRuntime";
import { drainReports } from "../../src/Testing/reports";

const receiver = receiverTyped as unknown as <
	_T extends {
		$Id: string;
	}
>(
	id: string
) => (cases: Record<string, any>) => any;

type ITree = {
	$Id: string;
	Count: number;
	Box: {
		$Id: string;
		Sneak?: object;
	};
	Children: {
		$Id: string;
	}[];
};

const tree = (): ITree => ({
	$Id: "Root",
	Count: 0,
	Box: {
		$Id: "box"
	},
	Children: [
		{
			$Id: "child"
		}
	]
});

const boom = new Error("boom");

function* fails(_draft: object): IActionGenerator {
	throw boom;
}

function* startsFailing(draft: ITree): IActionGenerator {
	yield* start(fails, draft.Children[0]!);
}

const reported = async (): Promise<Error[]> => {
	await settled();
	return drainReports();
};

const messages = (errors: readonly Error[]) => errors.map((error) => error.message);

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("diags", () => {
	it("reports one the options don't list, with the code, the opt-out, the event as cause and the builder's line first on the stack", async () => {
		const runtime = createTestRuntime(tree());
		await runtime.dispatch(fails, "gone").catch(() => {});
		const errors = await reported();
		expect(messages(errors)).toEqual([
			expect.stringContaining(
				'[treflex] createTestRuntime: an unexpected diag, "dispatch/unresolved-entity". If the test expects it, pass allowDiags: ["dispatch/unresolved-entity"] in createTestRuntime\'s options'
			)
		]);
		expect((errors[0]!.cause as IRuntimeEventOf<"diag">).code).toBe("dispatch/unresolved-entity");
		expect(errors[0]!.stack!.split("\n")[1]).toContain("strictPreset.test.ts");
	});

	it("lets a listed code pass, and reports one the list leaves out", async () => {
		const listed = createTestRuntime(
			tree(),
			{},
			{
				allowDiags: [
					"dispatch/unresolved-entity"
				]
			}
		);
		await listed.dispatch(fails, "gone").catch(() => {});
		expect(await reported()).toEqual([]);
		const other = createTestRuntime(
			tree(),
			{},
			{
				allowDiags: [
					"action/long-hold"
				]
			}
		);
		await other.dispatch(fails, "gone").catch(() => {});
		expect(messages(await reported())).toEqual([
			expect.stringContaining('"dispatch/unresolved-entity"')
		]);
	});

	it("lets every code pass with allowDiags: true", async () => {
		const runtime = createTestRuntime(
			tree(),
			{},
			{
				allowDiags: true
			}
		);
		await runtime.dispatch(fails, "gone").catch(() => {});
		expect(await reported()).toEqual([]);
	});

	it("never reports state/view-write, which every live runtime hears and which throws at the writer", async () => {
		createTestRuntime(tree());
		const runtime = createTestRuntime(tree());
		expect(() => {
			(runtime.state as ITree).Count = 1;
		}).toThrow(/state is read-only outside a dispatch/);
		expect(await reported()).toEqual([]);
	});
});

describe("failures", () => {
	const Boundary = receiver<ITree>("StrictPresetBoundary")({
		*"Action/Error"() {}
	});
	async function guarded(options?: ITestRuntimeOptions) {
		const runtime = createTestRuntime(tree(), {}, options);
		runtime.registerReceiver(Boundary);
		await runtime.dispatch(function* guard(draft: ITree): IActionGenerator {
			bind(draft, Boundary);
		}, "Root");
		return runtime;
	}

	it("reports one the test awaits, naming the action, the entity and the opt-out, with the failure on cause", async () => {
		const runtime = createTestRuntime(tree());
		await expect(runtime.dispatch(fails, "child")).rejects.toBe(boom);
		const errors = await reported();
		expect(messages(errors)).toEqual([
			expect.stringContaining(
				'[treflex] createTestRuntime: action "fails" on "child" failed. If the test expects it, pass allowFailures: [fails] in createTestRuntime\'s options'
			)
		]);
		expect(errors[0]!.cause).toBe(boom);
		expect(errors[0]!.stack!.split("\n")[1]).toContain("strictPreset.test.ts");
	});

	it("reports one nothing awaits, and one on started work", async () => {
		const runtime = createTestRuntime(tree());
		void runtime.dispatch(fails, "Root");
		await runtime.dispatch(startsFailing, "Root");
		expect(messages(await reported())).toEqual([
			expect.stringContaining('action "fails" on "Root" failed.'),
			expect.stringContaining('action "fails" on "child" failed.')
		]);
	});

	it("reports one onError or an error boundary took", async () => {
		const onError = vi.fn();
		const taken = createTestRuntime(
			tree(),
			{},
			{
				onError
			}
		);
		await taken.dispatch(fails, "child").catch(() => {});
		expect(onError).toHaveBeenCalledTimes(1);
		const bounded = await guarded();
		await bounded.dispatch(fails, "child").catch(() => {});
		expect(messages(await reported())).toEqual([
			expect.stringContaining('action "fails" on "child" failed.'),
			expect.stringContaining('action "fails" on "child" failed.')
		]);
	});

	it("lets every failure pass with allowFailures: true, which passes onError through", async () => {
		const onError = vi.fn();
		const taken = createTestRuntime(
			tree(),
			{},
			{
				onError,
				allowFailures: true
			}
		);
		const bounded = await guarded({
			allowFailures: true
		});
		void taken.dispatch(fails, "child");
		void bounded.dispatch(fails, "child");
		await taken.dispatch(startsFailing, "Root");
		expect(await reported()).toEqual([]);
		expect(onError).toHaveBeenCalledTimes(2);
	});

	it("lets a listed action's failures pass, matched by identity, not by name", async () => {
		const saveFrom = (module: string) =>
			function* save(_draft: object): IActionGenerator {
				throw new Error(module);
			};
		const listed = saveFrom("listed");
		const unlisted = saveFrom("not listed");
		expect([
			listed.name,
			unlisted.name
		]).toEqual([
			"save",
			"save"
		]);
		const runtime = createTestRuntime(
			tree(),
			{},
			{
				allowFailures: [
					listed
				]
			}
		);
		await runtime.dispatch(listed, "child").catch(() => {});
		await runtime.dispatch(unlisted, "child").catch(() => {});
		expect(messages(await reported())).toEqual([
			expect.stringContaining('action "save" on "child" failed. If the test expects it, pass allowFailures: [save]')
		]);
	});

	it("takes the list as it stands when the runtime is built, so a later push allows nothing", async () => {
		const allowFailures: IAction<any, any, any>[] = [];
		const runtime = createTestRuntime(
			tree(),
			{},
			{
				allowFailures
			}
		);
		allowFailures.push(fails);
		await runtime.dispatch(fails, "child").catch(() => {});
		expect(messages(await reported())).toEqual([
			expect.stringContaining('action "fails" on "child" failed.')
		]);
	});

	it("matches a leading action by the reference leading returned, which is the function itself", async () => {
		const once = leading(function* once(_draft: ITree): IActionGenerator {
			throw new Error("once");
		});
		const runtime = createTestRuntime(
			tree(),
			{},
			{
				allowFailures: [
					once
				]
			}
		);
		await runtime.dispatch(once, "child").catch(() => {});
		expect(await reported()).toEqual([]);
	});

	it("points an anonymous action's failure at the function passed to dispatch", async () => {
		const runtime = createTestRuntime(tree());
		await runtime
			.dispatch(function* (_draft: object): IActionGenerator {
				throw boom;
			}, "child")
			.catch(() => {});
		expect(messages(await reported())).toEqual([
			expect.stringContaining(
				'action "(anonymous)" on "child" failed. If the test expects it, pass allowFailures: [action] in createTestRuntime\'s options (docs/reference/testing.md#failures-and-diags-fail-the-test), action being the function passed to dispatch or start, by reference.'
			)
		]);
	});

	it("matches an error boundary's own failure, and a receiver case's, by the receiver's handle", async () => {
		const own = new Error("the boundary failed");
		const Failing = receiver<ITree>("StrictPreset/FailingBoundary")({
			*"Action/Error"() {
				throw own;
			},
			*"Preset/Throw"() {
				throw new Error("the case failed");
			}
		});
		const run = async (allowFailures: ITestRuntimeOptions["allowFailures"]) => {
			const runtime = createTestRuntime(
				tree(),
				{},
				{
					allowFailures
				}
			);
			runtime.registerReceiver(Failing);
			await runtime.dispatch(function* guard(draft: ITree): IActionGenerator {
				bind(draft, Failing);
			}, "Root");
			await runtime.dispatch(fails, "child").catch(() => {});
			await runtime
				.dispatch(
					Failing.handle,
					"Root",
					{
						Type: "Preset/Throw"
					},
					{
						publisher: {
							Id: "Root"
						}
					}
				)
				.catch(() => {});
			return messages(await reported());
		};
		expect(
			await run([
				fails
			])
		).toEqual([
			expect.stringContaining(
				'action "StrictPreset/FailingBoundary" on "Root" failed. If the test expects it, pass allowFailures: [Receiver.handle] in createTestRuntime\'s options (docs/reference/testing.md#failures-and-diags-fail-the-test), Receiver being the receiver "StrictPreset/FailingBoundary".'
			),
			expect.stringContaining(
				'action "StrictPreset/FailingBoundary" on "Root" failed. If the test expects it, pass allowFailures: [Receiver.handle]'
			)
		]);
		expect(
			await run([
				fails,
				Failing.handle
			])
		).toEqual([]);
	});

	it("reports a throw out of onError whatever is allowed, and counts the failure taken", async () => {
		const broken = new Error("onError broke");
		const options = {
			onError: () => {
				throw broken;
			}
		};
		const strict = createTestRuntime(tree(), {}, options);
		const taken: boolean[] = [];
		strict.on("failure", (event) => taken.push(event.Taken));
		await strict.dispatch(fails, "child").catch(() => {});
		expect(taken).toEqual([
			true
		]);
		expect(messages(await reported())).toEqual([
			expect.stringContaining('onError threw while taking the failure of action "fails" on "child". The throw: onError broke'),
			expect.stringContaining('action "fails" on "child" failed.')
		]);
		const allowing = createTestRuntime(
			tree(),
			{},
			{
				...options,
				allowFailures: true
			}
		);
		await allowing.dispatch(fails, "child").catch(() => {});
		const errors = await reported();
		expect(messages(errors)).toEqual([
			expect.stringContaining("onError threw")
		]);
		expect(errors[0]!.cause).toBe(broken);
	});

	it("reports an unrouted throw as a failure, whatever allowDiags says, and lets it pass when its action is listed", async () => {
		function* cleansUpBadly(_draft: object): IActionGenerator {
			try {
				yield {
					Type: "wait"
				};
			} finally {
				// biome-ignore lint/correctness/noUnsafeFinally: the throw from a close is the subject.
				throw boom;
			}
		}
		const unrouted = async (options: ITestRuntimeOptions) => {
			let release!: () => void;
			const runtime = createTestRuntime(
				tree(),
				{
					wait: () =>
						new Promise<void>((resolve) => {
							release = resolve;
						})
				},
				options
			);
			const done = runtime.dispatch(cleansUpBadly, "child");
			await runtime.dispatch(function* remove(draft: ITree): IActionGenerator {
				draft.Children = [];
			}, "Root");
			await done;
			release();
			return reported();
		};
		expect(
			messages(
				await unrouted({
					allowDiags: true
				})
			)
		).toEqual([
			expect.stringContaining(
				'action "cleansUpBadly" on "child" threw where no error boundary or onError can take it (action/unrouted-throw)'
			)
		]);
		expect(
			await unrouted({
				allowFailures: [
					cleansUpBadly
				]
			})
		).toEqual([]);
	});

	it("leaves a dispatch refused before its action starts to its own promise and its diag", async () => {
		const runtime = createTestRuntime(
			tree(),
			{},
			{
				allowDiags: [
					"dispatch/unresolved-entity"
				]
			}
		);
		await expect(runtime.dispatch(fails, "gone")).rejects.toThrow(/no entity "gone"/);
		expect(await reported()).toEqual([]);
	});
});

describe("verifyIndex", () => {
	function* bump(draft: ITree): IActionGenerator {
		draft.Count++;
	}
	const sneakThenWrite = (options?: ITestRuntimeOptions): Promise<unknown> => {
		const runtime = createTestRuntime(
			tree(),
			{},
			{
				allowFailures: [
					bump
				],
				...options
			}
		);
		(rawOf(runtime.state) as ITree).Box.Sneak = {
			$Id: "sneak"
		};
		return runtime.dispatch(bump, "Root");
	};
	const caught = /index is missing entity "sneak"/;

	it("walks on every reconciliation by default", async () => {
		vi.stubEnv("TREFLEX_VERIFY_INDEX", undefined);
		expect(
			(
				globalThis as unknown as {
					process: {
						env: Record<string, string | undefined>;
					};
				}
			).process.env.TREFLEX_VERIFY_INDEX
		).toBeUndefined();
		await expect(sneakThenWrite()).rejects.toThrow(caught);
	});

	it("takes the TREFLEX_VERIFY_INDEX environment variable over its default", async () => {
		vi.stubEnv("TREFLEX_VERIFY_INDEX", "off");
		await expect(sneakThenWrite()).resolves.toBeUndefined();
	});

	it("takes the option over the environment variable", async () => {
		vi.stubEnv("TREFLEX_VERIFY_INDEX", "off");
		await expect(
			sneakThenWrite({
				verifyIndex: "always"
			})
		).rejects.toThrow(caught);
		vi.stubEnv("TREFLEX_VERIFY_INDEX", "always");
		await expect(
			sneakThenWrite({
				verifyIndex: false
			})
		).resolves.toBeUndefined();
	});
});
