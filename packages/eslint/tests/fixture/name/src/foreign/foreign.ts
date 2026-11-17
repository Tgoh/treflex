import { runtime } from "../runtime";

function named(text: string): string {
	return text;
}

export const title = named("Foreign");

export function* save(draft: { $Id: string }) {}

export function dispatchSave(): Promise<unknown> {
	return runtime.dispatch(save, "doc");
}
