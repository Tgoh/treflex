import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord, IRecordExtras } from "../../src/Types/IRecord";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { publish as publishTyped } from "../../src/Effects/publish";
import { registerDataSource as registerDataSourceTyped } from "../../src/Effects/registerDataSource";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver as receiverTyped } from "../../src/Runtime/receiver";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { createTestRuntime, rootSetState, treeWrite } from "../testHelpers";

const publish = publishTyped as unknown as (topic: string, data?: any) => Generator<any, void, any>;
const registerDataSource = registerDataSourceTyped as unknown as (
	entity: {
		$Id: string;
	},
	key: string
) => Generator<any, void, any>;
const receiver = receiverTyped as unknown as <
	_T extends {
		$Id: string;
	}
>(
	id: string
) => (cases: Record<string, any>) => any;

function collectRecords(runtime: { on: (name: any, handler: any) => () => void }) {
	const records: Array<{
		record: IRecord;
		live?: IRecordExtras;
	}> = [];
	const off = runtime.on("record", (record: IRecord, live?: IRecordExtras) => {
		records.push({
			record,
			live
		});
	});
	return {
		records,
		off
	};
}

function ofKind<K extends IRecord["Kind"]>(
	records: Array<{
		record: IRecord;
		live?: IRecordExtras;
	}>,
	kind: K
): Array<{
	record: Extract<
		IRecord,
		{
			Kind: K;
		}
	>;
	live?: IRecordExtras;
}> {
	return records.filter((e) => e.record.Kind === kind) as any;
}

describe("record stream: action lifecycle", () => {
	it("appends action:start and a completed action:end with matching ActionId", async () => {
		const runtime = createTestRuntime({
			$Id: "test",
			value: 0
		});
		const { records } = collectRecords(runtime);

		function* setValue(
			draft: {
				value: number;
			},
			v: number
		): IActionGenerator {
			draft.value = v;
		}

		await runtime.dispatch(setValue, "test", 42);

		const [start] = ofKind(records, "action:start");
		const [end] = ofKind(records, "action:end");

		expect(start).toBeDefined();
		expect(end).toBeDefined();
		expect(start.record.Args).toEqual([
			42
		]);
		expect(start.record.Name).toBeNull();
		expect(start.record.Label).toBe("setValue");
		expect(end.record.ActionId).toBe(start.record.ActionId);
		expect(end.record.Status).toBe("completed");
		expect(end.live?.result).toBeUndefined();
		expect(typeof end.live?.duration).toBe("number");
	});

	it("appends an errored action:end when the action throws, with the live error on the extras", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test"
			},
			{},
			{
				allowFailures: [
					failing
				]
			}
		);
		const { records } = collectRecords(runtime);

		function* failing(_draft: object): IActionGenerator {
			throw new Error("boom");
		}

		await expect(runtime.dispatch(failing, "test")).rejects.toThrow("boom");

		const [end] = ofKind(records, "action:end");
		expect(end).toBeDefined();
		expect(end.record.Status).toBe("errored");
		expect((end.live?.error as Error).message).toBe("boom");
	});

	it("a subscriber attaching mid-action sees none of that action's records, and all of the next one's", async () => {
		function* setValue(draft: { value: number }): IActionGenerator {
			draft.value = 1;
			yield {
				Type: "noop"
			};
			draft.value = 2;
		}

		const runtime = createTestRuntime(
			{
				$Id: "test",
				value: 0
			},
			{
				noop: () => undefined
			}
		);

		const promise = runtime.dispatch(setValue, "test");

		const { records } = collectRecords(runtime);
		await promise;

		expect(records).toEqual([]);

		await runtime.dispatch(setValue, "test");
		const kinds = records.map((e) => e.record.Kind);
		expect(kinds[0]).toBe("action:start");
		expect(kinds[kinds.length - 1]).toBe("action:end");
		expect(kinds).toContain("step");
	});
});

