import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IErrorContext } from "../../src/Runtime/processAction";
import type { IActionGenerator, IActionYield, IOpenGenerator } from "../../src/Types/IAction";
import type { IMessageContext, IMessageOf } from "../../src/Types/IReceiver";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import type { ISerializedThrow } from "../../src/Utility/serializeThrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { start } from "../../src/Effects/start";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import { wrapSetState } from "../../src/Runtime/sliceSetState";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createTestRuntime, settled } from "../../src/Testing/createTestRuntime";
import { unhandledDuring } from "../unhandledDuring";

type IForm = {
	Text: string;
};

type IChild = {
	$Id: string;
	Name: string;
	Form: IForm;
};

type IMiddle = {
	$Id: string;
	Children: IChild[];
};

type IRoot = {
	$Id: string;
	Middles: IMiddle[];
};

type IFailure = IMessageOf<"Action/Error">;

type ICase<T> = (draft: T, failure: IFailure, context: IMessageContext) => IOpenGenerator;

const boom = new Error("boom");

const messageOf = (thrown: ISerializedThrow | undefined): string | undefined => (thrown?.Thrown === "error" ? thrown.Message : undefined);

function* fails(_draft: IChild): IActionGenerator {
	throw boom;
}

function* wait(name: string): Generator<IActionYield, void, any> {
	yield {
		Type: "wait",
		Name: name
	} as IActionYield;
}

function* removeMiddle(draft: IRoot): IActionGenerator {
	draft.Middles = [];
}

function later(microtasks: number, then: () => void): void {
	if (microtasks === 0) {
		then();
		return;
	}
	queueMicrotask(() => later(microtasks - 1, then));
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function build(options: { root?: ICase<IRoot>; middle?: ICase<IMiddle>; onError?: false } = {}) {
	const errors: [
		unknown,
		IErrorContext
	][] = [];
	const gates = new Map<string, () => void>();
	const runtime = createRuntime<IRoot>(
		{
			$Id: "root",
			Middles: [
				{
					$Id: "middle",
					Children: [
						{
							$Id: "child",
							Name: "one",
							Form: {
								Text: ""
							}
						}
					]
				}
			]
		},
		{
			...(options.onError === false
				? {}
				: {
						onError: (error: unknown, context: IErrorContext) => {
							errors.push([
								error,
								context
							]);
						}
					}),
			implementations: {
				wait: (effect: { Name: string }) =>
					new Promise<void>((resolve) => {
						gates.set(effect.Name, resolve);
					})
			}
		}
	);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (diag) => diags.push(diag));
	const failures: IRuntimeEventOf<"failure">[] = [];
	runtime.on("failure", (failure) => failures.push(failure));
	const bound = async () => {
		const { root, middle } = options;
		if (root) {
			const Root = receiver<IRoot>("RootErrorBoundary")({
				"Action/Error": root
			});
			runtime.registerReceiver(Root);
			await runtime.dispatch(function* bindRoot(draft: IRoot): IActionGenerator {
				bind(draft, Root);
			}, "root");
		}
		if (middle) {
			const Middle = receiver<IMiddle>("MiddleErrorBoundary")({
				"Action/Error": middle
			});
			runtime.registerReceiver(Middle);
			await runtime.dispatch(function* bindMiddle(draft: IMiddle): IActionGenerator {
				bind(draft, Middle);
			}, "middle");
		}
	};
	return {
		runtime,
		errors,
		diags,
		failures,
		bound,
		open: (name: string) => gates.get(name)?.()
	};
}

