import { runtime } from "../runtime";

export function bind(): Promise<unknown> {
	function* save(draft: { $Id: string }) {}
	return runtime.dispatch(save, "doc");
}
