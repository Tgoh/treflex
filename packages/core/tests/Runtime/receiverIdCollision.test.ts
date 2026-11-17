import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it, vi } from "vitest";
import { createReceiverRegistry } from "../../src/Runtime/createReceiverRegistry";
import { rawReceiver } from "../testHelpers";

// DEV is a module constant, mocked off for this file. The dev side, same
// shape and no diag, is in createReceiverRegistry.test.ts.
vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

describe("a receiver id registered twice in production", () => {
	it("emits receiver/id-collision naming the id, and the later handle wins", () => {
		const diags: IRuntimeEventOf<"diag">[] = [];
		const registry = createReceiverRegistry((event) => diags.push(event));
		const fromCart = function* () {};
		const fromCheckout = function* () {};

		registry.register(rawReceiver("CartReceiver", [], fromCart));
		registry.register(rawReceiver("CartReceiver", [], fromCheckout));

		expect(diags.map((d) => d.code)).toEqual([
			"receiver/id-collision"
		]);
		expect(diags[0].data).toEqual({
			id: "CartReceiver"
		});
		expect(registry.get("CartReceiver")).toBe(fromCheckout);
	});

	it("says nothing for the same handle registered twice", () => {
		const diags: IRuntimeEventOf<"diag">[] = [];
		const registry = createReceiverRegistry((event) => diags.push(event));
		const handle = function* () {};

		registry.register(rawReceiver("CartReceiver", [], handle));
		registry.register(rawReceiver("CartReceiver", [], handle));

		expect(diags).toEqual([]);
	});
});
