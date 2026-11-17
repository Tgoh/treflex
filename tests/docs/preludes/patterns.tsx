import {
	defineEffect,
	entity,
	type IActionGenerator,
	type IEntity,
	type IReceiverId,
	type IRuntime,
	type ISelectorGenerator,
	latest,
	leading,
	mapGen,
	open,
	openResource,
	publishToNearest,
	receiver,
	reconcileRows,
	start,
	startTimer,
	stopTimer,
	workTag,
	closeResource,
	resource,
	transient,
	withoutIds,
	type IWithoutIds
} from "treflex";

declare module "treflex" {
	interface IMessageRegistry {
		"Doc/Changed": { DocId: string; Text: string };
		"Job/Done": { Result: string };
		"Window/Reload": {};
	}
	interface ITimerRegistry {
		"Note/RefreshSoon": {};
	}
	interface IResourceTypeRegistry {
		lock: { Params: { DocId: string } };
		worker: { Params: { Script: string }; Methods: { render(points: number[]): string } };
	}
	interface IResourceRegistry {
		"Doc/Lock": { Type: "lock" };
		"Chart/Worker": { Type: "worker" };
	}
}

const findItems = defineEffect<{ Type: "App/FindItems"; Query: string }, string[]>("App/FindItems");
const sendFile = defineEffect<{ Type: "App/SendFile"; Name: string }, { Id: string }>("App/SendFile");
const postDoc = defineEffect<{ Type: "App/PostDoc"; Body: string }, { Version: number }>("App/PostDoc");
const fetchTitle = defineEffect<{ Type: "App/FetchTitle"; Id: string }, { Title: string }>("App/FetchTitle");
interface IBoardInfo {
	Name: string;
	Columns: IColumnInfo[];
}
interface IColumnInfo {
	ColumnId: string;
	Name: string;
	Cards: { CardId: string; Title: string }[];
}
declare function refreshNote(draft: { $Id: string; Text: string }): IActionGenerator;
