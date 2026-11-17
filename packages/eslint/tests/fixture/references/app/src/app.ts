import { save } from "../../lib/store/store";

declare const runtime: {
	dispatch(action: unknown, target: string): Promise<unknown>;
};

export function run(): Promise<unknown> {
	return runtime.dispatch(save, "doc");
}
