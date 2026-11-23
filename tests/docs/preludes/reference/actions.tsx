import { entity, inFlight, latest, leading, named, open, redactArgs, start, workTag, type IActionGenerator, type IActionYield, type IEntity, type IOpenMark, type ISelectorGenerator } from "treflex";

import { useInFlight } from "treflex-solid";

interface IEditor extends IEntity {
	Id: string;
	Title: string;
	Dirty: boolean;
}
declare const editor: { state: IEditor; save(): Promise<unknown> };
declare function postRecord(id: string, title: string): IActionGenerator<boolean>;

interface IRow extends IEntity {
	Name: string;
	Saved?: boolean;
	Loaded: boolean;
}
declare function postRow(name: string): IActionGenerator;
declare function loadRow(draft: IRow): IActionGenerator;

interface IPart {}
interface IDocument extends IEntity {
	Id: string;
	Preview: string;
	Loading: boolean;
}
declare function fetchPreview(id: string): IActionGenerator<string>;
declare function fetchParts(id: string): IActionGenerator<IPart[]>;
declare function seatParts(doc: IDocument, parts: IPart[]): void;

interface ILog extends IEntity {}
interface IStation extends IEntity {}
interface IKitchen extends IEntity {
	Open: boolean;
	Log: ILog;
	Rows: IRow[];
	Stations: IStation[];
}
declare function refreshLog(draft: ILog): IActionGenerator;
declare function fetchOrder(id: string): IActionGenerator<string>;

interface IPicker extends IEntity {
	Results: { Name: string }[];
}
declare function findCustomers(text: string): IActionGenerator<{ Name: string }[]>;

interface ISession extends IEntity {
	User: string;
}
declare function signIn(user: string, password: string): IActionGenerator<string>;