describe("an error boundary", () => {
	it("takes the failure, so onError doesn't hear it and a discarded call is no unhandled rejection", async () => {
		const heard: IFailure[] = [];
		const h = build({
			middle: function* (_draft, failure) {
				heard.push(failure);
			}
		});
		await h.bound();
		const unhandled = await unhandledDuring(() => {
			void h.runtime.dispatch(fails, "child");
		});
		expect(unhandled).toEqual([]);
		expect(
			heard.map((failure) => [
				failure.ActionName,
				messageOf(failure.Error)
			])
		).toEqual([
			[
				"fails",
				"boom"
			]
		]);
		expect(h.errors).toEqual([]);
	});

	it("still lets an awaiting caller see the rejection", async () => {
		const h = build({
			middle: function* () {}
		});
		await h.bound();
		await expect(h.runtime.dispatch(fails, "child")).rejects.toBe(boom);
	});

	it("passes the failure to the next one up by rethrowing the payload, with the original publisher", async () => {
		const above: [
			IFailure,
			string
		][] = [];
		const Root = receiver<IRoot>("RootErrorBoundary")({
			*"Action/Error"(_draft, failure, { publisher }) {
				above.push([
					failure,
					publisher.Id
				]);
			}
		});
		const h = build({
			middle: function* (_draft, failure) {
				throw failure;
			}
		});
		h.runtime.registerReceiver(Root);
		await h.runtime.dispatch(function* bindRoot(draft: IRoot): IActionGenerator {
			bind(draft, Root);
		}, "root");
		await h.bound();
		void h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(
			above.map(([failure, publisher]) => [
				failure.ActionName,
				messageOf(failure.Error),
				failure.Cause,
				publisher
			])
		).toEqual([
			[
				"fails",
				"boom",
				undefined,
				"child"
			]
		]);
		expect(h.errors).toEqual([]);
	});

	it("hands onError the original failure when its rethrow reaches the top", async () => {
		const h = build({
			middle: function* (_draft, failure) {
				throw failure;
			}
		});
		await h.bound();
		void h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(h.errors).toEqual([
			[
				boom,
				{
					ActionName: "fails",
					EntityId: "child"
				}
			]
		]);
	});

	it("fails on its own with any other throw, carrying the failure it was handling as Cause", async () => {
		const own = new Error("toast failed");
		const above: IFailure[] = [];
		const h = build({
			root: function* (_draft, failure) {
				above.push(failure);
			},
			middle: function* () {
				throw own;
			}
		});
		await h.bound();
		void h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(
			above.map((failure) => [
				failure.ActionName,
				messageOf(failure.Error),
				messageOf(failure.Cause)
			])
		).toEqual([
			[
				"MiddleErrorBoundary",
				"toast failed",
				"boom"
			]
		]);
	});

	it("gives onError an error boundary's own failure with the live Cause", async () => {
		const own = new Error("toast failed");
		const h = build({
			middle: function* () {
				throw own;
			}
		});
		await h.bound();
		void h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(h.errors).toEqual([
			[
				own,
				{
					ActionName: "MiddleErrorBoundary",
					EntityId: "middle",
					Cause: boom
				}
			]
		]);
	});

	it("leaves one receiver:error record for its own failure, and none when it rethrows the payload", async () => {
		const receiverErrors = async (middle: ICase<IMiddle>) => {
			const h = build({
				middle
			});
			const records: string[] = [];
			h.runtime.on("record", (record) => {
				if (record.Kind === "receiver:error") {
					records.push(record.RecipientId);
				}
			});
			await h.bound();
			void h.runtime.dispatch(fails, "child").catch(() => {});
			await settled();
			return records;
		};
		expect(
			await receiverErrors(function* () {
				throw new Error("toast failed");
			})
		).toEqual([
			"middle"
		]);
		expect(
			await receiverErrors(function* (_draft, failure) {
				throw failure;
			})
		).toEqual([]);
	});

	it("is found from the entity an action on part of it holds, not from the id it was dispatched with", async () => {
		const heard: [
			string,
			string
		][] = [];
		const h = build({
			middle: function* (_draft, failure, { publisher }) {
				heard.push([
					failure.ActionName,
					publisher.Id
				]);
			}
		});
		await h.bound();
		function* formFails(_draft: IForm): IActionGenerator {
			throw boom;
		}
		const internal = h.runtime as IRuntimeInternal<IRoot>;
		void internal
			.processAction(
				formFails,
				() => h.runtime.state.Middles[0]!.Children[0]!.Form,
				wrapSetState(rawOf(h.runtime.state).Middles[0]!.Children[0]!.Form, internal.get("runtime/writeGateway")),
				() => undefined as unknown as string
			)
			.catch(() => {});
		await settled();
		expect(heard).toEqual([
			[
				"formFails",
				"child"
			]
		]);
		expect(h.errors).toEqual([]);
	});

	it("passes the failure on up when its action is cancelled", async () => {
		const h = build({
			middle: function* () {
				yield* wait("handling");
			}
		});
		await h.bound();
		void h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(h.errors).toEqual([]);
		await h.runtime.dispatch(removeMiddle, "root");
		await settled();
		expect(h.errors.map(([error]) => error)).toEqual([
			boom
		]);
	});
});

