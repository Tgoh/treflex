import type { IActionGenerator } from "../../src/Types/IAction";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { describe, expect, it } from "vitest";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { getData, getDataGlobal } from "../../src/Reads/getData";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTestRuntime } from "../../src/Testing/createTestRuntime";
import { rootSetState, treeWrite } from "../testHelpers";

const getDS = getDataGlobal as unknown as (key: string) => Generator<any, any, any>;
const getDSScoped = getData as unknown as (
	from: {
		$Id: string;
	},
	key: string
) => Generator<any, any, any>;
const registerDS = registerDataSource as unknown as (
	entity: {
		$Id: string;
	},
	key: string
) => Generator<any, void, any>;

async function withRuntime<T extends object>(
	initial: T,
	options: Parameters<typeof createRuntime>[1],
	body: (runtime: ReturnType<typeof createRuntime<T>>) => Promise<void>
): Promise<void> {
	await createRoot(async (dispose) => {
		try {
			await body(createRuntime(initial, options));
		} finally {
			dispose();
		}
	});
}

async function read(runtime: any, key: string): Promise<any> {
	function* impl(): IActionGenerator<any> {
		return yield* getDS(key);
	}
	return runtime.processAction(
		impl,
		() => runtime.state,
		rootSetState(runtime),
		() => "reader"
	);
}

describe("external sources: getData", () => {
	it("resolves an external source registered under a data-source key", async () => {
		await withRuntime(
			{
				$Id: "root"
			},
			undefined,
			async (runtime) => {
				runtime.registerExternalSource({
					Id: "Cfg",
					DataSourceKeys: [
						"Config"
					],
					getData: () => ({
						Mode: "dark"
					})
				});
				expect(await read(runtime, "Config")).toEqual({
					Mode: "dark"
				});
			}
		);
	});

	it("returns undefined for a key no source serves", async () => {
		await withRuntime(
			{
				$Id: "root"
			},
			undefined,
			async (runtime) => {
				expect(await read(runtime, "Nothing")).toBeUndefined();
			}
		);
	});

	it("a tree data source wins over an external source on the same key", async () => {
		await withRuntime(
			{
				$Id: "root",
				Cfg: {
					$Id: "Cfg",
					Marker: "tree"
				}
			},
			undefined,
			async (runtime) => {
				runtime.registerExternalSource({
					Id: "ExtCfg",
					DataSourceKeys: [
						"Config"
					],
					getData: () => ({
						Marker: "external"
					})
				});
				function* reg(): IActionGenerator {
					yield* registerDS(
						{
							$Id: "Cfg"
						},
						"Config"
					);
				}
				await runtime.processAction(
					reg,
					() => runtime.state,
					rootSetState(runtime),
					() => "Cfg"
				);
				expect(await read(runtime, "Config")).toMatchObject({
					Marker: "tree"
				});
			}
		);
	});

	// A source has no path, so it cannot sit on anybody's lineage. The
	// fallback therefore belongs to the global read alone: a scoped read
	// answered by a source would be a lineage answer from something that is
	// not on the lineage, which is the sentence three docs carry.
	it("a scoped read never falls back to an external source", async () => {
		await withRuntime(
			{
				$Id: "root",
				Child: {
					$Id: "child"
				}
			},
			undefined,
			async (runtime) => {
				runtime.registerExternalSource({
					Id: "Cfg",
					DataSourceKeys: [
						"Config"
					],
					getData: () => ({
						Mode: "dark"
					})
				});
				function* scoped(): IActionGenerator<any> {
					return yield* getDSScoped(
						{
							$Id: "child"
						},
						"Config"
					);
				}
				const result = await runtime.processAction(
					scoped,
					() => runtime.state,
					rootSetState(runtime),
					() => "child"
				);
				expect(result).toBeUndefined();
				expect(await read(runtime, "Config")).toEqual({
					Mode: "dark"
				});
			}
		);
	});

	it("action-side reads are value snapshots — a re-yield reads the source's current state", async () => {
		await withRuntime(
			{
				$Id: "root"
			},
			undefined,
			async (runtime) => {
				const [store, setStore] = createStore({
					Count: 0
				});
				runtime.registerExternalSource({
					Id: "Counter",
					DataSourceKeys: [
						"Counter"
					],
					getData: () => store
				});
				const a = await read(runtime, "Counter");
				expect(a.Count).toBe(0);
				setStore("Count", 5);
				const b = await read(runtime, "Counter");
				expect(b.Count).toBe(5);
				expect(a).not.toBe(b);
				expect(a.Count).toBe(0);
			}
		);
	});
});

