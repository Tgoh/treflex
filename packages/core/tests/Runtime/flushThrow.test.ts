import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { createRuntime } from "../../src/Runtime/createRuntime";
import * as reactive from "../reactive";

interface IRoot {
	$Id: string;
	Note: string;
	Count: number;
}

function build() {
	const runtime = createRuntime<IRoot>(
		{
			$Id: "root",
			Note: "",
			Count: 0
		},
		{
			onError: () => {}
		}
	);
	runtime.registerImplementation("wait", () => new Promise(() => {}));
	runtime.registerImplementation("echo", () => "echoed");
	reactive.effect(() => {
		if (runtime.state.Note === "boom") {
			throw new Error("flush failed");
		}
	});
	return runtime;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function* counted(draft: IRoot): IActionGenerator {
	draft.Count++;
	try {
		yield {
			Type: "echo"
		};
		draft.Note = "boom";
		yield {
			Type: "wait"
		};
	} finally {
		draft.Count--;
	}
}

describe("a computation throwing in a step's flush", () => {
	it.each<
		[
			string,
			(draft: IRoot) => IActionGenerator
		]
	>([
		[
			"a root action",
			counted
		],
		[
			"a parallel branch",
			function* (draft) {
				yield* parallel(counted(draft));
			}
		],
		[
			"a parallelSettled branch",
			function* (draft) {
				const [outcome] = yield* parallelSettled(counted(draft));
				if (!outcome.ok) {
					throw outcome.error;
				}
			}
		]
	])("runs the finally of %s, whose generator was suspended when the flush threw", async (_shape, action) => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = build();
				await settle();
				await expect(runtime.dispatch(action, "root")).rejects.toThrow("flush failed");
				expect(runtime.state.Count).toBe(0);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("leaves a finally that already ran alone when the step that finished the generator has a throwing flush", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = build();
				await settle();
				function* action(draft: IRoot): IActionGenerator<string> {
					try {
						draft.Note = "boom";
						return "returned";
					} finally {
						draft.Count++;
					}
				}
				await expect(runtime.dispatch(action, "root")).rejects.toThrow("flush failed");
				expect(runtime.state.Count).toBe(1);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});
});
