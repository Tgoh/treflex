import { vendored } from "../vendor/vendor";
import { bare } from "./bare/bare";
import { archive } from "./board/board";
import { runtime } from "./runtime";
import { typedSave } from "./typed/typed";

export async function run(): Promise<void> {
	await runtime.dispatch(archive, "card");
	await runtime.dispatch(bare, "doc");
	await runtime.dispatch(typedSave, "doc");
	await runtime.dispatch(vendored, "doc");
	await runtime.dispatch(function* (draft: { $Id: string }) {}, "doc");
}