describe("record stream: effects and steps", () => {
	it("appends an effect record at dispatch and a response record at settlement", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test",
				data: ""
			},
			{
				fetch: () => "ok"
			}
		);
		const { records } = collectRecords(runtime);

		function* loadData(draft: { data: string }): IActionGenerator {
			const r: string = yield {
				Type: "fetch"
			};
			draft.data = r;
		}

		await runtime.dispatch(loadData, "test");

		const [effect] = ofKind(records, "effect");
		const [response] = ofKind(records, "response");

		expect(effect).toBeDefined();
		expect(effect.record.Descriptor).toMatchObject({
			Type: "fetch"
		});
		expect(response).toBeDefined();
		expect(response.record.ForSeq).toBe(effect.record.Seq);
		expect((response.record as Record<string, unknown>).Value).toBe("ok");
		expect(response.live?.result).toBe("ok");
		expect(response.live?.error).toBeUndefined();
	});

	it("a throwing impl settles with the Error response variant and the live error on the extras", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test",
				caught: ""
			},
			{
				fail: () => {
					throw new Error("impl boom");
				}
			}
		);
		const { records } = collectRecords(runtime);

		function* resilient(draft: { caught: string }): IActionGenerator {
			try {
				yield {
					Type: "fail"
				};
			} catch (e: any) {
				draft.caught = e.message;
			}
		}

		await runtime.dispatch(resilient, "test");

		const [response] = ofKind(records, "response");
		expect(response).toBeDefined();
		expect("Error" in response.record).toBe(true);
		expect((response.live?.error as Error).message).toBe("impl boom");
		expect(response.live?.result).toBeUndefined();
	});

	it("appends step records with cloned Prev/Value for each written slice", async () => {
		const runtime = createTestRuntime({
			$Id: "test",
			name: "before"
		});
		const { records } = collectRecords(runtime);

		function* setName(draft: { name: string }): IActionGenerator {
			draft.name = "after";
		}

		await runtime.dispatch(setName, "test");

		const steps = ofKind(records, "step");
		expect(steps.length).toBeGreaterThanOrEqual(1);
		expect(steps[0].record.Changes[0]).toMatchObject({
			Path: [
				"name"
			],
			Prev: "before",
			Value: "after"
		});
	});

	it("an effect aborted mid-await never settles — the cancelled action:end tells the story", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<{
					$Id: string;
					Children: {
						$Id: string;
					}[];
				}>(
					{
						$Id: "parent",
						Children: [
							{
								$Id: "child"
							}
						]
					},
					{
						onError: () => {}
					}
				);
				const { records } = collectRecords(runtime);

				runtime.registerImplementation("longpoll", (_e, action) => {
					return new Promise((_resolve, reject) => {
						action?.signal.addEventListener("abort", () => {
							reject(new DOMException("aborted", "AbortError"));
						});
					});
				});

				function* poll(_draft: { $Id: string }): IActionGenerator {
					yield {
						Type: "longpoll"
					};
				}

				const childSetState = sliceSetState(rootSetState(runtime), (x: any) => x.Children[0]);
				const idAccessor = () => runtime.state.Children[0]?.$Id ?? "";
				const promise = runtime.processAction(poll, () => runtime.state as any, childSetState, idAccessor);

				await Promise.resolve();
				treeWrite(runtime, (s) => {
					s.Children = [];
				});
				await promise;

				const [effect] = ofKind(records, "effect");
				expect(effect).toBeDefined();
				expect(ofKind(records, "response").filter((r) => r.record.ForSeq === effect.record.Seq)).toEqual([]);

				const [start] = ofKind(records, "action:start");
				const end = ofKind(records, "action:end").find((r) => r.record.ActionId === start.record.ActionId);
				expect(end?.record.Status).toBe("cancelled");
			} finally {
				dispose();
			}
		});
	});
});

describe("record stream: branch lifecycle for parallel", () => {
	it("appends branch:start and branch:end for each parallel child", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test"
			},
			{
				echo: (e: any) => e.payload
			}
		);
		const { records } = collectRecords(runtime);

		function* a(): IActionGenerator {
			yield {
				Type: "echo",
				payload: "a"
			};
		}
		function* b(): IActionGenerator {
			yield {
				Type: "echo",
				payload: "b"
			};
		}
		function* branches(): IActionGenerator {
			yield* parallel(a(), b());
		}

		await runtime.dispatch(branches, "test");

		const spawns = ofKind(records, "branch:start");
		const completes = ofKind(records, "branch:end");
		expect(spawns.length).toBe(2);
		expect(completes.length).toBe(2);

		const parentIds = new Set(spawns.map((s) => s.record.ParentBranchId));
		expect(parentIds.size).toBe(1);

		const childIds = new Set(spawns.map((s) => s.record.BranchId));
		expect(childIds.size).toBe(2);
		expect(
			childIds.has(
				[
					...parentIds
				][0]
			)
		).toBe(false);
	});

	it("branch:end reports the child's terminal status, with duration on the extras", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test"
			},
			{
				ok: () => "ok"
			}
		);
		const { records } = collectRecords(runtime);

		function* leg(): IActionGenerator {
			yield {
				Type: "ok"
			};
		}
		function* branches(): IActionGenerator {
			yield* parallel(leg());
		}

		await runtime.dispatch(branches, "test");
		const [complete] = ofKind(records, "branch:end");
		expect(complete.record.Status).toBe("completed");
		expect(typeof complete.live?.duration).toBe("number");
	});
});

