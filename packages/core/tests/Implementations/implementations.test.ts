import { describe, expect, it } from "vitest";
import { implement as generateGuidImpl } from "../../src/Implementations/generateGuid";

describe("Infrastructure implementations", () => {
	describe("generateGuid implementation", () => {
		it("returns a valid UUID v4 string", () => {
			const result = generateGuidImpl.fn({
				Type: "generateGuid"
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		});

		it("returns unique values on each call", () => {
			const a = generateGuidImpl.fn({
				Type: "generateGuid"
			});
			const b = generateGuidImpl.fn({
				Type: "generateGuid"
			});

			expect(a).not.toBe(b);
		});
	});
});
