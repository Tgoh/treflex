import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator, IOpenGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IReceiver } from "../../src/Types/IReceiver";
import type { IRecord } from "../../src/Types/IRecord";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { publish } from "../../src/Effects/publish";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { inFlight } from "../../src/Runtime/arrivals";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { workTag } from "../../src/Runtime/workTag";
import { createTestRuntime, settled } from "../../src/Testing/createTestRuntime";
import { inFlightOf } from "../testHelpers";

const publishAny = publish as unknown as (topic: string, data?: Record<string, unknown>) => Generator<any, void, any>;

interface IPanel extends IEntity {
	Log: string[];
}

interface IWorld extends IEntity {
	Panels: IPanel[];
}

function seed(): IWorld {
	return {
		$Id: "root",
		Panels: [
			{
				$Id: "a",
				Log: []
			},
			{
				$Id: "b",
				Log: []
			}
		]
	};
}

function build() {
	const runtime = createRuntime<IWorld>(seed(), {
		onError: () => {}
	}) as IRuntimeInternal<IWorld>;
	const releases: ((value?: unknown) => void)[] = [];
	runtime.registerImplementation(
		"wait",
		() =>
			new Promise((resolve) => {
				releases.push(resolve);
			})
	);
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const panel = (id: "a" | "b" = "a") => runtime.state.Panels.find((p) => p.$Id === id)!;
	return {
		runtime,
		releases,
		records,
		panel,
		read: (action: Parameters<typeof inFlightOf>[1], id: "a" | "b" = "a") => inFlightOf(runtime, action, panel(id)),
		send: (topic: string) =>
			runtime.dispatch(function* sends(_draft: IWorld): IActionGenerator {
				yield* publishAny(topic);
			}, "root")
	};
}

function* wait(): Generator<any, unknown, any> {
	return yield {
		Type: "wait"
	};
}

async function bindAll(h: ReturnType<typeof build>, Receiver: IReceiver<IPanel, never>): Promise<void> {
	h.runtime.registerReceiver(Receiver);
	await h.runtime.dispatch(function* binds(draft: IWorld): IActionGenerator {
		for (const panel of draft.Panels) {
			bind(panel, Receiver);
		}
	}, "root");
}

