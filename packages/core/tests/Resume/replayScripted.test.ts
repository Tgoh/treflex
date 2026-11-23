import type { IActionGenerator, IEntity, IOpenGenerator } from "../../src/index";
import type { IScriptStep } from "./replayScript";
import { describe, expect, it } from "vitest";
import { ask } from "../../src/Effects/ask";
import { generateGuid } from "../../src/Effects/generateGuid";
import { resumable } from "../../src/Resume/resumable";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { PAY } from "./replayHarness";
import { expectEngineFacts, playScript, restoreAt } from "./replayScript";
import { wait } from "./resumeHarness";

interface ILine extends IEntity {
	Qty: number;
}

interface IOrder extends IEntity {
	Qty: number;
	Key: string;
	Note: string;
	Receipt: string;
	Rounds: number;
	Lines: Record<string, ILine>;
}

interface IShop extends IEntity {
	Orders: Record<string, IOrder>;
}

function seed(): IShop {
	return {
		$Id: "shop",
		Orders: {
			o1: {
				$Id: "o1",
				Qty: 1,
				Key: "",
				Note: "",
				Receipt: "",
				Rounds: 0,
				Lines: {
					"o1-l1": {
						$Id: "o1-l1",
						Qty: 1
					}
				}
			}
		}
	};
}

function* pay(name: string): IActionGenerator<any> {
	return yield {
		Type: PAY,
		Name: name
	} as never;
}

function* checkout(d: IOrder): IOpenGenerator {
	const address = yield* open(
		ask<string>(d, {
			Path: "Address"
		})
	);
	if (!address) {
		return;
	}
	const quote = yield* open(wait("quote"));
	const option = yield* open(
		ask<string>(d, {
			Path: "Option",
			Options: quote
		})
	);
	if (!option) {
		return;
	}
	d.Key = yield* generateGuid();
	d.Note = `${address}/${option}/${d.Qty}`;
	yield* wait("reserve");
	for (let round = 0; ; round++) {
		const confirmed = yield* open(
			ask<boolean>(d, {
				Path: "Confirm",
				Round: round,
				Qty: d.Qty
			})
		);
		d.Rounds = round + 1;
		if (confirmed) {
			break;
		}
	}
	d.Receipt = yield* pay("pay");
}
named(checkout, "Replay/Checkout");
resumable(checkout);

function* setQty(d: IOrder, qty: number): IActionGenerator {
	d.Qty = qty;
}
named(setQty, "Replay/SetQty");
resumable(setQty);

function* setLine(d: ILine, qty: number): IActionGenerator {
	d.Qty = qty;
}

const o1 = (state: IShop) => state.Orders.o1;

const STEPS: IScriptStep[] = [
	(d) => d.dispatch(checkout, "o1"),
	(d) => d.dispatch(setQty, "o1", 5),
	(d) => d.dispatch(setLine, "o1-l1", 9),
	(d) => d.answer(o1, "Address", "home"),
	(d) => d.dispatch(setQty, "o1", 6),
	(d) => d.dispatch(setLine, "o1-l1", 10),
	(d) =>
		d.release("quote", [
			"fast",
			"slow"
		]),
	(d) => d.dispatch(setQty, "o1", 7),
	(d) => d.answer(o1, "Option", "fast"),
	(d) => d.dispatch(setQty, "o1", 8),
	(d) => d.release("reserve"),
	(d) => d.dispatch(setLine, "o1-l1", 11),
	(d) => d.answer(o1, "Confirm", false),
	(d) => d.dispatch(setQty, "o1", 9),
	(d) => d.answer(o1, "Confirm", true),
	(d) => d.release("pay", "r1")
];

describe("a resumed flow, at every point it is parked", () => {
	it("ends as the uninterrupted run where it resumes, and as a data-only restore where it drops", async () => {
		const script = await playScript(seed(), STEPS, [
			"Replay/Checkout",
			"Replay/SetQty"
		]);
		const states = new Map<string, number>();
		let resumedAtPay = 0;
		for (const point of script.points) {
			const flow = point.inFlight.find((row) => row.Name === "Replay/Checkout");
			const restored = await restoreAt(point, STEPS, {
				engine: true
			});
			expectEngineFacts(point, restored);
			const engine = restored.engine!;
			const caughtAtPay = flow !== undefined && point.at === STEPS.length - 2;
			if (caughtAtPay) {
				resumedAtPay++;
				expect(engine.dropped.map((drop) => drop.reason)).toEqual([
					"not-idempotent"
				]);
				const dataOnly = await restoreAt(point, STEPS, {
					engine: false
				});
				expect(restored.end).toEqual(dataOnly.end);
				continue;
			}
			expect(engine.dropped).toEqual([]);
			for (const row of point.inFlight) {
				const key = row.State!;
				states.set(key, (states.get(key) ?? 0) + 1);
			}
			expect(restored.end).toEqual(script.endFrom(point));
		}
		expect(resumedAtPay).toBe(1);
		expect(Object.fromEntries(states)).toEqual({
			open: expect.any(Number),
			holding: expect.any(Number),
			queued: 1
		});
		expect(script.points.length).toBe(STEPS.length - 1);
	});
});
