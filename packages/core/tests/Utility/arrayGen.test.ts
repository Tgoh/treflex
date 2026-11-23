import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { describe, expect, it } from "vitest";
import { entity } from "../../src/Effects/entity";
import { inFlight } from "../../src/Runtime/arrivals";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { createTestRuntime, guids, settled } from "../../src/Testing/createTestRuntime";
import { filterGen, mapGen, someGen } from "../../src/Utility/arrayGen";
import * as reactive from "../reactive";

interface IRow extends IEntity {
	Name: string;
}

interface IBoard extends IEntity {
	Rows: IRow[];
	Names: string[];
}

function seed(): IBoard {
	return {
		$Id: "board",
		Rows: [
			{
				$Id: "r1",
				Name: "one"
			},
			{
				$Id: "r2",
				Name: "two"
			}
		],
		Names: []
	};
}

function* wait(): Generator<any, unknown, any> {
	return yield {
		Type: "wait"
	};
}

function* save(_draft: IRow): IActionGenerator {
	yield* wait();
}

function* rowBusy(row: IRow): ISelectorGenerator<boolean> {
	return yield* inFlight(save, row);
}

function* busyNames(draft: IBoard): ISelectorGenerator<string[]> {
	return (yield* filterGen(draft.Rows, rowBusy)).map((row) => row.Name);
}

function* anyBusy(draft: IBoard): ISelectorGenerator<boolean> {
	return yield* someGen(draft.Rows, (row) => inFlight(save, row));
}

function* addRow(draft: IBoard): IActionGenerator {
	draft.Rows.push(
		yield* entity({
			Name: "three"
		})
	);
}

function build() {
	const runtime = createRuntime<IBoard>(seed(), {
		onError: () => {}
	}) as IRuntimeInternal<IBoard>;
	const releases: (() => void)[] = [];
	runtime.registerImplementation(
		"wait",
		() =>
			new Promise<void>((resolve) => {
				releases.push(resolve);
			})
	);
	return {
		runtime,
		releases
	};
}

function finish<R>(generator: Generator<unknown, R, unknown>): R {
	const step = generator.next();
	if (!step.done) {
		throw new Error("the generator yielded");
	}
	return step.value;
}

describe("mapGen, filterGen and someGen", () => {
	it("re-derive a selector a view reads as work on a row starts and ends, and as rows arrive", async () => {
		const { runtime, releases } = build();
		await reactive.root(async (dispose) => {
			const names: string[][] = [];
			const any: boolean[] = [];
			reactive.effect(() => {
				names.push(runtime.runSelector(busyNames, () => runtime.state));
			});
			reactive.effect(() => {
				any.push(runtime.runSelector(anyBusy, () => runtime.state));
			});
			await settled();
			const saving = runtime.dispatch(save, "r2");
			await settled();
			releases.shift()!();
			await saving;
			await settled();
			await runtime.dispatch(addRow, "board");
			await settled();
			const third = runtime.state.Rows[2]!.$Id;
			const savingThird = runtime.dispatch(save, third);
			await settled();
			releases.shift()!();
			await savingThird;
			await settled();
			expect(names).toEqual([
				[],
				[
					"two"
				],
				[],
				[],
				[
					"three"
				],
				[]
			]);
			expect(any).toEqual([
				false,
				true,
				false,
				true,
				false
			]);
			dispose();
		});
	});

	it("run each item's callback to its end before the next, effects included, and pass the index", async () => {
		const { runtime, releases } = build();
		const order: string[] = [];
		function* each(draft: IBoard): IActionGenerator<number[]> {
			const indexes = yield* mapGen(draft.Rows, function* (row, index) {
				order.push(`start ${row.Name}`);
				yield* wait();
				order.push(`end ${row.Name}`);
				return index;
			});
			draft.Names = draft.Rows.map((row) => row.Name);
			return indexes;
		}
		const done = runtime.dispatch(each, "board");
		await settled();
		releases.shift()!();
		await settled();
		releases.shift()!();
		expect(await done).toEqual([
			0,
			1
		]);
		expect(order).toEqual([
			"start one",
			"end one",
			"start two",
			"end two"
		]);
		expect(runtime.state.Names).toEqual([
			"one",
			"two"
		]);
	});

	it("mint an entity per item in an action", async () => {
		const runtime = createTestRuntime<IBoard>(seed(), {
			generateGuid: guids("row")
		});
		function* load(draft: IBoard, names: string[]): IActionGenerator {
			draft.Rows = yield* mapGen(names, (name) =>
				entity({
					Name: name
				})
			);
		}
		await runtime.dispatch(load, "board", [
			"a",
			"b"
		]);
		expect(
			runtime.state.Rows.map((row) => [
				row.$Id,
				row.Name
			])
		).toEqual([
			[
				"~row-1",
				"a"
			],
			[
				"~row-2",
				"b"
			]
		]);
	});

	it("someGen stops at the first true", () => {
		const seen: number[] = [];
		const found = finish(
			someGen(
				[
					1,
					2,
					3
				],
				function* (n) {
					seen.push(n);
					return n === 2;
				}
			)
		);
		expect(found).toBe(true);
		expect(seen).toEqual([
			1,
			2
		]);
		expect(
			finish(
				someGen([] as number[], function* () {
					return true;
				})
			)
		).toBe(false);
	});

	it("read the length once, so an item added during the loop isn't visited, and skip an item removed before its turn", () => {
		const items = [
			1,
			2,
			3
		];
		const mapped = finish(
			mapGen(items, function* (n) {
				if (n === 1) {
					items.push(4);
				}
				return n * 10;
			})
		);
		expect(mapped).toEqual([
			10,
			20,
			30
		]);
		const shrinking = [
			1,
			2,
			3
		];
		const kept = finish(
			filterGen(shrinking, function* (n) {
				if (n === 1) {
					shrinking.pop();
				}
				return true;
			})
		);
		expect(kept).toEqual([
			1,
			2
		]);
		const visited: number[] = [];
		const shrinkingSome = [
			1,
			2,
			3
		];
		finish(
			someGen(shrinkingSome, function* (n) {
				visited.push(n);
				shrinkingSome.length = 1;
				return false;
			})
		);
		expect(visited).toEqual([
			1
		]);
		const shrinkingMap = [
			1,
			2,
			3
		];
		const sparse = finish(
			mapGen(shrinkingMap, function* (n) {
				shrinkingMap.length = 2;
				return n;
			})
		);
		expect(sparse).toHaveLength(3);
		expect(2 in sparse).toBe(false);
	});

	it("mapGen's empty slot for a removed row is refused when written to state", async () => {
		const { runtime } = build();
		function* names(draft: IBoard): IActionGenerator {
			draft.Names = yield* mapGen(draft.Rows, function* (row) {
				draft.Rows.splice(1, 1);
				return row.Name;
			});
		}
		const refused = await runtime.dispatch(names, "board").catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(NonPlainDataError);
		expect((refused as NonPlainDataError).kind).toBe("undefined array element");
	});
});
