import { describe, expect, it } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { parallel } from "../../src/Effects/parallel";

describe("Core effect specs", () => {
	describe("generateGuid", () => {
		it("yields an IGenerateGuidEffect with Type only", () => {
			const gen = generateGuid();
			const { value, done } = gen.next();

			expect(done).toBe(false);
			expect(value).toEqual({
				Type: "generateGuid"
			});
		});

		it("returns the handler result as a string", () => {
			const gen = generateGuid();
			gen.next();
			const { value, done } = gen.next("550e8400-e29b-41d4-a716-446655440000");

			expect(done).toBe(true);
			expect(value).toBe("550e8400-e29b-41d4-a716-446655440000");
		});
	});

	describe("parallel", () => {
		it("yields a parallel effect descriptor with Type and Generators[]", () => {
			function* a() {
				yield {
					Type: "noop"
				};
				return 1;
			}
			function* b() {
				yield {
					Type: "noop"
				};
				return 2;
			}

			const ga = a();
			const gb = b();
			const gen = parallel(ga, gb);
			const { value, done } = gen.next();

			expect(done).toBe(false);
			expect(value).toMatchObject({
				Type: "parallel"
			});
			expect(Array.isArray((value as any).Generators)).toBe(true);
			expect((value as any).Generators).toHaveLength(2);
			expect((value as any).Generators[0]).toBe(ga);
			expect((value as any).Generators[1]).toBe(gb);
		});

		it("returns the runtime-supplied array of resolved values", () => {
			function* a() {
				return 1;
			}
			function* b() {
				return 2;
			}

			const gen = parallel(a(), b());
			gen.next();
			const { value, done } = gen.next([
				1,
				2
			]);

			expect(done).toBe(true);
			expect(value).toEqual([
				1,
				2
			]);
		});
	});
});
