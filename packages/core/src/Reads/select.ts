import type { IReadGenerator, ISelector } from "../Types/ISelector";

export function* select<S, R>(selector: ISelector<S, R>, accessor?: (state: any) => S): IReadGenerator<R> {
	const result = yield {
		Type: "select",
		Accessor: accessor,
		Selector: selector
	};
	return result;
}
