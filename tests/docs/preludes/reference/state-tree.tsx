import { entity, idOf, start, transient, withoutIds, type IActionGenerator, type IEntity, type IEntityId, type ISelectorGenerator } from "treflex";
import { useComponentState } from "treflex-solid";

interface IRow extends IEntity {
	Name: string;
	Done: boolean;
}
interface IList extends IEntity {
	Rows: IRow[];
	SelectedId: IEntityId | null;
}
declare function initRow(draft: IRow): IActionGenerator;

interface ITicket extends IEntity {}
interface IStation extends IEntity {
	Tickets: ITicket[];
}
interface IKitchen extends IEntity {
	Stations: IStation[];
}

interface IImport extends IEntity {
	Id: string;
}
declare function importRows(id: string): IActionGenerator;

interface IItem {}
interface IAliasing extends IEntity {
	Items: IItem[];
	Rows: IItem[];
	Selected: IItem | undefined;
	Form: { A: { B: number } };
	Snapshot: { A: { B: number } };
	Picked: IItem[];
}
declare function isPicked(row: IItem): boolean;