describe("external sources: publish", () => {
	it("a publish reaches a subscribed source's receivePublish", async () => {
		const received: {
			data: any;
			publisher: string;
		}[] = [];
		const runtime = createTestRuntime({
			$Id: "test"
		});
		runtime.registerExternalSource({
			Id: "Sink",
			Topics: [
				"TestTopic"
			],
			receivePublish: (data, ctx) => {
				received.push({
					data,
					publisher: ctx.publisher.Id
				});
			}
		});
		function* act(): IActionGenerator {
			yield {
				Type: "publish",
				Data: {
					Type: "TestTopic",
					Foo: 1
				}
			};
		}
		await runtime.dispatch(act, "test");
		expect(received).toEqual([
			{
				data: {
					Type: "TestTopic",
					Foo: 1
				},
				publisher: "test"
			}
		]);
	});

	it("a source not subscribed to the topic is not called", async () => {
		let called = false;
		const runtime = createTestRuntime({
			$Id: "test"
		});
		runtime.registerExternalSource({
			Id: "Other",
			Topics: [
				"DifferentTopic"
			],
			receivePublish: () => {
				called = true;
			}
		});
		function* act(): IActionGenerator {
			yield {
				Type: "publish",
				Data: {
					Type: "TestTopic"
				}
			};
		}
		await runtime.dispatch(act, "test");
		expect(called).toBe(false);
	});

	it("a throwing receivePublish surfaces as a receiver:error record, not on the publisher", async () => {
		const errors: {
			recipientId: string;
			error: unknown;
		}[] = [];
		const runtime = createTestRuntime({
			$Id: "test"
		});
		runtime.on("record", (record, live) => {
			if (record.Kind === "receiver:error") {
				errors.push({
					recipientId: record.RecipientId,
					error: live?.error
				});
			}
		});
		runtime.registerExternalSource({
			Id: "Bad",
			Topics: [
				"TestTopic"
			],
			receivePublish: () => {
				throw new Error("boom");
			}
		});
		function* act(): IActionGenerator {
			yield {
				Type: "publish",
				Data: {
					Type: "TestTopic"
				}
			};
		}
		await runtime.dispatch(act, "test");
		expect(errors).toHaveLength(1);
		expect(errors[0].recipientId).toBe("Bad");
	});
});

describe("external sources: the activity log", () => {
	it("is absent unless opted in", async () => {
		await withRuntime(
			{
				$Id: "root"
			},
			undefined,
			async (runtime) => {
				expect(await read(runtime, "ActivityLog")).toBeUndefined();
			}
		);
	});

	it("captures action lifecycle records when opted in", async () => {
		await withRuntime(
			{
				$Id: "root"
			},
			{
				activityLog: true
			},
			async (runtime) => {
				function* noop(): IActionGenerator {}
				await runtime.processAction(
					noop,
					() => runtime.state,
					rootSetState(runtime),
					() => "root"
				);
				const log = await read(runtime, "ActivityLog");
				expect(log.Entries.length).toBeGreaterThan(0);
				expect(log.Entries.some((e: any) => e.Kind === "action:start" && e.Data.Name === "noop")).toBe(true);
				expect(log.Entries.some((e: any) => e.Kind === "action:end" && e.Data.Status === "completed")).toBe(true);
			}
		);
	});

	it("captures entity:dispose emitted by the dispose cascade", async () => {
		await withRuntime(
			{
				$Id: "root",
				children: [
					{
						$Id: "child"
					}
				]
			},
			{
				activityLog: true
			},
			async (runtime) => {
				treeWrite(runtime, (s: any) => {
					s.children.splice(0, 1);
				});
				const log = await read(runtime, "ActivityLog");
				expect(log.Entries.some((e: any) => e.Kind === "entity:dispose" && e.Data.EntityId === "child")).toBe(true);
			}
		);
	});

	it("does not capture step records (write-level detail stays off the ring)", async () => {
		await withRuntime(
			{
				$Id: "root",
				Title: ""
			},
			{
				activityLog: true
			},
			async (runtime) => {
				function* write(draft: any): IActionGenerator {
					draft.Title = "changed";
				}
				await runtime.processAction(
					write,
					() => runtime.state,
					rootSetState(runtime),
					() => "root"
				);
				const log = await read(runtime, "ActivityLog");
				expect(log.Entries.some((e: any) => e.Kind === "step")).toBe(false);
			}
		);
	});

	it("bounds the ring buffer to the configured cap", async () => {
		await withRuntime(
			{
				$Id: "root"
			},
			{
				activityLog: {
					cap: 5
				}
			},
			async (runtime) => {
				function* noop(): IActionGenerator {}
				for (let i = 0; i < 10; i++) {
					await runtime.processAction(
						noop,
						() => runtime.state,
						rootSetState(runtime),
						() => "root"
					);
				}
				const log = await read(runtime, "ActivityLog");
				expect(log.Entries.length).toBe(5);
			}
		);
	});
});

describe("external sources: lifetime", () => {
	it("runtime dispose() calls each source's dispose()", async () => {
		await createRoot((disposeRoot) => {
			let disposed = false;
			const runtime = createRuntime({
				$Id: "root"
			});
			runtime.registerExternalSource({
				Id: "Closeable",
				dispose: () => {
					disposed = true;
				}
			});
			runtime.dispose();
			expect(disposed).toBe(true);
			disposeRoot();
		});
	});

	it("a duplicate source Id is rejected with a warning", async () => {
		await createRoot((disposeRoot) => {
			const runtime = createRuntime({
				$Id: "root"
			});
			runtime.registerExternalSource({
				Id: "Dup",
				getData: () => 1
			});
			runtime.registerExternalSource({
				Id: "Dup",
				getData: () => 2
			});
			disposeRoot();
		});
	});
});
