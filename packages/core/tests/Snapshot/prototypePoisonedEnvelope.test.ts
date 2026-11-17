import type { IActionGenerator } from "../../src/Types/IAction";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime, SnapshotRejectedError, SnapshotTooDeepError } from "../../src/Snapshot/index";
import { clone } from "../../src/Utility/valueCodec";
import { intrinsicChanges, minted, printIntrinsics } from "../testHelpers";

vi.mock("../../src/Runtime/createRuntime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/Runtime/createRuntime")>();
	return {
		...actual,
		createRuntime: vi.fn(actual.createRuntime)
	};
});

// Watched by descriptor slot, not by own-property name: a poisoned write
// can replace an existing intrinsic as easily as add a new one, and the
// name list is identical either way.
let intrinsics = printIntrinsics();

beforeEach(() => {
	intrinsics = printIntrinsics();
});

afterEach(() => {
	expect(intrinsicChanges(intrinsics, printIntrinsics())).toStrictEqual([]);
	vi.restoreAllMocks();
});

interface IRoot {
	$Id: string;
	Value: number;
}

const envelopeOf = (appState: unknown, rest: Record<string, unknown> = {}) =>
	JSON.stringify({
		Version: 7,
		AppState: appState,
		DataSources: [],
		Timers: [],
		InFlight: [],
		...rest
	});

const restore = (json: string, diags: any[] = []) =>
	restoreRuntime<any>(json, {
		rootId: "Root",
		options: {},
		setup: (runtime) => {
			runtime.on("diag", (event) => diags.push(event));
		}
	});

describe("an envelope carrying a __proto__ key", () => {
	it("loads end to end, with the key absent from the restored tree", async () => {
		const json = envelopeOf({
			$Id: "Root",
			Value: 1,
			Nested: JSON.parse('{"Ok":"kept","__proto__":{"polluted":"yes"}}')
		});

		const { runtime, result } = await restore(json);
		try {
			expect(result.dropped).toStrictEqual([]);
			expect(runtime.state.Value).toBe(1);
			expect(runtime.state.Nested.Ok).toBe("kept");
			expect(Object.hasOwn(runtime.state.Nested, "__proto__")).toBe(false);
			expect(Object.getPrototypeOf(runtime.state.Nested)).toBe(Object.prototype);
			expect(({} as any).polluted).toBeUndefined();
		} finally {
			runtime.dispose();
		}
	});

	it("at the root of the tree is absent too", async () => {
		const { runtime } = await restore(envelopeOf(JSON.parse('{"$Id":"Root","Value":1,"__proto__":{"polluted":"yes"}}')));
		try {
			expect(runtime.state.Value).toBe(1);
			expect(Object.hasOwn(runtime.state, "__proto__")).toBe(false);
			expect(({} as any).polluted).toBeUndefined();
		} finally {
			runtime.dispose();
		}
	});

	it("cannot reshape a journal clone", () => {
		const source = JSON.parse('{"Ok":1,"__proto__":{"polluted":"yes"}}');

		const copy = clone(source) as Record<string, unknown>;

		expect(copy.Ok).toBe(1);
		expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
		expect(({} as any).polluted).toBeUndefined();
	});

	it("still degrades a merely-corrupt envelope through the existing contracts", async () => {
		const diags: any[] = [];
		const { runtime, result } = await restore(
			envelopeOf(
				{
					$Id: "Root",
					Value: 7
				},
				{
					Timers: [
						null,
						"not-a-row"
					]
				}
			),
			diags
		);
		try {
			expect(result.dropped).toStrictEqual([]);
			expect(runtime.state.Value).toBe(7);
			expect(diags.some((d) => d.code === "restore/malformed-rows")).toBe(true);
		} finally {
			runtime.dispose();
		}
	});
});

describe("the ids a restored tree carries", () => {
	it("serves a minted ~ id to dispatch, with no diag", async () => {
		const a = createRuntime<
			IRoot & {
				Rows: {
					$Id: string;
					N: number;
				}[];
			}
		>({
			$Id: "Root",
			Value: 0,
			Rows: []
		});
		function* add(draft: any): IActionGenerator {
			draft.Rows.push(
				minted("row-1", {
					N: 1
				})
			);
		}
		await a.dispatch(add, "Root");
		const id = a.state.Rows[0].$Id;
		expect(id.startsWith("~")).toBe(true);
		const json = createSnapshot(a);
		a.dispose();

		const diags: any[] = [];
		const { runtime } = await restore(json, diags);
		try {
			function* bump(draft: { N: number }): IActionGenerator {
				draft.N++;
			}
			await runtime.dispatch(bump, id);
			expect(runtime.state.Rows[0].N).toBe(2);
			expect(diags).toStrictEqual([]);
		} finally {
			runtime.dispose();
		}
	});

	it.each([
		{
			name: "a non-string $Id",
			appState: {
				$Id: "Root",
				A: {
					$Id: 5
				}
			}
		},
		{
			name: "a duplicate $Id",
			appState: {
				$Id: "Root",
				A: {
					$Id: "row"
				},
				B: {
					$Id: "row"
				}
			}
		}
	])("rejects a tree holding $name with SnapshotRejectedError, building nothing", async ({ appState }) => {
		vi.mocked(createRuntime).mockClear();
		await expect(
			restoreRuntime(envelopeOf(appState), {
				rootId: "Root",
				options: {}
			})
		).rejects.toBeInstanceOf(SnapshotRejectedError);
		expect(createRuntime).not.toHaveBeenCalled();
	});
});

