import { load, save } from "@lib";

declare const runtime: {
	dispatch(action: unknown, target: string): Promise<unknown>;
};

export function run(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(save, "doc"),
		runtime.dispatch(load, "doc"),
		runtime.dispatch(function* (draft: { $Id: string }) {}, "doc")
	]);
}
