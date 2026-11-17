import type { IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { createRuntime } from "../../src/Runtime/createRuntime";

export interface IDoc extends IEntity {
	N: number;
	Note: string;
}

export interface IWorld extends IEntity {
	Docs: IDoc[];
}

export function seed(): IWorld {
	return {
		$Id: "root",
		Docs: [
			{
				$Id: "a",
				N: 0,
				Note: ""
			}
		]
	};
}

export function* wait(name: string): Generator<any, any, any> {
	return yield {
		Type: "test/wait",
		Name: name
	};
}

export function build(options: IRuntimeOptions = {}) {
	const runtime = createRuntime<IWorld>(seed(), {
		onError: () => {},
		...options
	});
	const releases = new Map<string, (value?: unknown) => void>();
	runtime.registerImplementation(
		"test/wait",
		(effect: { Type: string; Name: string }) =>
			new Promise((resolve) => {
				releases.set(effect.Name, resolve);
			})
	);
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	const failures: IRuntimeEventOf<"failure">[] = [];
	runtime.on("failure", (event) => failures.push(event));
	const starts = () =>
		records.filter(
			(
				record
			): record is Extract<
				IRecord,
				{
					Kind: "action:start";
				}
			> => record.Kind === "action:start"
		);
	return {
		runtime,
		releases,
		records,
		diags,
		failures,
		starts,
		codes: () => diags.map((event) => event.code)
	};
}

export function* bump(draft: IDoc): IActionGenerator {
	draft.N++;
}
