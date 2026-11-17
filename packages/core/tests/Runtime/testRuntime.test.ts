import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it, vi } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { publish as publishTyped } from "../../src/Effects/publish";
import { startTimer as startTimerTyped } from "../../src/Effects/startTimer";
import { select } from "../../src/Reads/select";
import { bind } from "../../src/Runtime/bind";
import { open } from "../../src/Runtime/open";
import { receiver as receiverTyped } from "../../src/Runtime/receiver";
import { guids } from "../../src/Testing/createTestRuntime";
import { createTestRuntime, minted, rawReceiver, rawWrite } from "../testHelpers";

const publish = publishTyped as unknown as (type: string, data?: any) => Generator<any, void, any>;
const startTimer = startTimerTyped as unknown as (
	entity: {
		$Id: string;
	},
	key: string,
	receiver: {
		Id: string;
	},
	intervalMs: number
) => Generator<any, void, any>;
const receiver = receiverTyped as unknown as <
	_T extends {
		$Id: string;
	}
>(
	id: string
) => (cases: Record<string, any>) => any;

type IBare = {
	$Id: string;
};
type IChild = {
	$Id: string;
	Heard: number;
};
type IWorld = {
	$Id: string;
	Children: IChild[];
};

const world = (): IWorld => ({
	$Id: "Root",
	Children: [
		{
			$Id: "child",
			Heard: 0
		}
	]
});

