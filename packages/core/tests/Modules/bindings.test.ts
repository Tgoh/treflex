import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IReceiverId } from "../../src/Types/IReceiver";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { entity, withoutIds } from "../../src/Effects/entity";
import { publish } from "../../src/Effects/publish";
import { publishToNearest } from "../../src/Effects/publishToNearest";
import { BindAfterWriteError, bind, unbind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime, SnapshotRejectedError } from "../../src/Snapshot/index";
import * as reactive from "../reactive";
import { minted, rootSetState } from "../testHelpers";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"Bindings/Ping": {};
		"Bindings/Other": {};
		"Bindings/Up": {};
	}
}

interface IRow extends IEntity {
	readonly $Receiver?: IReceiverId<IRow>;
	Heard: number;
	Other: number;
}

interface IShell extends IEntity {
	Heard: number;
	Errors: string[];
	Rows: IRow[];
	Panel: {
		$Id: string;
		Heard: number;
		Leaf: IEntity;
	};
}

const Rows = receiver<IRow>("BindingsRows")({
	*"Bindings/Ping"(draft) {
		draft.Heard++;
	}
});

const Shell = receiver<IShell>("BindingsShell")({
	*"Bindings/Up"(draft) {
		draft.Heard++;
	},
	*"Action/Error"(draft, e) {
		draft.Errors.push(String(e.Label));
	}
});

const Panel = receiver<IShell["Panel"]>("BindingsPanel")({
	*"Bindings/Other"(draft) {
		draft.Heard++;
	}
});

const seed = (): IShell => ({
	$Id: "Shell",
	Heard: 0,
	Errors: [],
	Rows: [],
	Panel: {
		$Id: "Panel",
		Heard: 0,
		Leaf: {
			$Id: "Leaf"
		}
	}
});

function run<A extends unknown[]>(
	runtime: IRuntime<IShell>,
	action: (draft: IShell, ...args: A) => IActionGenerator,
	...args: A
): Promise<unknown> {
	return runtime.processAction(
		action as any,
		() => runtime.state,
		rootSetState(runtime),
		() => "Shell",
		...args
	);
}

