import type { IActionGenerator, IOpenGenerator } from "../../src/index";
import type { IOrder } from "./resumeHarness";
import { describe, expect, it, vi } from "vitest";
import { resumable } from "../../src/Resume/resumable";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { harness, shop, until, wait } from "./resumeHarness";

const breaks = vi.hoisted(() => ({
	next: false
}));

vi.mock(import("../../src/Resume/fold"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		appendOther: (...args: Parameters<typeof original.appendOther>) => {
			if (breaks.next) {
				breaks.next = false;
				throw new Error("keeper broke");
			}
			return original.appendOther(...args);
		}
	};
});

function* waits(_draft: IOrder, name: string): IOpenGenerator {
	yield* open(wait(name));
}
named(waits, "KeeperFailure/Waits");
resumable(waits);

function* setNote(draft: IOrder, note: string): IActionGenerator {
	draft.Note = note;
}

describe("a keeper failure", () => {
	it("marks every history it could have touched not whole, and is reported", async () => {
		const h = harness(shop());
		const { runtime } = h;
		void runtime.dispatch(waits, "o1", "one");
		void runtime.dispatch(waits, "o2", "two");
		await until(() => h.waiting.length === 2);
		breaks.next = true;
		await runtime.dispatch(setNote, "o1", "lost");
		await runtime.dispatch(setNote, "o2", "after");
		const envelope = h.envelope();
		expect(envelope.Histories).toEqual(
			envelope.InFlight.map((row) => ({
				ActionId: row.ActionId,
				Unusable: "not-whole",
				Unlisted: "none",
				UnlistedLineage: [],
				Deliveries: []
			}))
		);
		expect(h.diags.map((diag) => diag.code)).toEqual([
			"runtime/callback-threw"
		]);
		expect(runtime.state.Orders.o1!.Note).toBe("lost");
		runtime.dispose();
	});
});
