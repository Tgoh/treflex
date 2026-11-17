import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it, vi } from "vitest";
import { setViewDiagEmitter, view } from "../../src/Runtime/viewProxy";

// DEV is a module constant, so this file mocks it off for the whole file.
vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

function captureDiags(): {
	seen: IRuntimeEventOf<"diag">[];
	release: () => void;
} {
	const seen: IRuntimeEventOf<"diag">[] = [];
	const release = setViewDiagEmitter((event) => seen.push(event));
	return {
		seen,
		release
	};
}

describe("view proxy writes in a production build", () => {
	it("refuses the write and reports state/view-write for each refusal", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { seen, release } = captureDiags();
		try {
			const raw = {
				a: 1,
				b: 2
			};
			const v = view(raw) as any;

			expect(() => {
				v.a = 99;
			}).toThrow(/read-only outside a dispatch/);
			expect(raw.a).toBe(1);

			const hits = seen.filter((d) => d.code === "state/view-write");
			expect(hits).toHaveLength(1);
			expect(hits[0].severity).toBe("warn");
			expect(hits[0].data?.key).toBe("a");
			expect(hits[0].data?.verb).toBe("write");

			expect(() => {
				delete v.a;
			}).toThrow(/read-only outside a dispatch/);
			expect(seen.filter((d) => d.code === "state/view-write")).toHaveLength(2);
			expect(raw).toEqual({
				a: 1,
				b: 2
			});
		} finally {
			release();
			warn.mockRestore();
		}
	});
});