function* ping(): IActionGenerator {
	yield* publish("Bindings/Ping");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function withRuntime(body: (runtime: IRuntime<IShell>) => Promise<void>, initial: IShell = seed()): Promise<void> {
	await reactive.root(async (dispose) => {
		const runtime = createRuntime(initial, {
			onError: () => {}
		});
		try {
			await body(runtime);
		} finally {
			runtime.dispose();
			dispose();
		}
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a $Receiver entity hears its receiver's topics", () => {
	it("from $Receiver on the value entity() returned", async () => {
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Rows);
			function* add(draft: IShell): IActionGenerator {
				const row = yield* entity({
					Heard: 0,
					Other: 0,
					$Receiver: Rows.Id
				});
				draft.Rows.push(row);
			}
			await run(runtime, add);
			await run(runtime, ping);
			await settle();
			expect(runtime.state.Rows[0]!.Heard).toBe(1);
		});
	});

	it("from bind on the value before it's written, and from bind on the draft node", async () => {
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Rows);
			function* add(draft: IShell): IActionGenerator {
				const before = yield* entity({
					Heard: 0,
					Other: 0
				});
				bind(before, Rows);
				draft.Rows.push(before);
				draft.Rows.push(
					yield* entity({
						Heard: 0,
						Other: 0
					})
				);
				bind(draft.Rows[1]!, Rows);
			}
			await run(runtime, add);
			await run(runtime, ping);
			await settle();
			expect(runtime.state.Rows.map((row) => row.Heard)).toEqual([
				1,
				1
			]);
		});
	});

	it("from a seed, and only the topics the receiver has cases for", async () => {
		const initial = seed();
		initial.Rows.push({
			$Id: "Seeded",
			Heard: 0,
			Other: 0,
			$Receiver: Rows.Id
		});
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Rows);
			await run(runtime, ping);
			await run(runtime, function* () {
				yield* publish("Bindings/Other");
			});
			await settle();
			expect(runtime.state.Rows[0]!.Heard).toBe(1);
			expect(runtime.state.Rows[0]!.Other).toBe(0);
		}, initial);
	});

	it("stops hearing after unbind, and a removed entity hears nothing", async () => {
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Rows);
			function* add(draft: IShell): IActionGenerator {
				for (let i = 0; i < 2; i++) {
					draft.Rows.push(
						yield* entity({
							Heard: 0,
							Other: 0,
							$Receiver: Rows.Id
						})
					);
				}
			}
			await run(runtime, add);
			await run(runtime, function* (draft: IShell) {
				unbind(draft.Rows[0]!);
			});
			await run(runtime, ping);
			await settle();
			expect(runtime.state.Rows.map((row) => row.Heard)).toEqual([
				0,
				1
			]);
			const records: any[] = [];
			runtime.on("record", (record) => records.push(record));
			await run(runtime, function* (draft: IShell) {
				draft.Rows.splice(1, 1);
			});
			await run(runtime, ping);
			expect(records.filter((record) => record.Kind === "message:deliver").map((record) => record.RecipientIds)).toEqual([
				[]
			]);
		});
	});

	it("hears a topic a re-registration adds, without rebinding", async () => {
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Rows);
			await run(runtime, function* (draft: IShell) {
				draft.Rows.push(
					yield* entity({
						Heard: 0,
						Other: 0,
						$Receiver: Rows.Id
					})
				);
			});
			runtime.registerReceiver(
				receiver<IRow>("BindingsRows")({
					*"Bindings/Other"(draft) {
						draft.Other++;
					}
				})
			);
			await run(runtime, ping);
			await run(runtime, function* () {
				yield* publish("Bindings/Other");
			});
			await settle();
			expect(runtime.state.Rows[0]!.Heard).toBe(0);
			expect(runtime.state.Rows[0]!.Other).toBe(1);
		});
	});

	it("keeps a binding through entity({ ...row }), and withoutIds drops it", async () => {
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Rows);
			let plain: unknown;
			await run(runtime, function* (draft: IShell) {
				draft.Rows.push(
					yield* entity({
						Heard: 0,
						Other: 0,
						$Receiver: Rows.Id
					})
				);
			});
			await run(runtime, function* (draft: IShell) {
				draft.Rows.push(
					yield* entity({
						...draft.Rows[0]!
					})
				);
				plain = withoutIds(draft.Rows[0]!);
			});
			expect(plain).toEqual({
				Heard: 0,
				Other: 0
			});
			await run(runtime, ping);
			await settle();
			expect(runtime.state.Rows.map((row) => row.Heard)).toEqual([
				1,
				1
			]);
		});
	});
});

describe("publishToNearest reaches a bound entity through lineage", () => {
	it("walks past an ancestor whose receiver lacks the topic to the one that has it", async () => {
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Shell);
			runtime.registerReceiver(Panel);
			await run(runtime, function* (draft: IShell) {
				bind(draft, Shell);
				bind(draft.Panel, Panel);
			});
			await run(runtime, function* (draft: IShell) {
				yield* publishToNearest(draft.Panel.Leaf, "Bindings/Up");
			});
			await run(runtime, function* (draft: IShell) {
				yield* publishToNearest(draft.Panel.Leaf, "Bindings/Other");
			});
			await settle();
			expect(runtime.state.Heard).toBe(1);
			expect(runtime.state.Panel.Heard).toBe(1);
		});
	});
});

describe("Action/Error routes through a bound receiver", () => {
	function* fails(_draft: IEntity): IActionGenerator {
		throw new Error("boom");
	}

	async function failLeaf(runtime: IRuntime<IShell>): Promise<void> {
		const leaf = (runtime as any).resolveCell("Leaf");
		await runtime
			.processAction(
				fails,
				() => leaf.state,
				leaf.setState,
				() => "Leaf"
			)
			.catch(() => {});
		await settle();
	}

	it("reaches the nearest ancestor whose receiver has an Action/Error case", async () => {
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Shell);
			runtime.registerReceiver(Panel);
			await run(runtime, function* (draft: IShell) {
				bind(draft, Shell);
				bind(draft.Panel, Panel);
			});
			await failLeaf(runtime);
			expect(runtime.state.Errors).toEqual([
				"fails"
			]);
		});
	});

	it("passes an ancestor whose receiver isn't registered and goes on up", async () => {
		await withRuntime(async (runtime) => {
			runtime.registerReceiver(Shell);
			const records: any[] = [];
			runtime.on("record", (record) => records.push(record));
			await run(runtime, function* (draft: IShell) {
				bind(draft, Shell);
				bind(draft.Panel, Panel);
			});
			await failLeaf(runtime);
			expect(runtime.state.Errors).toEqual([
				"fails"
			]);
			const [dispatch] = records.filter((record) => record.Kind === "message:deliver" && record.Topic === "Action/Error");
			expect(dispatch.RecipientIds).toEqual([
				"Shell"
			]);
			expect(dispatch.UnresolvedIds).toEqual([
				"Panel"
			]);
		});
	});
});

