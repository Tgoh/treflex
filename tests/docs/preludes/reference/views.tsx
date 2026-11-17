import { For, type JSX, Show } from "solid-js";
import { render } from "solid-js/web";
import { createRuntime, transient, type IActionGenerator, type IEntity, type ILocation, type ISelectorGenerator } from "treflex";
import { createComponentFeature, TreflexProvider, useComponentState, useDispatch, useInFlight, useLocate } from "treflex-solid";

interface IApp extends IEntity {}
interface IWindow extends IEntity {
	App: IApp | null;
}
interface IWorkspace extends IEntity {
	Windows: IWindow[];
}
declare function AppView(props: { state: IApp }): JSX.Element;

interface IUpload {
	Sent: number;
	Total: number;
}
interface IEditor extends IEntity {}
declare function upload(draft: IEditor): ISelectorGenerator<IUpload>;

interface IAddress {
	Street: string;
}
interface IRecord extends IEntity {
	Address: IAddress;
	Billing: { Address: IAddress };
}

interface IRow extends IEntity {
	Name: string;
}
interface IList extends IEntity {
	Rows: IRow[];
}
interface IRowView {
	Name: string;
}
declare function save(draft: IEditor): IActionGenerator;
declare function saveRow(draft: IRow): IActionGenerator;
declare const editor: { state: IEditor & { Rows: IRow[] }; save(): Promise<unknown> };

interface IGridState extends IEntity {
	Widths: Record<string, number>;
	Selected: string[];
}
declare function GridBody(props: {}): JSX.Element;
