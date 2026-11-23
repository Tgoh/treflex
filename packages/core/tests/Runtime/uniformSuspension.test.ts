import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it } from "vitest";
import { getDataGlobal } from "../../src/Reads/getData";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import * as reactive from "../reactive";
import { rootSetState } from "../testHelpers";

type ITestState = {
	$Id: string;
	X: number;
	SeenAfterRead: number | null;
};

const getDataAny = getDataGlobal as unknown as (key: string) => Generator<any, unknown, any>;

describe("synchronous reads", () => {
	it("runs consecutive read yields in one synchronous chain — nothing interleaves", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ITestState>({
					$Id: "Root",
					X: 0,
					SeenAfterRead: null
				});

				function* reader(draft: ITestState): IActionGenerator {
					draft.X = 1;
					yield* getDataAny("First");
					yield* getDataAny("Second");
					draft.SeenAfterRead = draft.X;
				}

				function* writer(draft: ITestState): IActionGenerator {
					draft.X = 2;
				}

				const dispatch = (action: (draft: ITestState) => IActionGenerator) =>
					runtime.processAction(
						action as any,
						() => runtime.state,
						rootSetState(runtime),
						() => "Root"
					);

				const readerDone = dispatch(reader);
				expect(runtime.state.SeenAfterRead).toBe(1);

				const writerDone = dispatch(writer);
				await Promise.all([
					readerDone,
					writerDone
				]);

				expect(runtime.state.SeenAfterRead).toBe(1);
				expect(runtime.state.X).toBe(2);
			} finally {
				dispose();
			}
		});
	});

	it("runs an effect settlement's following read chain synchronously — adjacent by construction", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ITestState>({
					$Id: "Root",
					X: 0,
					SeenAfterRead: null
				});

				// One shared gate both actions park on, released by the test.
				// Releasing it queues both continuations in dispatch order —
				// reader's first — so writer's slice sits IMMEDIATELY behind
				// reader's settlement on the microtask queue. If any await
				// separated reader's post-settlement slices from each other,
				// writer's write would land between them.
				let release!: () => void;
				const gate = new Promise<void>((r) => {
					release = r;
				});
				runtime.registerImplementation("suspension_gate", () => gate);

				function* reader(draft: ITestState): IActionGenerator {
					yield {
						Type: "suspension_gate"
					};
					draft.X = 1;
					yield* getDataAny("First");
					draft.SeenAfterRead = draft.X;
				}

				function* writer(draft: ITestState): IActionGenerator {
					yield {
						Type: "suspension_gate"
					};
					draft.X = 2;
				}

				const dispatch = (action: (draft: ITestState) => IActionGenerator) =>
					runtime.processAction(
						action as any,
						() => runtime.state,
						rootSetState(runtime),
						() => "Root"
					);

				const readerDone = dispatch(reader);
				const writerDone = dispatch(writer);
				release();
				await Promise.all([
					readerDone,
					writerDone
				]);

				expect(runtime.state.SeenAfterRead).toBe(1);
				expect(runtime.state.X).toBe(2);
			} finally {
				dispose();
			}
		});
	});

	it("keeps effect yields as interleave points — the recorded boundary", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ITestState>({
					$Id: "Root",
					X: 0,
					SeenAfterRead: null
				});

				runtime.registerImplementation("noop_effect", () => undefined);

				function* noop(): IActionGenerator {
					yield {
						Type: "noop_effect"
					};
				}
				function* reader(draft: ITestState) {
					draft.X = 1;
					yield* open(noop());
					draft.SeenAfterRead = draft.X;
				}

				function* writer(draft: ITestState): IActionGenerator {
					draft.X = 2;
				}

				const dispatch = (action: IAction<ITestState, []>) =>
					runtime.processAction(
						action as any,
						() => runtime.state,
						rootSetState(runtime),
						() => "Root"
					);

				const readerDone = dispatch(reader);
				const writerDone = dispatch(writer);
				await Promise.all([
					readerDone,
					writerDone
				]);

				expect(runtime.state.SeenAfterRead).toBe(2);
				expect(runtime.state.X).toBe(2);
			} finally {
				dispose();
			}
		});
	});
});