describe("a binding survives snapshot and restore", () => {
	it("restores bound, hears again once its receiver registers, and reports one that never does", async () => {
		await withRuntime(async (a) => {
			a.registerReceiver(Rows);
			await run(a, function* (draft: IShell) {
				draft.Rows.push(
					yield* entity({
						Heard: 0,
						Other: 0,
						$Receiver: Rows.Id
					})
				);
				bind(draft, Shell);
			});
			const snapshot = createSnapshot(a);
			expect(JSON.parse(snapshot).Subscriptions).toBeUndefined();

			const { runtime: b, result } = await restoreRuntime<IShell>(snapshot, {
				rootId: "Shell",
				options: {},
				setup: (runtime) => runtime.registerReceiver(Rows)
			});
			try {
				expect(result.unresolved).toEqual([
					{
						ownerId: "Shell",
						key: null,
						receiverId: "BindingsShell"
					}
				]);
				await run(b, ping);
				await settle();
				expect(b.state.Rows[0]!.Heard).toBe(1);
			} finally {
				b.dispose();
			}
		});
	});

	it("rejects a snapshot holding a malformed $Receiver", async () => {
		await withRuntime(async (a) => {
			const envelope = JSON.parse(createSnapshot(a));
			envelope.AppState.Panel.$Receiver = 7;
			await expect(
				restoreRuntime<IShell>(JSON.stringify(envelope), {
					rootId: "Shell",
					options: {}
				})
			).rejects.toThrow(SnapshotRejectedError);
			envelope.AppState.Panel.$Receiver = "BindingsPanel";
			envelope.AppState.Plain = {
				$Receiver: "BindingsPanel"
			};
			await expect(
				restoreRuntime<IShell>(JSON.stringify(envelope), {
					rootId: "Shell",
					options: {}
				})
			).rejects.toThrow(/no \$Id/);
		});
	});

	it("refuses an envelope of the format before bindings", async () => {
		await withRuntime(async (a) => {
			const envelope = JSON.parse(createSnapshot(a));
			envelope.Version = 6;
			envelope.Subscriptions = [];
			await expect(
				restoreRuntime<IShell>(JSON.stringify(envelope), {
					rootId: "Shell",
					options: {}
				})
			).rejects.toThrow(SnapshotRejectedError);
		});
	});
});

describe("bind on the value entity() returned, after it was written", () => {
	it("is a BindAfterWriteError naming both fixes, for bind and unbind", async () => {
		await withRuntime(async (runtime) => {
			const errors: unknown[] = [];
			await run(runtime, function* (draft: IShell) {
				const row = yield* entity({
					Heard: 0,
					Other: 0
				});
				draft.Rows.push(row);
				for (const write of [
					() => bind(row, Rows),
					() => unbind(row)
				]) {
					try {
						write();
					} catch (error) {
						errors.push(error);
					}
				}
			});
			expect(errors).toHaveLength(2);
			expect(errors[0]).toBeInstanceOf(BindAfterWriteError);
			expect((errors[0] as Error).message).toMatch(/Put \$Receiver: Receiver\.Id on the value.*call bind on the draft node/);
			expect(errors[1]).toBeInstanceOf(BindAfterWriteError);
			expect(runtime.state.Rows[0]).not.toHaveProperty("$Receiver");
		});
	});

	it("refuses a view and a node with no $Id", async () => {
		await withRuntime(async (runtime) => {
			expect(() => bind(runtime.state, Shell)).toThrow(/view of "Shell", which is read-only/);
			expect(() => bind({} as IEntity, Shell as never)).toThrow(/no \$Id/);
		});
	});
});