describe("receiver cases and inFlight", () => {
	it("counts a bare-form case as its function, and as the receiver's handle, from arrival to end", async () => {
		const h = build();
		function* search(draft: IPanel): IActionGenerator {
			yield* wait();
			draft.Log.push("searched");
		}
		const Receiver = receiver<IPanel>("Search")({
			["Refresh" as any]: search
		});
		await bindAll(h, Receiver);
		await h.send("Refresh");
		expect([
			h.read(search),
			h.read(Receiver.handle)
		]).toEqual([
			true,
			true
		]);
		h.releases[0]!();
		h.releases[1]!();
		await settled();
		expect([
			h.read(search),
			h.read(Receiver.handle),
			h.panel().Log
		]).toEqual([
			false,
			false,
			[
				"searched"
			]
		]);
	});

	it("counts a delivery queued behind other work on the owner, before it starts", async () => {
		const h = build();
		const started: string[] = [];
		function* search(_draft: IPanel): IActionGenerator {
			started.push("search");
		}
		function* holds(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		const Receiver = receiver<IPanel>("Search")({
			["Refresh" as any]: search
		});
		await bindAll(h, Receiver);
		const held = h.runtime.dispatch(holds, "a");
		await h.send("Refresh");
		expect(started).toEqual([
			"search"
		]);
		started.length = 0;
		expect([
			h.read(search, "a"),
			h.read(search, "b")
		]).toEqual([
			true,
			false
		]);
		h.releases[0]!();
		await held;
		await settled();
		expect(started).toEqual([
			"search"
		]);
		expect(h.read(search, "a")).toBe(false);
	});

	it("counts a wrapper case as the wrapper, not the action it calls with yield*", async () => {
		const h = build();
		function* search(draft: IPanel): IActionGenerator {
			yield* wait();
			draft.Log.push("searched");
		}
		function* wrapper(draft: IPanel): IActionGenerator {
			yield* search(draft);
		}
		const Receiver = receiver<IPanel>("Search")({
			["Refresh" as any]: wrapper
		});
		await bindAll(h, Receiver);
		await h.send("Refresh");
		expect([
			h.read(wrapper),
			h.read(search)
		]).toEqual([
			true,
			false
		]);
		h.releases[0]!();
		h.releases[1]!();
		await settled();
	});

	it("doesn't apply the case's own leading or latest mark to a delivery", async () => {
		const h = build();
		function* once(draft: IPanel): IActionGenerator {
			yield* wait();
			draft.Log.push("once");
		}
		leading(once);
		function* last(draft: IPanel): IActionGenerator {
			yield* wait();
			draft.Log.push("last");
		}
		latest(last);
		const Receiver = receiver<IPanel>("Marked")({
			["Once" as any]: once,
			["Last" as any]: last
		});
		await bindAll(h, Receiver);
		await h.send("Once");
		await h.send("Once");
		await h.send("Last");
		await h.send("Last");
		while (h.releases.length > 0) {
			h.releases.shift()!();
			await settled();
		}
		expect(h.panel().Log).toEqual([
			"once",
			"once",
			"last",
			"last"
		]);
	});

	it("re-derives a memo over a case as its delivery arrives and ends", async () => {
		const h = build();
		function* search(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		function* searching(draft: IPanel): ISelectorGenerator<boolean> {
			return yield* inFlight(search, draft);
		}
		const Receiver = receiver<IPanel>("Search")({
			["Refresh" as any]: search
		});
		await bindAll(h, Receiver);
		await createRoot(async (dispose) => {
			const seen: boolean[] = [];
			createEffect(() => {
				seen.push(h.runtime.runSelector(searching, () => h.panel()));
			});
			await settled();
			await h.send("Refresh");
			await settled();
			h.releases[0]!();
			h.releases[1]!();
			await settled();
			expect(seen).toEqual([
				false,
				true,
				false
			]);
			dispose();
		});
	});
});

describe("work tags", () => {
	it("reads any tagged work on the owner, queued and through an open wait, and re-derives once per busy span", async () => {
		const h = build();
		const Work = workTag("Test/Work");
		function* load(draft: IPanel): IActionGenerator {
			yield* wait();
			draft.Log.push("loaded");
		}
		function* save(draft: IPanel): IOpenGenerator {
			yield* open(wait());
			draft.Log.push("saved");
		}
		function* other(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		Work.mark(load, save);
		function* veiled(draft: IPanel): ISelectorGenerator<boolean> {
			return yield* inFlight(Work, draft);
		}
		await createRoot(async (dispose) => {
			const seen: boolean[] = [];
			createEffect(() => {
				seen.push(h.runtime.runSelector(veiled, () => h.panel()));
			});
			await settled();
			const saving = h.runtime.dispatch(save, "a");
			const loading = h.runtime.dispatch(load, "a");
			await settled();
			expect(h.read(Work)).toBe(true);
			h.releases[0]!();
			await settled();
			expect(h.read(Work)).toBe(true);
			h.releases[1]!();
			await Promise.all([
				saving,
				loading
			]);
			await settled();
			const plain = h.runtime.dispatch(other, "a");
			await settled();
			expect(h.read(Work)).toBe(false);
			h.releases[2]!();
			await plain;
			await settled();
			expect(seen).toEqual([
				false,
				true,
				false
			]);
			dispose();
		});
	});

	it("keeps each owner's read to its own work, so one window's work doesn't re-run another's selector", async () => {
		const h = build();
		const Work = workTag("Test/Work");
		function* load(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		Work.mark(load);
		let runsOnB = 0;
		function* veiledB(draft: IPanel): ISelectorGenerator<boolean> {
			runsOnB++;
			return yield* inFlight(Work, draft);
		}
		await createRoot(async (dispose) => {
			createEffect(() => {
				h.runtime.runSelector(veiledB, () => h.panel("b"));
			});
			await settled();
			const before = runsOnB;
			const loading = h.runtime.dispatch(load, "a");
			await settled();
			expect([
				h.read(Work, "a"),
				h.read(Work, "b")
			]).toEqual([
				true,
				false
			]);
			h.releases[0]!();
			await loading;
			await settled();
			expect(runsOnB).toBe(before);
			dispose();
		});
	});

	it("re-derives a memo first read after the work arrived, on the work's end, for an action, a case and a tag", async () => {
		const h = build();
		const Work = workTag("Test/Work");
		function* load(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		function* refresh(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		Work.mark(refresh);
		const Receiver = receiver<IPanel>("Refresh")({
			["Refresh" as any]: refresh
		});
		await bindAll(h, Receiver);
		const loading = h.runtime.dispatch(load, "a");
		await h.send("Refresh");
		await settled();
		function* reads(draft: IPanel): ISelectorGenerator<boolean[]> {
			return [
				yield* inFlight(load, draft),
				yield* inFlight(refresh, draft),
				yield* inFlight(Work, draft)
			];
		}
		await createRoot(async (dispose) => {
			const seen: boolean[][] = [];
			createEffect(() => {
				seen.push(h.runtime.runSelector(reads, () => h.panel()));
			});
			await settled();
			h.releases[0]!();
			await loading;
			await settled();
			h.releases[2]!();
			await settled();
			h.releases[1]!();
			await settled();
			expect(seen.filter((answers, at) => at === 0 || answers.join() !== seen[at - 1]!.join())).toEqual([
				[
					true,
					true,
					true
				],
				[
					false,
					true,
					true
				],
				[
					false,
					false,
					false
				]
			]);
			dispose();
		});
	});

	it("counts a receiver case that carries the tag, and a list mixing tags and actions", async () => {
		const h = build();
		const Work = workTag("Test/Work");
		const Other = workTag("Test/Work");
		function* refresh(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		Work.mark(refresh);
		function* plain(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		const Receiver = receiver<IPanel>("Refresh")({
			["Refresh" as any]: refresh
		});
		await bindAll(h, Receiver);
		await h.send("Refresh");
		expect([
			h.read(Work, "a"),
			h.read(Work, "b"),
			h.read(Other, "a")
		]).toEqual([
			true,
			true,
			false
		]);
		h.releases[0]!();
		h.releases[1]!();
		await settled();
		const running = h.runtime.dispatch(plain, "a");
		expect([
			h.read(Work),
			h.read([
				Work,
				plain
			]),
			h.read([
				Other,
				refresh
			])
		]).toEqual([
			false,
			true,
			false
		]);
		h.releases[2]!();
		await running;
	});

	it("records an action's tag read on the step it resumes", async () => {
		const h = build();
		const Work = workTag("Test/Work");
		function* load(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		Work.mark(load);
		const loading = h.runtime.dispatch(load, "a");
		const busy = await h.runtime.dispatch(function* reads(draft: IWorld): IActionGenerator<boolean> {
			return yield* inFlight(Work, draft.Panels[0]!);
		}, "root");
		expect(busy).toBe(true);
		const start = h.records.find((record) => record.Kind === "action:start" && record.Name === "reads");
		const actionId = start?.Kind === "action:start" ? start.ActionId : undefined;
		expect(h.records.filter((record) => record.Kind === "step" && record.ActionId === actionId)).toEqual([
			expect.objectContaining({
				InFlightAnswers: [
					true
				]
			})
		]);
		h.releases[0]!();
		await loading;
	});

	it("leaves the arrival policy working beside any number of tags", async () => {
		const h = build();
		const Work = workTag("Test/Work");
		const Busy = workTag("Test/Busy");
		function* once(draft: IPanel): IActionGenerator {
			yield* wait();
			draft.Log.push("once");
		}
		leading(once);
		Work.mark(once);
		Busy.mark(once);
		const first = h.runtime.dispatch(once, "a");
		await expect(h.runtime.dispatch(once, "a")).resolves.toBeUndefined();
		expect([
			h.read(Work),
			h.read(Busy)
		]).toEqual([
			true,
			true
		]);
		h.releases[0]!();
		await first;
		expect(h.panel().Log).toEqual([
			"once"
		]);
	});

	it("answers from a test runtime's stub that lists the tag, or an action carrying it", () => {
		const Work = workTag("Test/Work");
		function* tagged(_draft: IPanel): IActionGenerator {}
		Work.mark(tagged);
		function* untagged(_draft: IPanel): IActionGenerator {}
		const stubs: Record<string, readonly (Function | typeof Work)[]> = {
			a: [
				Work
			],
			b: [
				tagged
			]
		};
		const runtime = createTestRuntime<IWorld>(
			seed(),
			{},
			{
				inFlight: (ownerId) => stubs[ownerId]
			}
		);
		const panel = (id: string) => runtime.state.Panels.find((p) => p.$Id === id)!;
		expect([
			inFlightOf(runtime, Work, panel("a")),
			inFlightOf(runtime, tagged, panel("a")),
			inFlightOf(runtime, Work, panel("b")),
			inFlightOf(runtime, untagged, panel("b")),
			inFlightOf(runtime, Work, runtime.state)
		]).toEqual([
			true,
			false,
			true,
			false,
			false
		]);
	});

	it("refuses a second mark with one tag, a non-function, a nameless tag, and an object passed as a tag", async () => {
		const Work = workTag("Test/Work");
		function* save(_draft: IPanel): IActionGenerator {}
		function* load(_draft: IPanel): IActionGenerator {}
		Work.mark(save);
		// @ts-expect-error the draft is an entity.
		void (() => Work.mark(load, function* notOnEntity(_draft: { Runs: number }): IActionGenerator {}));
		expect(() => Work.mark(save)).toThrow('work tag "Test/Work": action "save" is already marked with it');
		expect(() => Work.mark(load, load)).toThrow('action "load" is already marked with it');
		expect(() => Work.mark("load" as unknown as typeof load)).toThrow("mark() takes action functions");
		expect(() => workTag("")).toThrow("workTag(): pass a name.");
		const h = build();
		expect(() =>
			h.read({
				name: "Test/Work",
				mark: () => {}
			} as unknown as typeof Work)
		).toThrow("inFlight(): pass an action or a work tag, or a list of them.");
	});

	it("refuses, in development, a mark on a function that has already arrived somewhere", async () => {
		const h = build();
		const Work = workTag("Test/Work");
		function* early(_draft: IPanel): IActionGenerator {}
		function* reached(_draft: IPanel): IActionGenerator {}
		await h.runtime.dispatch(early, "a");
		expect(() => Work.mark(early)).toThrow('action "early" has already been dispatched or delivered');
		const Receiver = receiver<IPanel>("Reached")({
			["Reach" as any]: reached
		});
		await bindAll(h, Receiver);
		await h.send("Reach");
		await settled();
		expect(() => Work.mark(reached)).toThrow('action "reached" has already been dispatched or delivered');
	});
});
