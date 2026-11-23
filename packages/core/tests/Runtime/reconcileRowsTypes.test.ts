import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity, IEntityId } from "../../src/Types/IEntity";
import { describe, expect, expectTypeOf, it } from "vitest";
import { entity, idOf } from "../../src/Effects/entity";
import { start } from "../../src/Effects/start";
import { reconcileRows } from "../../src/Runtime/reconcileRows";

// Compile-time pins: every @ts-expect-error is a case the compiler must refuse.

interface IRow extends IEntity {
	Id: string;
	Status: "open" | "shut";
	Note?: string;
}

interface IInfo {
	Id: string;
	Label: string;
}

interface IDoc extends IEntity {
	Rows: IRow[];
	SelectedId: IEntityId | null;
	AnyId: string;
}

interface ISingleton extends IEntity {
	$Id: "Theme";
	Hue: number;
}

declare const runtime: IRuntime<IDoc>;
declare function init(draft: IRow): IActionGenerator;
declare const singleton: ISingleton;
declare const infos: readonly IInfo[];
declare const rows: readonly Omit<IRow, "$Id">[];

function* minting(draft: IDoc): IActionGenerator {
	const inferred = yield* entity({
		customer: 5,
		tags: [
			"x"
		]
	});
	expectTypeOf(inferred.customer).toEqualTypeOf<number>();
	expectTypeOf(inferred.tags).toEqualTypeOf<string[]>();
	expectTypeOf(inferred.$Id).toEqualTypeOf<string>();

	const row = yield* entity<IRow>({
		Id: "a",
		Status: "open"
	});
	expectTypeOf(row).toEqualTypeOf<IRow>();
	draft.Rows.push(row);
	yield* start(init, row);

	const copied = yield* entity({
		...draft.Rows[0]
	});
	draft.Rows.push(copied);
	yield* start(init, copied);

	const widened = yield* entity({
		Id: "a",
		Status: "open"
	});
	// @ts-expect-error a literal's field widens, and entity<IRow> is the way to say it
	draft.Rows.push(widened);

	yield* entity<IRow>({
		Id: "a",
		// @ts-expect-error the named form checks the fields
		Status: "ajar"
	});
	// @ts-expect-error the named form wants every field
	yield* entity<IRow>({
		Id: "a"
	});
	// @ts-expect-error an entity is an object
	yield* entity(5);

	const fromLiteralId = yield* entity(singleton);
	expectTypeOf(fromLiteralId.$Id).toEqualTypeOf<string>();

	void runtime.dispatch(init, row);
	void runtime.dispatch(init, idOf(row));
	void runtime.dispatch(init, row.$Id);
	// @ts-expect-error dispatch takes an entity or an id
	void runtime.dispatch(init, {});

	draft.SelectedId = idOf(row);
	draft.AnyId = idOf(row);
	// @ts-expect-error a field typed as an address takes one from idOf
	draft.SelectedId = row.$Id;
	// @ts-expect-error idOf takes an entity
	idOf({});
}

function* reconciling(draft: IDoc): IActionGenerator {
	const added = yield* reconcileRows(draft.Rows, infos, (row) => row.Id, {
		add: (item) =>
			entity<IRow>({
				Id: item.Id,
				Status: "open"
			}),
		update(row, item) {
			expectTypeOf(row).toEqualTypeOf<IRow>();
			expectTypeOf(item).toEqualTypeOf<IInfo>();
			row.Note = item.Label;
		}
	});
	expectTypeOf(added).toEqualTypeOf<IRow[]>();

	yield* reconcileRows(draft.Rows, rows, (row) => row.Id, {
		update: () => {}
	});
	yield* reconcileRows(draft.Rows, rows, (row) => row.Id, {
		*update(row, item) {
			row.Note = item.Note;
		}
	});

	// @ts-expect-error update is required
	yield* reconcileRows(draft.Rows, rows, (row) => row.Id);
	// @ts-expect-error add can only be left out when an item already has the row's fields
	yield* reconcileRows(draft.Rows, infos, (row) => row.Id, {
		update: () => {}
	});
	// @ts-expect-error the key reads a field both sides have
	yield* reconcileRows(draft.Rows, infos, (row) => row.Label, {
		add: () => ({}) as IRow,
		update: () => {}
	});
	yield* reconcileRows(draft.Rows, infos, (row) => row.Id, {
		// @ts-expect-error add has to make a row
		add: (item) => item,
		update: () => {}
	});
}

describe("entity and reconcileRows typing", () => {
	it("compiles the cases above", () => {
		expect(typeof minting).toBe("function");
		expect(typeof reconciling).toBe("function");
	});
});
