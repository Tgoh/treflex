import type { IActionGenerator, IEntity } from "treflex";

export declare const runtime: {
	dispatch(action: unknown, target: string): Promise<unknown>;
};

export function* save(draft: IEntity): IActionGenerator {}
