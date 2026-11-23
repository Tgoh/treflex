import type { IActionGenerator, IOpenGenerator, IRuntimeEventOf } from "../../src/index";
import type { IHistory } from "../../src/Resume/history";
import type { IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IHarness, IOrder, IShop } from "./resumeHarness";
import { describe, expect, it } from "vitest";
import { resumable } from "../../src/Resume/resumable";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { harness, shop, until, wait } from "./resumeHarness";

function* flow(draft: IOrder, label: string): IOpenGenerator {
	yield* open(wait(`flow ${label}`));
	draft.Note = label;
	yield* open(wait(`then ${label}`));
}
named(flow, "Envelope/Flow");
resumable(flow);

function* fetches(_draft: IOrder): IOpenGenerator {
	yield* open(wait("fetches"));
}
named(fetches, "Envelope/Fetches");

function* setQty(draft: IOrder, qty: number): IActionGenerator {
	draft.Qty = qty;
}

async function scenario(h: IHarness<IShop>, marked: boolean): Promise<string> {
	const { runtime } = h;
	void runtime.dispatch(fetches, "o2");
	if (marked) {
		void runtime.dispatch(flow, "o1", "a");
	}
	await until(() => h.waiting.length === (marked ? 2 : 1));
	await runtime.dispatch(setQty, "o1", 3);
	if (marked) {
		h.release("flow a");
		await until(() => h.waiting.some((w) => w.name === "then a"));
	}
	await runtime.dispatch(setQty, "o1", 4);
	return createSnapshot(runtime);
}

async function restored(json: string) {
	const diags: IRuntimeEventOf<"diag">[] = [];
	const { runtime, result } = await restoreRuntime<IShop>(json, {
		rootId: "shop",
		options: {
			build: "test",
			resume: true
		} as IRuntimeOptions,
		setup: (fresh) => {
			fresh.on("diag", (event) => {
				diags.push(event);
			});
		}
	});
	await Promise.resolve();
	const state = JSON.parse(JSON.stringify(runtime.state));
	runtime.dispose();
	return {
		state,
		result,
		diags
	};
}

describe("the history section", () => {
	it("leaves the envelope byte for byte the same with resume off as with the option absent", async () => {
		const absent = await scenario(
			harness(shop(), {
				resume: undefined
			}),
			true
		);
		const off = await scenario(
			harness(shop(), {
				resume: false
			}),
			true
		);
		expect(off).toBe(absent);
		expect(JSON.parse(absent).Histories).toBeUndefined();
	});

	it("leaves the envelope byte for byte the same with resume on and nothing marked in flight", async () => {
		const absent = await scenario(
			harness(shop(), {
				resume: undefined
			}),
			false
		);
		const on = await scenario(harness(shop()), false);
		expect(on).toBe(absent);
	});

	it("carries each in-flight marked action's history against its in-flight row, after the rows", async () => {
		const json = await scenario(harness(shop()), true);
		const envelope = JSON.parse(json);
		expect(Object.keys(envelope).at(-1)).toBe("Histories");
		const row = envelope.InFlight.find((entry: { Name: string }) => entry.Name === "Envelope/Flow");
		expect(row).toMatchObject({
			State: "open",
			EntityId: "o1"
		});
		const [history] = envelope.Histories as IHistory[];
		expect(envelope.Histories).toHaveLength(1);
		expect(history).toMatchObject({
			ActionId: row.ActionId,
			Args: [
				"a"
			],
			ArgsExact: true
		});
		expect(history!.Entries.map((entry) => entry.Kind)).toEqual([
			"effect",
			"other",
			"response",
			"step",
			"effect",
			"other"
		]);
		expect(history!.Entries[1]).toMatchObject({
			Kind: "other",
			Change: {
				Prev: 1,
				Value: 3,
				Landing: {
					EntityId: "o1",
					Path: [
						"Qty"
					]
				}
			}
		});
		expect(history!.Entries[5]).toMatchObject({
			Kind: "other",
			Change: {
				Prev: 3,
				Value: 4
			}
		});
	});

	it("is read by a restore with resume, which drops the flow for its wait and, without the section, for no history, loading the same tree", async () => {
		const json = await scenario(harness(shop()), true);
		const envelope = JSON.parse(json);
		expect(envelope.Histories).toHaveLength(1);
		const { Histories: _, ...without } = envelope;
		const withSection = await restored(json);
		const withoutSection = await restored(JSON.stringify(without));
		expect(withSection.state).toEqual(withoutSection.state);
		const reasons = (outcome: typeof withSection) =>
			outcome.result.dropped.map((drop) => [
				drop.name,
				drop.reason,
				drop.wait
			]);
		expect(reasons(withSection)).toEqual([
			[
				"Envelope/Fetches",
				"not-marked",
				undefined
			],
			[
				"Envelope/Flow",
				"not-idempotent",
				"Resume/Wait"
			]
		]);
		expect(reasons(withoutSection)).toEqual([
			[
				"Envelope/Fetches",
				"not-marked",
				undefined
			],
			[
				"Envelope/Flow",
				"no-history",
				undefined
			]
		]);
		expect(withSection.state.Orders.o1).toMatchObject({
			Qty: 4,
			Note: "a"
		});
	});
});
