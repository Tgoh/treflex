import type { IEntity } from "treflex";
import type { ICounter } from "./counter/counter";

export interface IApp extends IEntity {
	Counter: ICounter;
}

export function seed(): IApp {
	return {
		$Id: "App",
		Counter: { $Id: "Counter", Count: 0, Notice: "" },
	};
}
