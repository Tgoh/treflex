import type { IActionGenerator, IWithId } from "treflex";
import type { IUseComponentState } from "../src/Hooks/useComponentState";
import { createRuntime, StateCycleError } from "treflex";
import { rawOf } from "treflex/internal";
import { describe, expect, it, vi } from "vitest";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { useComponentState } from "../src/Hooks/useComponentState";
import { mount } from "./mount";

function mountLocal<T extends object>(
	factory: () => T
): {
	local: IUseComponentState<IWithId<T>>;
	dispose: () => void;
} {
	const runtime = createRuntime<any>({
		$Id: "root"
	});
	let local!: IUseComponentState<IWithId<T>>;
	const Inner = (): null => {
		local = useComponentState(factory);
		return null;
	};
	const { dispose } = mount(() => (
		<TreflexProvider value={runtime as any}>
			<Inner />
		</TreflexProvider>
	));
	return {
		local,
		dispose
	};
}

describe("useComponentState and a state cycle", () => {
	it("copies what a seed spreads from a tree's node, so a write to component state stays there", async () => {
		const other = createRuntime<any>({
			$Id: "other",
			Row: {
				Kid: {
					N: 1
				}
			}
		});
		const { local, dispose } = mountLocal(() => ({
			...other.state.Row
		}));
		await local.dispatch(function* (s: any): IActionGenerator {
			s.Kid.N = 2;
		});
		expect(other.state.Row.Kid.N).toBe(1);
		expect((local.state as any).Kid.N).toBe(2);
		expect(Object.isFrozen(rawOf(other.state.Row.Kid))).toBe(false);
		dispose();
	});

	it("refuses a seed holding a frozen cycle, thrown from the render that mounts it", () => {
		expect(() =>
			mountLocal(() => {
				const a: any = {};
				a.b = {
					a
				};
				Object.freeze(a.b);
				Object.freeze(a);
				return a;
			})
		).toThrow(/the factory's result is not plain: cycle at/);
	});

	it("refuses a loop as the tree does, undoing the slice, and takes the next write", async () => {
		const surfaced: unknown[] = [];
		const realQueue = globalThis.queueMicrotask;
		const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
			realQueue(() => {
				try {
					callback();
				} catch (error) {
					surfaced.push(error);
				}
			});
		});
		const { local, dispose } = mountLocal(() => ({
			A: {
				B: {} as Record<string, unknown>
			}
		}));
		await expect(
			local.dispatch(function* (s: any): IActionGenerator {
				s.A.B.Back = s.A;
			})
		).rejects.toBeInstanceOf(StateCycleError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(surfaced).toEqual([]);
		expect(local.state.A.B.Back).toBeUndefined();
		await local.dispatch(function* (s: any): IActionGenerator {
			s.A.B.X = 1;
			s.A.B.Back = null;
		});
		expect(local.state.A.B.Back).toBeNull();
		dispose();
		spy.mockRestore();
	});
});
