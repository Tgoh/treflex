import { entity, filterGen, inFlight, mapGen, select, someGen, type IActionGenerator, type IEntity, type ISelectorGenerator } from "treflex";

interface ITodo {
	Done: boolean;
}
interface ITodoList extends IEntity {
	Todos: ITodo[];
}
interface IDoc extends IEntity {
	Name: string;
}
declare function save(draft: IDoc): IActionGenerator;
interface IBoard extends IEntity {
	Docs: IDoc[];
	Rows: { Open: boolean }[];
	Summary: string;
}
