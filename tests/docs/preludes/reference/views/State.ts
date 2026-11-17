import type { IEntity } from "treflex";

export interface ITodoList extends IEntity {
	Draft: string;
	Todos: { Text: string; Done: boolean }[];
}