describe("record stream: cascade records", () => {
	it("appends entity:dispose for each removed entity (depth-first)", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<{
					$Id: string;
					Children: {
						$Id: string;
						GrandChildren: {
							$Id: string;
						}[];
					}[];
				}>({
					$Id: "root",
					Children: [
						{
							$Id: "node",
							GrandChildren: [
								{
									$Id: "leaf-a"
								},
								{
									$Id: "leaf-b"
								}
							]
						}
					]
				});
				const { records } = collectRecords(runtime);

				treeWrite(runtime, (s) => {
					s.Children = [];
				});
				await Promise.resolve();

				const disposeIds = ofKind(records, "entity:dispose").map((e) => e.record.EntityId);

				expect(disposeIds).toContain("leaf-a");
				expect(disposeIds).toContain("leaf-b");
				expect(disposeIds).toContain("node");

				expect(disposeIds.indexOf("leaf-a")).toBeLessThan(disposeIds.indexOf("node"));
				expect(disposeIds.indexOf("leaf-b")).toBeLessThan(disposeIds.indexOf("node"));
			} finally {
				dispose();
			}
		});
	});

	it("entity:dispose carries the disposed entity's path at the time of dispose", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<{
					$Id: string;
					Children: {
						$Id: string;
					}[];
				}>({
					$Id: "root",
					Children: [
						{
							$Id: "child"
						}
					]
				});
				const { records } = collectRecords(runtime);

				treeWrite(runtime, (s) => {
					s.Children = [];
				});
				await Promise.resolve();

				const childDispose = ofKind(records, "entity:dispose").find((e) => e.record.EntityId === "child");
				expect(childDispose).toBeDefined();
				expect(childDispose?.record.Path).toEqual([
					"root",
					"child"
				]);
			} finally {
				dispose();
			}
		});
	});

	it("appends message:deliver when a topic is published; the payload lives on the effect record", async () => {
		await createRoot(async (dispose) => {
			try {
				type RootState = {
					$Id: string;
					Notes: string[];
				};
				const runtime = createRuntime<RootState>({
					$Id: "root",
					Notes: []
				});

				const TestReceiver = receiver<RootState>("TestReceiver")({
					"events.test/Ping": function* () {}
				});
				runtime.registerReceiver(TestReceiver);

				function* init(draft: RootState): IActionGenerator {
					bind(draft, TestReceiver);
				}

				await runtime.processAction(
					init,
					() => runtime.state as any,
					rootSetState(runtime),
					() => "root"
				);

				const { records } = collectRecords(runtime);

				function* sender(_draft: RootState): IActionGenerator {
					yield* publish("events.test/Ping");
				}

				await runtime.processAction(
					sender,
					() => runtime.state as any,
					rootSetState(runtime),
					() => "root"
				);

				const [delivery] = ofKind(records, "message:deliver");
				expect(delivery).toBeDefined();
				expect(delivery.record.Topic).toBe("events.test/Ping");
				expect(delivery.record.RecipientIds).toEqual([
					"root"
				]);
				expect(delivery.record.PublisherId).toBe("root");
				const publishEffect = ofKind(records, "effect").find((e) => e.record.Type === "publish");
				expect(publishEffect?.record.Descriptor).toMatchObject({
					Data: {
						Type: "events.test/Ping"
					}
				});
			} finally {
				dispose();
			}
		});
	});

	it("registerDataSource narrates through table records, not a dedicated vocabulary", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime({
					$Id: "root",
					Theme: {
						$Id: "theme",
						Marker: "x"
					}
				});

				const { records } = collectRecords(runtime);

				function* setup(draft: any): IActionGenerator {
					yield* registerDataSource(draft.Theme, "TestTheme");
				}
				await runtime.processAction(
					setup,
					() => runtime.state as any,
					rootSetState(runtime),
					() => "theme"
				);

				expect(records.some((e) => e.record.Kind.startsWith("dataSource"))).toBe(false);
				const tables = ofKind(records, "table");
				expect(tables.some((t) => t.record.Table === "dataSources")).toBe(true);
				expect(records.some((e) => e.record.Kind.startsWith("action:"))).toBe(true);
			} finally {
				dispose();
			}
		});
	});
});

describe("record ordering across action lifecycle", () => {
	it("records for a single action land in a coherent order", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test",
				v: 0
			},
			{
				echo: (e: any) => e.payload
			}
		);
		const { records } = collectRecords(runtime);

		function* doWork(draft: { v: number }): IActionGenerator {
			draft.v = 1;
			const r: number = yield {
				Type: "echo",
				payload: 2
			};
			draft.v = r;
		}

		await runtime.dispatch(doWork, "test");

		const seq = records.map((e) => e.record.Kind);
		expect(seq[0]).toBe("action:start");
		expect(seq[seq.length - 1]).toBe("action:end");
		const effectIdx = seq.indexOf("effect");
		const responseIdx = seq.indexOf("response");
		expect(effectIdx).toBeGreaterThan(0);
		expect(responseIdx).toBeGreaterThan(effectIdx);
		expect(seq.indexOf("action:end")).toBeGreaterThan(responseIdx);
	});
});
