import { entity, reconcileRows, start, type IActionGenerator, type IEntity } from "treflex";

interface ISub extends IEntity {
	Id: string;
}
interface IRow extends IEntity {
	Id: string;
	Value: string;
	Subs: ISub[];
}
interface IDocument extends IEntity {
	Title: string;
	Rows: IRow[];
}
interface IRowInfo {
	Id: string;
	Value: string;
	Subs: { Id: string }[];
}
interface IDocumentInfo {
	Title: string;
	Rows: IRowInfo[];
}
declare function initRow(draft: IRow): IActionGenerator;

interface IPlain extends IEntity {
	Rows: { A: number }[];
}

interface IRequestInfo {
	id: string;
	status: string;
}
interface IRequest extends IEntity {
	id: string;
	status: string;
}
interface IThread extends IEntity {
	Requests: Record<string, IRequest>;
}
interface IThreadSnapshot {
	Requests: IRequestInfo[];
}
declare function assignRequest(row: IRequest, item: IRequestInfo): void;