describe("onError", () => {
	it("hears a root's own throw", async () => {
		const h = build({
			root: function* () {}
		});
		await h.bound();
		function* rootFails(_draft: IRoot): IActionGenerator {
			throw boom;
		}
		await expect(h.runtime.dispatch(rootFails, "root")).rejects.toBe(boom);
		expect(h.errors).toEqual([
			[
				boom,
				{
					ActionName: "rootFails",
					EntityId: "root"
				}
			]
		]);
	});

	it("is no unhandled rejection for a discarded call it heard, thrown before or after a wait", async () => {
		const onError = vi.fn();
		const runtime = createTestRuntime(
			{
				$Id: "root"
			},
			{
				wait: () => Promise.resolve()
			},
			{
				onError
			}
		);
		function* failsAfterAWait(_draft: object): IActionGenerator {
			yield {
				Type: "wait"
			};
			throw boom;
		}
		const unhandled = await unhandledDuring(() => {
			void runtime.dispatch(fails, "root");
			void runtime.dispatch(failsAfterAWait, "root");
		});
		expect(unhandled).toEqual([]);
		expect(onError.mock.calls.map(([error]) => error)).toEqual([
			boom,
			boom
		]);
	});

	it("leaves its own throw uncaught", async () => {
		const broken = new Error("onError broke");
		const runtime = createRuntime<IRoot>(
			{
				$Id: "root",
				Middles: []
			},
			{
				onError: () => {
					throw broken;
				}
			}
		);
		function* rootFails(_draft: IRoot): IActionGenerator {
			throw boom;
		}
		const unhandled = await unhandledDuring(() => {
			void runtime.dispatch(rootFails, "root");
		});
		expect(unhandled).toEqual([
			broken
		]);
	});
});

describe("a failure nothing takes", () => {
	it("is the dispatch's one unhandled rejection", async () => {
		const h = build({
			onError: false
		});
		const unhandled = await unhandledDuring(() => {
			void h.runtime.dispatch(fails, "child");
		});
		expect(unhandled).toEqual([
			boom
		]);
	});

	it("is the caller's when it catches the dispatch, so nothing is raised", async () => {
		const h = build({
			onError: false
		});
		let caught: unknown;
		const unhandled = await unhandledDuring(() => {
			h.runtime.dispatch(fails, "child").catch((error: unknown) => {
				caught = error;
			});
		});
		expect(caught).toBe(boom);
		expect(unhandled).toEqual([]);
	});

	it("is raised as uncaught once, when an error boundary passes it past the top", async () => {
		const h = build({
			onError: false,
			middle: function* (_draft, failure) {
				throw failure;
			}
		});
		await h.bound();
		const unhandled = await unhandledDuring(() => {
			void h.runtime.dispatch(fails, "child");
		});
		expect(unhandled).toEqual([
			boom
		]);
	});

	it("is raised as uncaught for work the runtime dispatched itself", async () => {
		const h = build({
			onError: false
		});
		function* starts(draft: IMiddle): IActionGenerator {
			yield* start(fails, draft.Children[0]);
		}
		const unhandled = await unhandledDuring(() => {
			void h.runtime.dispatch(starts, "middle");
		});
		expect(unhandled).toEqual([
			boom
		]);
	});
});

describe("a dispatch refused before the action starts", () => {
	it("is an unhandled rejection whatever onError is set", async () => {
		const h = build();
		const unhandled = await unhandledDuring(() => {
			void h.runtime.dispatch(fails, "nobody");
		});
		expect(unhandled.map((error) => (error as Error).name)).toEqual([
			"EntityGoneError"
		]);
		expect(h.errors).toEqual([]);
	});

	describe("because its setter threw", () => {
		const refused = new Error("no setter");
		const call = (h: ReturnType<typeof build>) =>
			h.runtime.processAction(
				fails,
				() => h.runtime.state.Middles[0].Children[0],
				() => {
					throw refused;
				},
				() => "child"
			);

		it("stays unhandled when discarded, with an onError set", async () => {
			const h = build();
			const unhandled = await unhandledDuring(() => {
				void call(h);
			});
			expect(unhandled).toEqual([
				refused
			]);
			expect(h.errors).toEqual([]);
		});

		it("is nobody's unhandled rejection when the caller catches it", async () => {
			const h = build();
			let caught: unknown;
			const unhandled = await unhandledDuring(() => {
				call(h).catch((error: unknown) => {
					caught = error;
				});
			});
			expect(unhandled).toEqual([]);
			expect(caught).toBe(refused);
		});
	});
});

