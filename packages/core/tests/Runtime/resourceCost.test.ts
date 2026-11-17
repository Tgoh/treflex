import type { IActionGenerator } from "../../src/Types/IAction";
import type { IResourceContext } from "../../src/Types/IResource";
import { describe, expect, it } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import { isEnded } from "../../src/Types/IResource";

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"cost/feed": {
			Message: {
				Body: string;
				N: number;
			};
		};
	}
	interface IResourceRegistry {
		"Cost/Feed": {
			Type: "cost/feed";
		};
	}
}

type IRoot = {
	$Id: string;
	Count: number;
};

const CostReceiver = receiver<IRoot>("CostReceiver")({
	*"Cost/Feed"(draft, e) {
		if (!isEnded(e)) {
			draft.Count++;
		}
	}
});

async function timeEmits(
	journal: boolean,
	messages: {
		Body: string;
		N: number;
	}[]
): Promise<number> {
	const runtime = createRuntime<IRoot>({
		$Id: "root",
		Count: 0
	});
	if (journal) {
		runtime.on("record", () => {});
	}
	runtime.registerReceiver(CostReceiver);
	let ctx!: IResourceContext<"cost/feed">;
	runtime.registerResourceType("cost/feed", (_params, r) => {
		ctx = r;
	});
	function* open(draft: IRoot): IActionGenerator {
		yield* openResource(draft, "Cost/Feed", CostReceiver, {
			Type: "cost/feed"
		});
	}
	await runtime.dispatch(open, "root");
	const start = performance.now();
	for (const message of messages) {
		await ctx.emit(message);
	}
	while (runtime.state.Count < messages.length) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const elapsed = performance.now() - start;
	expect(runtime.state.Count).toBe(messages.length);
	runtime.dispose();
	return elapsed;
}

describe("resource emit cost", () => {
	it("reports many small messages, journal off vs on (loosely bounded)", async () => {
		const N = 2000;
		const small = Array.from(
			{
				length: N
			},
			(_, i) => ({
				Body: "x",
				N: i
			})
		);
		await timeEmits(false, small);
		const off = await timeEmits(false, small);
		const on = await timeEmits(true, small);
		console.info(
			`[resource cost] ${N} small emits: off=${off.toFixed(0)}ms (${((off / N) * 1000).toFixed(1)}µs/emit), ` +
				`on=${on.toFixed(0)}ms (${((on / N) * 1000).toFixed(1)}µs/emit)`
		);
		expect(on).toBeLessThan(off * 8 + 500);
	});

	it("reports one large string, journal off vs on (loosely bounded)", async () => {
		const large = [
			{
				Body: "y".repeat(5_000_000),
				N: 0
			}
		];
		await timeEmits(false, large);
		const off = await timeEmits(false, large);
		const on = await timeEmits(true, large);
		console.info(`[resource cost] one 5MB string: off=${off.toFixed(1)}ms, on=${on.toFixed(1)}ms`);
		expect(on).toBeLessThan(off * 8 + 500);
	});
});