describe("the createTestRuntime preset", () => {
	it("refuses an effect nothing implements, in the registry's own words", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "Root"
			},
			{},
			{
				onError: () => {}
			}
		);
		function* act(_draft: object): IActionGenerator {
			yield {
				Type: "ghost"
			};
		}
		await expect(runtime.dispatch(act, "Root")).rejects.toThrow('No implementation registered for effect type: "ghost"');
	});

	it("leaves generateGuid unwired, so an unstubbed yield fails rather than drawing a value", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "Root"
			},
			{},
			{
				onError: () => {}
			}
		);
		function* act(_draft: object): IActionGenerator {
			yield {
				Type: "generateGuid"
			};
		}
		await expect(runtime.dispatch(act, "Root")).rejects.toThrow('No implementation registered for effect type: "generateGuid"');
	});

	it("names guids() in the refusal of an unstubbed generateGuid, and only there", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "Root"
			},
			{},
			{
				onError: () => {}
			}
		);
		function* mint(_draft: object): IActionGenerator {
			yield* generateGuid();
		}
		function* ghost(_draft: object): IActionGenerator {
			yield {
				Type: "ghost"
			};
		}
		await expect(runtime.dispatch(mint, "Root")).rejects.toThrow('createTestRuntime(seed, { generateGuid: guids("row") })');
		await expect(runtime.dispatch(ghost, "Root")).rejects.toThrow(/^No implementation registered for effect type: "ghost"$/);
	});

	it("lets a stub replace generateGuid, without an overwrite warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runtime = createTestRuntime(
			{
				$Id: "Root"
			},
			{
				generateGuid: guids("row")
			}
		);
		function* mint(_draft: object): IActionGenerator<string> {
			return yield* generateGuid();
		}
		await expect(runtime.dispatch(mint, "Root")).resolves.toBe("row-1");
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("refuses a stub for a runtime operation, which the runtime carries out itself", () => {
		expect(() =>
			createTestRuntime(
				{
					$Id: "Root"
				},
				{
					publish: () => {}
				}
			)
		).toThrow('"publish" is one of the runtime\'s own operations');
	});

	it("holds the scheduler: a timer row records and no handle is ever armed", async () => {
		vi.useFakeTimers();
		try {
			const runtime = createTestRuntime<IBare>({
				$Id: "Root"
			});
			const timers = (runtime as IRuntimeInternal<IBare>).get("runtime/timers");
			runtime.registerReceiver(rawReceiver("Ticker", [], function* ticker() {}));
			function* arm(draft: any): IActionGenerator {
				yield* startTimer(
					draft,
					"Tick",
					{
						Id: "Ticker"
					},
					5
				);
			}
			await runtime.dispatch(arm, "Root");
			expect(timers.entries()).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves reads natively: select composes in a selector and in an action", async () => {
		const runtime = createTestRuntime<IWorld>(world());
		let inner = 0;
		function* childCount(draft: IWorld) {
			inner++;
			return draft.Children.length;
		}
		function* summary(_draft: IWorld): Generator<any, string, any> {
			const n = yield* select(childCount);
			return `${n} children`;
		}
		expect(runtime.processSelector(summary as any, () => runtime.state)).toBe("1 children");
		expect(runtime.processSelector(summary as any, () => runtime.state)).toBe("1 children");
		expect(inner).toBe(2);

		function* report(_draft: IWorld): Generator<any, string, any> {
			return yield* select(summary);
		}
		expect(await runtime.dispatch(report, "Root")).toBe("1 children");
	});

	it("runs the dispose cascade: a removed child's binding stops being served", async () => {
		const runtime = createTestRuntime<IWorld>(world());
		const ChildReceiver = receiver<IChild>("PresetChildReceiver")({
			"Preset/Ping": function* (draft: IChild) {
				draft.Heard += 1;
			}
		});
		runtime.registerReceiver(ChildReceiver);

		function* setup(draft: IWorld): IActionGenerator {
			bind(draft.Children[0], ChildReceiver);
		}
		function* ping(_draft: IWorld): IActionGenerator {
			yield* publish("Preset/Ping");
		}
		function* drop(draft: IWorld): IActionGenerator {
			draft.Children = [];
		}

		await runtime.dispatch(setup, "Root");
		await runtime.dispatch(ping, "Root");
		await new Promise((r) => setTimeout(r, 0));
		expect(runtime.state.Children[0].Heard).toBe(1);

		const removed = runtime.state.Children[0];
		await runtime.dispatch(drop, "Root");
		await runtime.dispatch(ping, "Root");
		await new Promise((r) => setTimeout(r, 0));
		expect(removed.Heard).toBe(1);
	});

	it("dispose cascades the whole tree: one entity:dispose record per entity", async () => {
		const runtime = createTestRuntime<IWorld>(world());
		const disposed: string[] = [];
		runtime.on("record", (record: IRecord) => {
			if (record.Kind === "entity:dispose") disposed.push(record.EntityId);
		});
		runtime.dispose();
		expect(disposed).toEqual([
			"child",
			"Root"
		]);
	});

	it("marks detachment: a held reference to a replaced node throws", async () => {
		const runtime = createTestRuntime<IWorld>(
			world(),
			{
				gate: () => gate
			},
			{
				onError: () => {}
			}
		);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});

		function* gated(): IActionGenerator {
			yield {
				Type: "gate"
			};
		}
		function* story(draft: IWorld) {
			const child = draft.Children[0];
			yield* open(gated());
			child.Heard = 99;
		}
		function* refresh(draft: IWorld): IActionGenerator {
			draft.Children = [
				minted("other-child", {
					Heard: 0
				})
			];
		}

		const parked = runtime.dispatch(story, "Root");
		await Promise.resolve();
		await runtime.dispatch(refresh, "Root");
		release();
		await expect(parked).rejects.toThrow(/the node left the state tree/);
	});

	it("stops an action whose own node a raw write replaced while it is parked", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const runtime = createTestRuntime<IWorld>(world(), {
			gate: () => gate
		});

		function* story(draft: IChild): IActionGenerator {
			yield {
				Type: "gate"
			};
			draft.Heard = 99;
		}

		const parked = runtime.dispatch(story, "child");
		await Promise.resolve();
		rawWrite(runtime, (raw) => {
			raw.Children = [
				{
					$Id: "child",
					Heard: 0
				}
			];
		});
		release();
		await expect(parked).resolves.toBeUndefined();
		expect(runtime.state.Children[0].Heard).toBe(0);
	});
});