describe("a malformed $Receiver is refused at entry", () => {
	it("in a seed", () => {
		const nonString = seed() as any;
		nonString.Panel.$Receiver = 7;
		expect(() => createRuntime(nonString)).toThrow(/a \$Receiver of type "number" at \[Panel\]/);
		const noId = seed() as any;
		noId.Loose = {
			$Receiver: "BindingsPanel"
		};
		expect(() => createRuntime(noId)).toThrow(/on a node with no \$Id/);
	});

	it("in a write, which is refused and leaves state as it was", async () => {
		await withRuntime(async (runtime) => {
			const failures: unknown[] = [];
			for (const write of [
				(draft: any) => {
					draft.Loose = {
						$Receiver: "BindingsPanel"
					};
				},
				(draft: any) => {
					draft.Rows.push(
						minted("bad", {
							$Receiver: 7
						})
					);
				}
			]) {
				await run(runtime, function* (draft: IShell) {
					write(draft);
				}).catch((error) => failures.push(error));
			}
			expect(failures).toHaveLength(2);
			expect(runtime.state.Rows).toEqual([]);
			expect(runtime.state).not.toHaveProperty("Loose");
		});
	});

	it("as a plain write that changes a binding, while the same value and bind pass", async () => {
		await withRuntime(async (runtime) => {
			const failures: unknown[] = [];
			await run(runtime, function* (draft: IShell) {
				bind(draft.Panel, Panel);
			});
			for (const write of [
				(draft: any) => {
					draft.Panel.$Receiver = "BindingsShell";
				},
				(draft: any) => {
					Object.assign(draft.Panel, {
						$Receiver: "BindingsShell"
					});
				},
				(draft: any) => {
					delete draft.Panel.$Receiver;
				},
				(draft: any) => {
					draft.Rows.$Receiver = "BindingsRows";
				}
			]) {
				await run(runtime, function* (draft: IShell) {
					write(draft);
				}).catch((error) => failures.push(error));
			}
			expect(failures).toHaveLength(4);
			expect(failures.every((error) => error instanceof TypeError)).toBe(true);
			await run(runtime, function* (draft: any) {
				draft.Panel.$Receiver = "BindingsPanel";
				Object.assign(draft.Panel, {
					...draft.Panel
				});
			});
			expect((runtime.state.Panel as any).$Receiver).toBe("BindingsPanel");
		});
	});
});

describe("types", () => {
	it("brands a receiver id with its state, so $Receiver on a value is checked as bind is", () => {
		expectTypeOf(Rows.Id).toExtend<string>();
		function* typed(): IActionGenerator {
			yield* entity({
				Heard: 0,
				Other: 0,
				$Receiver: Rows.Id
			});
			// @ts-expect-error the value lacks a field the receiver's state has
			yield* entity({
				Heard: 0,
				$Receiver: Rows.Id
			});
			yield* entity({
				Heard: 0,
				Other: 0,
				// @ts-expect-error a plain string isn't a receiver id
				$Receiver: "BindingsRows"
			});
			yield* entity<IRow>({
				Heard: 0,
				Other: 0,
				$Receiver: Rows.Id
			});
			yield* entity<IRow>({
				Heard: 0,
				Other: 0,
				// @ts-expect-error a receiver for another state
				$Receiver: Panel.Id
			});
		}
		function* binds(draft: IShell): IActionGenerator {
			bind(draft, Shell);
			// @ts-expect-error a receiver for another state
			bind(draft.Rows[0]!, Shell);
		}
		void typed;
		void binds;
	});
});

interface IItem extends IEntity {
	readonly $Receiver?: IReceiverId<IItem>;
	Name: string;
}

interface IList extends IEntity {
	Items: IItem[];
}