const deepText = (depth: number) => `${'{"A":'.repeat(depth)}1${"}".repeat(depth)}`;

const nested = (depth: number) =>
	`{"Version":7,"AppState":{"$Id":"Root","Keep":{"N":99},"Deep":${deepText(depth)}},"DataSources":[],"Timers":[],"InFlight":[]}`;

describe("a tree that cannot become a runtime", () => {
	it.each([
		1_000,
		3_300,
		20_000
	])("nested %i deep, rejects with SnapshotRejectedError, building nothing", async (depth) => {
		vi.mocked(createRuntime).mockClear();
		await expect(
			restoreRuntime(nested(depth), {
				rootId: "Root",
				options: {}
			})
		).rejects.toBeInstanceOf(SnapshotRejectedError);
		expect(createRuntime).not.toHaveBeenCalled();
	});

	it("nested to the bound, still restores", async () => {
		const { runtime } = await restoreRuntime<any>(nested(999), {
			rootId: "Root",
			options: {}
		});
		expect(runtime.state.Keep.N).toBe(99);
		runtime.dispose();
	});

	it("holding a number JSON reads as Infinity, rejects with SnapshotRejectedError", async () => {
		const json = `{"Version":7,"AppState":{"$Id":"Root","V":1e999},"DataSources":[],"Timers":[],"InFlight":[]}`;
		await expect(
			restoreRuntime(json, {
				rootId: "Root",
				options: {}
			})
		).rejects.toBeInstanceOf(SnapshotRejectedError);
	});
});

const deep = (depth: number): unknown => JSON.parse(deepText(depth));

describe("a row that nests too deep", () => {
	it.each([
		[
			"a timer's Payload",
			`"Timers":[{"Key":"Root/Tick","OwnerId":"Root","ReceiverId":"R","IntervalMs":100,"Payload":${deepText(20_000)}}]`
		],
		[
			"a resource's Params",
			`"Timers":[],"Resources":[{"Key":"Root/Feed","OwnerId":"Root","Params":{"Type":"deep/feed","Deep":${deepText(20_000)}},"ReceiverId":null,"ResumeFrom":null}]`
		]
	])("in %s rejects with SnapshotRejectedError, building nothing", async (_name, rows) => {
		vi.mocked(createRuntime).mockClear();
		await expect(
			restoreRuntime(`{"Version":7,"AppState":{"$Id":"Root"},"DataSources":[],"InFlight":[],${rows}}`, {
				rootId: "Root",
				options: {}
			})
		).rejects.toBeInstanceOf(SnapshotRejectedError);
		expect(createRuntime).not.toHaveBeenCalled();
	});
});

describe("createSnapshot against the same bound", () => {
	const live = (depth: number) =>
		createRuntime<any>(
			{
				$Id: "Root",
				Deep: deep(depth)
			},
			{}
		);

	it("refuses a tree deeper than restore accepts, with SnapshotTooDeepError", () => {
		const runtime = live(1_000);
		expect(() => createSnapshot(runtime)).toThrow(SnapshotTooDeepError);
		runtime.dispose();
	});

	it("writes a tree at the bound, which restores", async () => {
		const source = live(999);
		const json = createSnapshot(source);
		source.dispose();
		const { runtime } = await restoreRuntime(json, {
			rootId: "Root",
			options: {}
		});
		expect(JSON.parse(createSnapshot(runtime)).AppState).toStrictEqual(JSON.parse(json).AppState);
		runtime.dispose();
	});
});

describe("a boot that fails", () => {
	it("rethrows the construction's own error as itself, so the save isn't rejected", async () => {
		const failure = new Error("a retired option");
		vi.mocked(createRuntime).mockImplementationOnce(() => {
			throw failure;
		});
		const rejection = restoreRuntime(
			envelopeOf({
				$Id: "Root",
				Value: 1
			}),
			{
				rootId: "Root",
				options: {}
			}
		);
		await expect(rejection).rejects.toBe(failure);
	});

	it("rethrows setup's own error as itself, after the load's diags and then the dispose", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const failure = new Error("registration broke");
		const order: string[] = [];
		await expect(
			restoreRuntime(
				envelopeOf(
					{
						$Id: "Root",
						Value: 1
					},
					{
						Timers: [
							null
						]
					}
				),
				{
					rootId: "Root",
					options: {},
					setup: (runtime) => {
						const dispose = runtime.dispose;
						runtime.dispose = () => {
							order.push("dispose");
							dispose();
						};
						runtime.on("diag", (event) => order.push(event.code));
						throw failure;
					}
				}
			)
		).rejects.toBe(failure);
		expect(order).toStrictEqual([
			"restore/malformed-rows",
			"dispose"
		]);
	});
});