describe("a stopped action", () => {
	it("routes a throw out of its close, and its dispatch still resolves undefined", async () => {
		const heard: IFailure[] = [];
		const h = build({
			middle: function* (_draft, failure) {
				heard.push(failure);
			}
		});
		await h.bound();
		let runs = 0;
		const save = latest(function* saveOnce(_draft: IChild): IActionGenerator {
			if (++runs > 1) {
				return;
			}
			try {
				yield* wait("save");
			} finally {
				// biome-ignore lint/correctness/noUnsafeFinally: the throw from a finally is the subject.
				throw new Error("cleanup failed");
			}
		});
		const first = h.runtime.dispatch(save, "child");
		await settled();
		await h.runtime.dispatch(save, "child");
		expect(await first).toBeUndefined();
		await settled();
		expect(
			heard.map((failure) => [
				failure.ActionName,
				messageOf(failure.Error)
			])
		).toEqual([
			[
				"saveOnce",
				"cleanup failed"
			]
		]);
		expect(
			h.failures.map((failure) => [
				failure.ActionName,
				String(failure.Error),
				failure.Status,
				failure.Close,
				failure.Taken
			])
		).toEqual([
			[
				"saveOnce",
				"Error: cleanup failed",
				"cancelled",
				true,
				true
			]
		]);
	});

	it("routes a branch's failure the stop kept from its root, once the root has settled cancelled", async () => {
		const heard: IFailure[] = [];
		const h = build({
			middle: function* (_draft, failure) {
				heard.push(failure);
			}
		});
		await h.bound();
		let runs = 0;
		const load = latest(function* loadOnce(_draft: IChild): IActionGenerator {
			if (++runs > 1) {
				return;
			}
			yield* parallel(
				(function* (): IActionGenerator {
					yield* wait("branch");
					queueMicrotask(() => {
						void h.runtime.dispatch(load, "child");
					});
					throw boom;
				})(),
				(function* (): IActionGenerator {
					yield* wait("sibling");
				})()
			);
		});
		const first = h.runtime.dispatch(load, "child");
		await settled();
		h.open("branch");
		expect(await first).toBeUndefined();
		await settled();
		expect(
			heard.map((failure) => [
				failure.ActionName,
				messageOf(failure.Error)
			])
		).toEqual([
			[
				"loadOnce",
				"boom"
			]
		]);
	});

	describe("routes a branch's failure exactly once, however many microtasks after its throw the stop lands", () => {
		for (const siblings of [
			0,
			1
		]) {
			for (let microtasks = 0; microtasks <= 10; microtasks++) {
				it(`${microtasks} microtasks after, with ${siblings} sibling${siblings === 1 ? "" : "s"}`, async () => {
					const heard: IFailure[] = [];
					const h = build({
						middle: function* (_draft, failure) {
							heard.push(failure);
						}
					});
					await h.bound();
					let runs = 0;
					const load = latest(function* loadOnce(_draft: IChild): IActionGenerator {
						if (++runs > 1) {
							return;
						}
						const branches: IActionGenerator[] = [
							(function* (): IActionGenerator {
								yield* wait("branch");
								later(microtasks, () => {
									void h.runtime.dispatch(load, "child");
								});
								throw boom;
							})()
						];
						if (siblings === 1) {
							branches.push(
								(function* (): IActionGenerator {
									yield* wait("sibling");
								})()
							);
						}
						yield* parallel(...branches);
					});
					void h.runtime.dispatch(load, "child");
					await settled();
					const unhandled = await unhandledDuring(() => {
						h.open("branch");
					});
					await settled();
					expect(
						heard.map((failure) => [
							failure.ActionName,
							messageOf(failure.Error)
						])
					).toEqual([
						[
							"loadOnce",
							"boom"
						]
					]);
					expect(h.errors).toEqual([]);
					expect(unhandled).toEqual([]);
				});
			}
		}
	});

	describe("a branch stopped for a sibling's failure the action caught", () => {
		const siblingCleanup = new Error("sibling cleanup");
		function* caughtParallel(): IActionGenerator {
			try {
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
							throw siblingCleanup;
						}
					})()
				);
			} catch (error) {
				if (error !== boom) {
					throw error;
				}
			}
		}

		it("has its close throw reported, not routed, when the action completes", async () => {
			const heard: IFailure[] = [];
			const h = build({
				middle: function* (_draft, failure) {
					heard.push(failure);
				}
			});
			await h.bound();
			function* tries(_draft: IChild): IActionGenerator {
				yield* caughtParallel();
			}
			const done = h.runtime.dispatch(tries, "child");
			await settled();
			h.open("a");
			expect(await done).toBeUndefined();
			await settled();
			expect(heard).toEqual([]);
			expect(h.errors).toEqual([]);
			expect(
				h.failures.map((failure) => [
					failure.Error,
					failure.Status,
					failure.Close,
					failure.Taken
				])
			).toEqual([
				[
					siblingCleanup,
					"completed",
					true,
					false
				]
			]);
		});

		it("doesn't take the place of the action's own stop failure when the action is stopped later", async () => {
			const heard: IFailure[] = [];
			const h = build({
				middle: function* (_draft, failure) {
					heard.push(failure);
				}
			});
			await h.bound();
			let runs = 0;
			const tries = latest(function* triesOnce(_draft: IChild): IActionGenerator {
				if (++runs > 1) {
					return;
				}
				yield* caughtParallel();
				try {
					yield* wait("after");
				} finally {
					// biome-ignore lint/correctness/noUnsafeFinally: the throw from a finally is the subject.
					throw new Error("stop cleanup");
				}
			});
			const first = h.runtime.dispatch(tries, "child");
			await settled();
			h.open("a");
			await settled();
			await h.runtime.dispatch(tries, "child");
			expect(await first).toBeUndefined();
			await settled();
			expect(
				heard.map((failure) => [
					failure.ActionName,
					messageOf(failure.Error)
				])
			).toEqual([
				[
					"triesOnce",
					"stop cleanup"
				]
			]);
			expect(h.errors).toEqual([]);
		});
	});

	describe("routes its branch's failure, not a group-stopped sibling's, however soon after the group stopped it the action is stopped", () => {
		const real = new Error("real failure");
		function* siblingCleansUp(): IActionGenerator {
			try {
				yield* wait("never");
			} finally {
				// biome-ignore lint/correctness/noUnsafeFinally: the throw from a finally is the subject.
				throw new Error("sibling cleanup");
			}
		}
		function* throwsOnTick(error: Error): IActionGenerator {
			yield {
				Type: "tick"
			} as IActionYield;
			throw error;
		}
		const shapes: Record<string, () => IActionGenerator[]> = {
			"a sibling's close throw": () => [
				throwsOnTick(real),
				siblingCleansUp()
			],
			"a nested parallel's late rejection": () => [
				(function* (): IActionGenerator {
					yield* parallel(
						throwsOnTick(new Error("nested failure")),
						(function* (): IActionGenerator {
							yield* wait("never");
						})()
					);
				})(),
				throwsOnTick(real)
			]
		};
		for (const [shape, branches] of Object.entries(shapes)) {
			for (let microtasks = 0; microtasks <= 10; microtasks++) {
				it(`over ${shape}, with the stop ${microtasks} microtasks after the tick`, async () => {
					const heard: IFailure[] = [];
					const h = build({
						middle: function* (_draft, failure) {
							heard.push(failure);
						}
					});
					await h.bound();
					let tick!: () => void;
					const ticked = new Promise<void>((resolve) => {
						tick = resolve;
					});
					h.runtime.registerImplementation("tick", () => ticked);
					let runs = 0;
					const loader = latest(function* loaderOnce(_draft: IChild): IActionGenerator {
						if (++runs > 1) {
							return;
						}
						yield* parallel(...branches());
					});
					function* refresher(_draft: IRoot): IActionGenerator {
						yield {
							Type: "tick"
						} as IActionYield;
						later(microtasks, () => {
							void h.runtime.dispatch(loader, "child");
						});
					}
					void h.runtime.dispatch(loader, "child");
					void h.runtime.dispatch(refresher, "root");
					await settled();
					const unhandled = await unhandledDuring(() => {
						tick();
					});
					await settled();
					expect(
						heard.map((failure) => [
							failure.ActionName,
							messageOf(failure.Error)
						])
					).toEqual([
						[
							"loaderOnce",
							"real failure"
						]
					]);
					expect(h.failures.filter((failure) => failure.Taken).map((failure) => String(failure.Error))).toEqual([
						"Error: real failure"
					]);
					expect(h.errors).toEqual([]);
					expect(unhandled).toEqual([]);
				});
			}
		}
	});

	describe("routes a branch's throw in the first step that stopped its action", () => {
		function* throwsAndStops(act: () => void): IActionGenerator {
			act();
			throw new Error("branch boom");
		}
		const shapes: Record<string, (act: () => void) => IActionGenerator> = {
			"in its own parallel": (act) =>
				(function* (): IActionGenerator {
					yield* parallel(
						throwsAndStops(act),
						(function* (): IActionGenerator {
							yield* wait("sibling");
						})()
					);
				})(),
			"in a nested parallel": (act) =>
				(function* (): IActionGenerator {
					yield* parallel(
						(function* (): IActionGenerator {
							yield* parallel(
								throwsAndStops(act),
								(function* (): IActionGenerator {
									yield* wait("inner sibling");
								})()
							);
						})(),
						(function* (): IActionGenerator {
							yield* wait("sibling");
						})()
					);
				})()
		};
		for (const [shape, body] of Object.entries(shapes)) {
			it(shape, async () => {
				const heard: IFailure[] = [];
				const h = build({
					middle: function* (_draft, failure) {
						heard.push(failure);
					}
				});
				await h.bound();
				let runs = 0;
				const act = latest(function* actOnce(_draft: IChild): IActionGenerator {
					if (++runs > 1) {
						return;
					}
					yield* body(() => {
						void h.runtime.dispatch(act, "child");
					});
				});
				let first!: Promise<unknown>;
				const unhandled = await unhandledDuring(() => {
					first = h.runtime.dispatch(act, "child");
				});
				expect(await first).toBeUndefined();
				await settled();
				expect(
					heard.map((failure) => [
						failure.ActionName,
						messageOf(failure.Error)
					])
				).toEqual([
					[
						"actOnce",
						"branch boom"
					]
				]);
				expect(h.errors).toEqual([]);
				expect(unhandled).toEqual([]);
			});
		}
	});

	it("reaches its error boundary when it throws in the step that stopped it", async () => {
		const heard: IFailure[] = [];
		const h = build({
			middle: function* (_draft, failure) {
				heard.push(failure);
			}
		});
		await h.bound();
		let runs = 0;
		const save = latest(function* saveOnce(_draft: IChild): IActionGenerator {
			if (++runs > 1) {
				return;
			}
			yield* wait("save");
			void h.runtime.dispatch(save, "child");
			throw boom;
		});
		const first = h.runtime.dispatch(save, "child");
		await settled();
		h.open("save");
		await expect(first).rejects.toBe(boom);
		await settled();
		expect(heard.map((failure) => messageOf(failure.Error))).toEqual([
			"boom"
		]);
	});

	it("doesn't route what a removed entity's close throws, which reaches the failure event untaken", async () => {
		const h = build();
		function* save(_draft: IChild): IActionGenerator {
			try {
				yield* wait("save");
			} finally {
				// biome-ignore lint/correctness/noUnsafeFinally: the throw from a finally is the subject.
				throw new Error("cleanup failed");
			}
		}
		const first = h.runtime.dispatch(save, "child");
		await settled();
		await h.runtime.dispatch(removeMiddle, "root");
		expect(await first).toBeUndefined();
		await settled();
		expect(h.errors).toEqual([]);
		expect(
			h.failures.map((failure) => [
				failure.ActionName,
				failure.EntityId,
				String(failure.Error),
				failure.Status,
				failure.Close,
				failure.Taken
			])
		).toEqual([
			[
				"save",
				"child",
				"Error: cleanup failed",
				"cancelled",
				true,
				false
			]
		]);
	});
});
