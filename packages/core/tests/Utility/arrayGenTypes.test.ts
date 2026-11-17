import type { IActionGenerator, IOpenGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRead, ISelectorGenerator } from "../../src/Types/ISelector";
import { describe, expect, expectTypeOf, it } from "vitest";
import { entity, type IWithId } from "../../src/Effects/entity";
import { generateGuid } from "../../src/Effects/generateGuid";
import { start } from "../../src/Effects/start";
import { inFlight } from "../../src/Runtime/arrivals";
import { open } from "../../src/Runtime/open";
import { filterGen, mapGen, someGen } from "../../src/Utility/arrayGen";

// Compile-time pins: every @ts-expect-error is a case the compiler must refuse.

interface IRow extends IEntity {
	Name: string;
	Ready: boolean;
}

interface IBoard extends IEntity {
	Rows: IRow[];
}

declare function save(draft: IRow): IActionGenerator;
declare function rowBusy(row: IRow): ISelectorGenerator<boolean>;
declare function mint<W extends object>(wire: W): IActionGenerator<W & IEntity>;
declare const frozenRows: readonly IRow[];

function* selectors(draft: IBoard): ISelectorGenerator<void> {
	expectTypeOf(yield* filterGen(draft.Rows, (row) => inFlight(save, row))).toEqualTypeOf<IRow[]>();
	expectTypeOf(yield* filterGen(frozenRows, rowBusy)).toEqualTypeOf<IRow[]>();
	expectTypeOf(
		yield* filterGen(draft.Rows, function* (row, index) {
			expectTypeOf(index).toEqualTypeOf<number>();
			return row.Ready && (yield* inFlight(save, row));
		})
	).toEqualTypeOf<IRow[]>();
	expectTypeOf(yield* someGen(draft.Rows, rowBusy)).toEqualTypeOf<boolean>();
	expectTypeOf(
		yield* mapGen(draft.Rows, function* (row) {
			return {
				Id: row.$Id,
				Busy: yield* inFlight(save, row)
			};
		})
	).toEqualTypeOf<
		{
			Id: string;
			Busy: boolean;
		}[]
	>();

	// @ts-expect-error a predicate's generator returns a boolean, not the read's generator
	yield* filterGen(draft.Rows, function* (row) {
		return inFlight(save, row);
	});
	// @ts-expect-error a predicate's generator returns a boolean, not the read's generator
	yield* someGen(draft.Rows, function* (row) {
		return inFlight(save, row);
	});
	// @ts-expect-error a predicate returns a generator, not a boolean
	yield* someGen(draft.Rows, (row) => row.Ready);
	// @ts-expect-error an effect is not a read
	yield* mapGen(draft.Rows, () => generateGuid());
	// @ts-expect-error a callback's generator returns a value, not the read's generator
	yield* mapGen(draft.Rows, function* (row) {
		return inFlight(save, row);
	});
	expectTypeOf(yield* mapGen(draft.Rows, rowBusy)).toEqualTypeOf<boolean[]>();
	expectTypeOf(yield* mapGen(draft.Rows, (row) => rowBusy(row))).toEqualTypeOf<boolean[]>();
	expectTypeOf(
		yield* mapGen(draft.Rows, function* (row) {
			return [
				row.Name,
				yield* inFlight(save, row)
			] as const;
		})
	).toEqualTypeOf<
		(readonly [
			string,
			boolean
		])[]
	>();
}

function* actions(draft: IBoard): IActionGenerator {
	expectTypeOf(
		yield* mapGen(draft.Rows, function* (row) {
			if (yield* inFlight(save, row)) return "busy";
			yield* start(save, row);
			return yield* generateGuid();
		})
	).toEqualTypeOf<string[]>();
	expectTypeOf(
		yield* mapGen(
			[
				"a"
			],
			(name) =>
				entity({
					Name: name
				})
		)
	).toEqualTypeOf<
		IWithId<{
			Name: string;
		}>[]
	>();
	expectTypeOf(
		yield* mapGen(
			[
				{
					Name: "a"
				}
			],
			entity
		)
	).toEqualTypeOf<IEntity[]>();
	expectTypeOf(
		yield* mapGen(
			[
				{
					Name: "a"
				}
			],
			mint
		)
	).toEqualTypeOf<
		({
			Name: string;
		} & IEntity)[]
	>();
	expectTypeOf(yield* mapGen(draft.Rows, (row) => mapGen(row.Name.split(""), () => generateGuid()))).toEqualTypeOf<string[][]>();

	// @ts-expect-error `open` stays visible in the yield type
	yield* mapGen(draft.Rows, () => open(generateGuid()));
}

function* opening(draft: IBoard): IOpenGenerator {
	expectTypeOf(yield* mapGen(draft.Rows, () => open(generateGuid()))).toEqualTypeOf<string[]>();
}

function inferred(): void {
	expectTypeOf(filterGen(frozenRows, rowBusy)).toEqualTypeOf<Generator<IRead, IRow[], any>>();
}

describe("mapGen, filterGen and someGen types", () => {
	it("compile", () => {
		expect([
			selectors,
			actions,
			opening,
			inferred
		]).toHaveLength(4);
	});
});
