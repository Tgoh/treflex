import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";

declare module "../../src/Registries/IExternalRegistry" {
	interface IExternalRegistry {
		"test/Stopping": number;
	}
}

interface IWorld {
	$Id: string;
	Count: number;
}

function* bump(draft: IWorld): IActionGenerator {
	draft.Count++;
}

let warn: MockInstance;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function build() {
	const runtime = createRuntime<IWorld>({
		$Id: "root",
		Count: 0
	});
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	return {
		runtime,
		diags,
		threw: () => diags.filter((diag) => diag.code === "runtime/callback-threw").map((diag) => diag.data)
	};
}

describe("a throw from code the runtime calls outside any action", () => {
	it("from a record tap is a diag naming the tap and the kind, and the action and the other taps go on", async () => {
		const h = build();
		const broke = new Error("tap broke");
		const heard: string[] = [];
		h.runtime.on(
			"record",
			() => {
				throw broke;
			},
			{
				kinds: [
					"action:start"
				]
			}
		);
		h.runtime.on("record", (record) => heard.push(record.Kind), {
			kinds: [
				"action:start"
			]
		});
		await h.runtime.dispatch(bump, "root");
		expect(h.runtime.state.Count).toBe(1);
		expect(heard).toEqual([
			"action:start"
		]);
		expect(h.threw()).toEqual([
			{
				source: "A record tap",
				kind: "action:start",
				error: broke
			}
		]);
	});

	it("from a diag subscriber reaches the console only, so it can't loop", () => {
		const h = build();
		const broke = new Error("diag subscriber broke");
		h.runtime.on("diag", () => {
			throw broke;
		});
		h.runtime.on(
			"record",
			() => {
				throw new Error("tap broke");
			},
			{
				kinds: [
					"entity:dispose"
				]
			}
		);
		h.runtime.provideExternal("test/Stopping", {
			read: () => 1,
			subscribe: () => () => {
				throw new Error("stop broke");
			}
		});
		h.runtime.dispose();
		expect(h.threw().map((data) => data!.source)).toEqual([
			`provideExternal("test/Stopping")'s subscription stop`,
			"A record tap"
		]);
		const consoleOnly = warn.mock.calls.filter(
			([, data]) =>
				(
					data as
						| {
								error?: unknown;
						  }
						| undefined
				)?.error === broke
		);
		expect(
			consoleOnly.map(
				([, data]) =>
					(
						data as {
							source: string;
						}
					).source
			)
		).toEqual([
			'A "diag" subscriber',
			'A "diag" subscriber'
		]);
	});
});