describe("delivery within a receiver follows the tree", () => {
	const heard: string[] = [];
	const Items = receiver<IItem>("BindingsItems")({
		*"Bindings/Ping"(draft) {
			heard.push(draft.Name);
		}
	});
	const item = (name: string) =>
		entity({
			Name: name,
			$Receiver: Items.Id
		});

	function* pushBoth(draft: IList): IActionGenerator {
		draft.Items.push(yield* item("A"));
		draft.Items.push(yield* item("B"));
	}
	const histories: Record<string, ((draft: IList) => IActionGenerator)[]> = {
		"pushed in order": [
			pushBoth
		],
		"B pushed, then A unshifted": [
			function* (draft) {
				draft.Items.push(yield* item("B"));
			},
			function* (draft) {
				draft.Items.unshift(yield* item("A"));
			}
		],
		"A unbound and bound again": [
			pushBoth,
			function* (draft) {
				unbind(draft.Items[0]!);
			},
			function* (draft) {
				bind(draft.Items[0]!, Items);
			}
		]
	};

	async function order(runtime: IRuntime<IList>): Promise<string[]> {
		heard.length = 0;
		await runtime.dispatch(function* () {
			yield* publish("Bindings/Ping");
		}, "List");
		await settle();
		return [
			...heard
		];
	}

	it.each(Object.keys(histories))("is one order whatever the history, %s, and a restore delivers the same", async (history) => {
		const live = createRuntime<IList>({
			$Id: "List",
			Items: []
		});
		live.registerReceiver(Items);
		for (const step of histories[history]!) {
			await live.dispatch(step, "List");
		}
		expect(live.state.Items.map((entry) => entry.Name)).toEqual([
			"A",
			"B"
		]);
		expect(await order(live)).toEqual([
			"A",
			"B"
		]);
		const { runtime: restored } = await restoreRuntime<IList>(createSnapshot(live), {
			rootId: "List",
			options: {},
			setup: (runtime) => runtime.registerReceiver(Items)
		});
		expect(await order(restored)).toEqual([
			"A",
			"B"
		]);
		live.dispose();
		restored.dispose();
	});
});

describe("the landing diag waits a microtask", () => {
	const seeded = (): IShell => {
		const initial = seed();
		initial.Rows.push({
			$Id: "Seeded",
			Heard: 0,
			Other: 0,
			$Receiver: Rows.Id
		});
		return initial;
	};
	const unresolved = (codes: string[]) => codes.filter((code) => code === "receiver/unresolved");

	it("so a seeded binding whose receiver registers straight after createRuntime reports nothing", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const registered = createRuntime(seeded());
		const codes: string[] = [];
		registered.on("diag", (event) => codes.push(event.code));
		registered.registerReceiver(Rows);
		const unregistered = createRuntime(seeded());
		const missing: string[] = [];
		unregistered.on("diag", (event) => missing.push(event.code));
		await settle();
		expect(unresolved(codes)).toEqual([]);
		expect(unresolved(missing)).toHaveLength(1);
		registered.dispose();
		unregistered.dispose();
	});

	it("so a restore whose setup registers the receiver reports nothing", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const a = createRuntime(seeded());
		a.registerReceiver(Rows);
		const snapshot = createSnapshot(a);
		a.dispose();
		const restoreHearing = async (register: boolean): Promise<string[]> => {
			const codes: string[] = [];
			const { runtime } = await restoreRuntime<IShell>(snapshot, {
				rootId: "Shell",
				options: {},
				setup: (runtime) => {
					runtime.on("diag", (event) => codes.push(event.code));
					if (register) {
						runtime.registerReceiver(Rows);
					}
				}
			});
			await settle();
			runtime.dispose();
			return codes;
		};
		expect(unresolved(await restoreHearing(true))).toEqual([]);
		expect(unresolved(await restoreHearing(false))).toHaveLength(1);
	});
});

describe("a component seed carrying $Receiver at its root", () => {
	interface IWidget extends IEntity {
		readonly $Receiver?: IReceiverId<IWidget>;
		Heard: number;
	}
	const Widget = receiver<IWidget>("BindingsWidget")({
		*"Bindings/Ping"(draft) {
			draft.Heard++;
		}
	});

	it("hears a publish, stops on unmount, and hears again after a remount", async () => {
		await withRuntime(async (runtime) => {
			const internal = runtime as IRuntimeInternal<IShell>;
			runtime.registerReceiver(Widget);
			const { id, raw } = internal.seedComponent(
				{
					Heard: 0,
					$Receiver: Widget.Id
				},
				"test"
			);
			const heard = () => (raw as IWidget).Heard;
			expect(internal.seatComponent(undefined, raw)).toBe(true);
			await run(runtime, ping);
			await settle();
			expect(heard()).toBe(1);
			expect(internal.unmountComponent(id)).toBe(true);
			await run(runtime, ping);
			await settle();
			expect(heard()).toBe(1);
			expect(internal.seatComponent(undefined, raw)).toBe(true);
			await run(runtime, ping);
			await settle();
			expect(heard()).toBe(2);
		});
	});
});
