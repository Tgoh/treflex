import type { IWithId } from "../../src/Effects/entity";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity, IEntityId } from "../../src/Types/IEntity";
import { describe, expect, expectTypeOf, it } from "vitest";
import { entity } from "../../src/Effects/entity";
import { reconcileRows } from "../../src/Runtime/reconcileRows";

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
	ById: Record<string, IRow>;
}

declare const infos: readonly IInfo[];
declare const infosById: Record<string, IInfo>;
declare const rows: readonly Omit<IRow, "$Id">[];
declare const rowsById: Record<string, Omit<IRow, "$Id">>;
declare const ids: readonly {
	Id: string;
}[];
declare const idsById: Record<
	string,
	{
		Id: string;
	}
>;

// expectTypeOf can't compare an open type parameter, so these pin the types by assignment.
function* overGeneric<
	T extends {
		id: string;
	}
>(
	byId: Record<string, IWithId<T>>,
	list: IWithId<T>[],
	next: readonly T[],
	nextById: Readonly<Record<string, T>>
): IActionGenerator<unknown> {
	const added: IWithId<T>[] = yield* reconcileRows(byId, next, (item) => item.id, {
		update(row, item) {
			const typed: [
				IWithId<T>,
				T
			] = [
				row,
				item
			];
			return typed;
		}
	});
	yield* reconcileRows(byId, nextById, {
		update(row, item) {
			const typed: [
				IWithId<T>,
				T
			] = [
				row,
				item
			];
			return typed;
		}
	});
	const listed: IWithId<T>[] = yield* reconcileRows(list, next, (row) => row.id, {
		update: () => {}
	});
	return [
		added,
		listed
	];
}

function* overRecords(draft: IDoc): IActionGenerator {
	const added = yield* reconcileRows(draft.ById, infos, (item) => item.Label, {
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

	const fromRecord = yield* reconcileRows(draft.ById, infosById, {
		add: (item) =>
			entity<IRow>({
				Id: item.Id,
				Status: "open"
			}),
		update(row, item) {
			expectTypeOf(row).toEqualTypeOf<IRow>();
			expectTypeOf(item).toEqualTypeOf<IInfo>();
		}
	});
	expectTypeOf(fromRecord).toEqualTypeOf<IRow[]>();

	const minted = yield* reconcileRows(draft.ById, rows, (item) => item.Id, {
		update: () => {}
	});
	expectTypeOf(minted).toEqualTypeOf<IRow[]>();
	yield* reconcileRows(draft.ById, rowsById, {
		update: () => {}
	});

	// @ts-expect-error add can only be left out when an item already has the row's fields
	yield* reconcileRows(draft.ById, ids, (item) => item.Id, {
		update: () => {}
	});
	// @ts-expect-error the same for an incoming record
	yield* reconcileRows(draft.ById, idsById, {
		update: () => {}
	});
	// @ts-expect-error the same for a list
	yield* reconcileRows(draft.Rows, ids, (row) => row.Id, {
		update: () => {}
	});
	// @ts-expect-error update is required
	yield* reconcileRows(draft.ById, rowsById, {});
	// @ts-expect-error an incoming record names its rows by its own keys
	yield* reconcileRows(draft.ById, rowsById, (item) => item.Id, {
		update: () => {}
	});
	// @ts-expect-error a list's incoming rows are an array, since the list ends in their order
	yield* reconcileRows(draft.Rows, rowsById, {
		update: () => {}
	});
}

function* recordMistakes(draft: IDoc): IActionGenerator {
	yield* reconcileRows(
		draft.ById,
		infos,
		(item) => item.Id,
		// @ts-expect-error the missing add, not the record's shape
		{
			update: () => {}
		}
	);
	yield* reconcileRows(draft.ById, infos, (item) => item.Id, {
		// @ts-expect-error add has to make a row
		add: (item) => item,
		update: () => {}
	});
	yield* reconcileRows(
		draft.ById,
		rows,
		// @ts-expect-error a key is a string or a number
		(item) => item,
		{
			update: () => {}
		}
	);
}

interface ITheme {
	$Id: "Theme";
	Id: string;
}

interface IAddressed {
	$Id: IEntityId;
	Id: string;
}

declare const themes: ITheme[];
declare const themesById: Record<string, ITheme>;
declare const addressed: IAddressed[];
declare const addressedById: Record<string, IAddressed>;
declare const fetchedList: any[];
declare const fetched: any;
declare const byId: Record<string, IRow>;
declare const list: IRow[];

function* leavingAddOut(): IActionGenerator {
	const fields = [
		{
			Id: "a"
		}
	];
	const fieldsById = {
		a: {
			Id: "a"
		}
	};
	const update = {
		update: () => {}
	};
	yield* reconcileRows(themes, fields, (row) => row.Id, update);
	yield* reconcileRows(themesById, fields, (item) => item.Id, update);
	yield* reconcileRows(themesById, fieldsById, update);
	yield* reconcileRows(addressed, fields, (row) => row.Id, update);
	yield* reconcileRows(addressedById, fields, (item) => item.Id, update);
	yield* reconcileRows(addressedById, fieldsById, update);
	yield* reconcileRows(list, fetchedList, (row) => row.Id, update);
	yield* reconcileRows(byId, fetchedList, (item) => item.Id, update);
	yield* reconcileRows(list, fetched, (row) => row.Id, update);
	yield* reconcileRows(byId, fetched, (item) => item.Id, update);
	yield* reconcileRows(byId, fetched, update);
}

describe("reconcileRows typing over records", () => {
	it("compiles the cases above", () => {
		expect(typeof overGeneric).toBe("function");
		expect(typeof overRecords).toBe("function");
		expect(typeof leavingAddOut).toBe("function");
		expect(typeof recordMistakes).toBe("function");
	});
});
