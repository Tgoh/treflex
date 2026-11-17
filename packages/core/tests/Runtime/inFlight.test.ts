import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { select } from "../../src/Reads/select";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { inFlight } from "../../src/Runtime/arrivals";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { seat } from "../../src/Runtime/draftNode";
import { open } from "../../src/Runtime/open";
import { createTestRuntime, settled } from "../../src/Testing/createTestRuntime";
import { inFlightOf } from "../testHelpers";

interface IPanel extends IEntity {
	Log: string[];
}

interface IRow extends IEntity {
	Log: string[];
}

interface IWorld extends IEntity {
	Panels: IPanel[];
	Rows: IRow[];
}

function seed(): IWorld {
	return {
		$Id: "root",
		Panels: [
			{
				$Id: "panel",
				Log: []
			}
		],
		Rows: []
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
	const panel = () => runtime.state.Panels[0]!;
	return {
		runtime,
		releases,
		records,
		panel,
		steps: () => records.filter((record) => record.Kind === "step"),
		read: (action: Function | readonly Function[]) => inFlightOf(runtime, action, panel())
	};
}

function* wait(): Generator<any, unknown, any> {
	return yield {
		Type: "wait"
	};
}

function* load(draft: IPanel): IActionGenerator {
	yield* wait();
	draft.Log.push("loaded");
}

function* save(draft: IPanel): IActionGenerator {
	yield* wait();
	draft.Log.push("saved");
}

function* loading(draft: IPanel): ISelectorGenerator<boolean> {
	return yield* inFlight(load, draft);
}

describe("inFlight(action, owner)", () => {
	it("covers a normal action from arrival to its end, queued included, and re-derives a memoized selector a view reads", async () => {
		const h = build();
		await createRoot(async (dispose) => {
			const seen: boolean[] = [];
			createEffect(() => {
				seen.push(h.runtime.runSelector(loading, h.panel));
			});
			await settled();
			const first = h.runtime.dispatch(load, "panel");
			const second = h.runtime.dispatch(load, "panel");
			await settled();
			h.releases[0]();
			await first;
			expect(h.read(load)).toBe(true);
			await settled();
			h.releases[1]();
			await second;
			await settled();
			expect(seen).toEqual([
				false,
				true,
				false
			]);
			dispose();
		});
	});

	it("keeps the gate and the arrivals right when a view reading it throws on each change", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = build();
		const once = leading(function* once(draft: IPanel): IActionGenerator {
			yield* wait();
			draft.Log.push("saved");
		});
		function* note(draft: IPanel): IActionGenerator {
			draft.Log.push("noted");
		}
		await createRoot(async (dispose) => {
			let first = true;
			createEffect(() => {
				const now = h.read(once);
				if (first) {
					first = false;
					return;
				}
				throw new Error(`a view saw ${now}`);
			});
			await settled();
			const one = h.runtime.dispatch(once, "panel");
			await settled();
			h.releases[0]?.();
			await one.catch(() => {});
			await settled();
			const noted = h.runtime.dispatch(note, "panel");
			await settled();
			expect(h.panel().Log).toEqual([
				"saved",
				"noted"
			]);
			const two = h.runtime.dispatch(once, "panel");
			await settled();
			expect(h.releases).toHaveLength(2);
			h.releases[1]?.();
			await Promise.all([
				two.catch(() => {}),
				noted
			]);
			expect(h.panel().Log).toEqual([
				"saved",
				"noted",
				"saved"
			]);
			dispose();
		});
		warn.mockRestore();
	});

	it("doesn't let a view that dispatches when it flips go ahead of the action that arrived first", async () => {
		const h = build();
		const order: string[] = [];
		function* slow(_draft: IPanel): IActionGenerator {
			order.push("slow:start");
			yield* wait();
			order.push("slow:end");
		}
		function* note(_draft: IPanel): IActionGenerator {
			order.push("note");
		}
		await createRoot(async (dispose) => {
			let dispatched = false;
			createEffect(() => {
				if (h.read(slow) && !dispatched) {
					dispatched = true;
					void h.runtime.dispatch(note, "panel");
				}
			});
			await settled();
			const first = h.runtime.dispatch(slow, "panel");
			await settled();
			h.releases[0]();
			await first;
			await settled();
			expect(order).toEqual([
				"slow:start",
				"slow:end",
				"note"
			]);
			dispose();
		});
	});

	it("covers an action through a wait that lets others in, and reads from a draft of another action", async () => {
		const h = build();
		function* opens(draft: IPanel) {
			yield* open(wait());
			draft.Log.push("saved");
		}
		const saving = h.runtime.dispatch(opens, "panel");
		expect(h.read(opens)).toBe(true);
		const seenFromDraft = await h.runtime.dispatch(function* reads(draft: IWorld): IActionGenerator<boolean> {
			return yield* inFlight(opens, draft.Panels[0]!);
		}, "root");
		expect(seenFromDraft).toBe(true);
		h.releases[0]();
		await saving;
		expect(h.read(opens)).toBe(false);
	});

	it("starts clear for a row re-added under the same $Id after the old one was removed mid-run", async () => {
		const h = build();
		const once = leading(function* once(draft: IRow): IActionGenerator {
			yield* wait();
			draft.Log.push("saved");
		});
		function* addsRow(draft: IWorld): IActionGenerator {
			seat(draft.Rows, draft.Rows.length, {
				$Id: "row",
				Log: []
			});
		}
		const row = () => h.runtime.state.Rows[0]!;
		const read = () => inFlightOf(h.runtime, once, row());
		await h.runtime.dispatch(addsRow, "root");
		const stopped = h.runtime.dispatch(once, "row");
		expect(read()).toBe(true);
		await h.runtime.dispatch(function* removesRows(draft: IWorld): IActionGenerator {
			draft.Rows = [];
		}, "root");
		await expect(stopped).resolves.toBeUndefined();
		await h.runtime.dispatch(addsRow, "root");
		expect(read()).toBe(false);
		const again = h.runtime.dispatch(once, "row");
		expect(read()).toBe(true);
		expect(h.releases).toHaveLength(2);
		h.releases[1]();
		await again;
		expect(read()).toBe(false);
		expect(row().Log).toEqual([
			"saved"
		]);
	});

	it("reads an action that has ended as not running, to the work queued behind it", async () => {
		const h = build();
		function* next(draft: IPanel): IActionGenerator<boolean> {
			return yield* inFlight(load, draft);
		}
		const first = h.runtime.dispatch(load, "panel");
		const second = h.runtime.dispatch(next, "panel");
		h.releases[0]();
		await first;
		expect(await second).toBe(false);
	});

	it("doesn't count a yield* call, which has no arrival", async () => {
		const h = build();
		const outer = h.runtime.dispatch(function* outer(draft: IPanel): IActionGenerator {
			yield* load(draft);
		}, "panel");
		expect(h.read(load)).toBe(false);
		h.releases[0]();
		await outer;
	});
});

describe("inFlight as a read", () => {
	it("records an action's answer on the step it resumes, with no effect record, and a step for a read that writes nothing", async () => {
		const h = build();
		const loads = h.runtime.dispatch(load, "panel");
		await h.runtime.dispatch(function* reads(draft: IWorld): IActionGenerator {
			const busy = yield* inFlight(load, draft.Panels[0]!);
			draft.Panels[0]!.Log.push(`busy:${busy}`);
			yield* inFlight(save, draft.Panels[0]!);
		}, "root");
		const start = h.records.find((record) => record.Kind === "action:start" && record.Name === "reads");
		const actionId = start?.Kind === "action:start" ? start.ActionId : undefined;
		const own = h.records.filter((record) => "ActionId" in record && record.ActionId === actionId);
		expect(own.filter((record) => record.Kind === "effect")).toEqual([]);
		expect(own.filter((record) => record.Kind === "step")).toEqual([
			expect.objectContaining({
				Changes: expect.arrayContaining([
					expect.objectContaining({
						Value: "busy:true"
					})
				]),
				InFlightAnswers: [
					true
				]
			}),
			expect.objectContaining({
				Changes: [],
				InFlightAnswers: [
					false
				]
			})
		]);
		expect(h.steps().filter((record) => record.Kind === "step" && record.ActionId !== actionId && "InFlightAnswers" in record)).toEqual([]);
		h.releases[0]();
		await loads;
	});

	it("reads true for a list when any action in it is running, and re-derives on each", async () => {
		const h = build();
		function* busy(draft: IPanel): ISelectorGenerator<boolean> {
			return yield* inFlight(
				[
					load,
					save
				],
				draft
			);
		}
		await createRoot(async (dispose) => {
			const seen: boolean[] = [];
			createEffect(() => {
				seen.push(h.runtime.runSelector(busy, h.panel));
			});
			await settled();
			const saving = h.runtime.dispatch(save, "panel");
			await settled();
			expect(
				h.read([
					load
				])
			).toBe(false);
			h.releases[0]();
			await saving;
			await settled();
			const loading = h.runtime.dispatch(load, "panel");
			await settled();
			h.releases[1]();
			await loading;
			await settled();
			expect(seen).toEqual([
				false,
				true,
				false,
				true,
				false
			]);
			expect(h.read([])).toBe(false);
			expect(() =>
				h.read([
					load,
					"save" as unknown as Function
				])
			).toThrow("inFlight(): pass an action or a work tag, or a list of them.");
			dispose();
		});
	});

	it("reads a marked function as the one function it is, dispatched before or after the mark", async () => {
		const h = build();
		function* store(draft: IPanel): IActionGenerator {
			yield* wait();
			draft.Log.push("stored");
		}
		await createRoot(async (dispose) => {
			const seen: boolean[] = [];
			createEffect(() => {
				seen.push(h.read(store));
			});
			await settled();
			const plain = h.runtime.dispatch(store, "panel");
			await settled();
			expect(latest(store)).toBe(store);
			h.releases[0]();
			await plain;
			await settled();
			const last = h.runtime.dispatch(store, "panel");
			await settled();
			h.releases[1]();
			await last;
			await settled();
			expect(seen).toEqual([
				false,
				true,
				false,
				true,
				false
			]);
			dispose();
		});
		await expect(
			h.runtime.dispatch(function* other(draft: IPanel): IActionGenerator<boolean> {
				return yield* inFlight(load, draft);
			}, "panel")
		).resolves.toBe(false);
	});

	it("answers from a test runtime's stub once per read, matched as the record is, in an action and a selector, on top of the record", async () => {
		function* stub(_draft: IPanel): IActionGenerator {}
		leading(stub);
		const asked: string[] = [];
		const runtime = createTestRuntime<IWorld>(
			seed(),
			{
				wait: () => new Promise(() => {})
			},
			{
				inFlight: (ownerId) => {
					asked.push(ownerId);
					return ownerId === "panel"
						? [
								stub
							]
						: undefined;
				}
			}
		);
		const records: IRecord[] = [];
		runtime.on("record", (record) => records.push(record));
		const panel = () => runtime.state.Panels[0]!;
		expect([
			inFlightOf(runtime, stub, panel()),
			inFlightOf(runtime, stub, runtime.state)
		]).toEqual([
			true,
			false
		]);
		asked.length = 0;
		expect(
			inFlightOf(
				runtime,
				[
					load,
					save,
					stub
				],
				panel()
			)
		).toBe(true);
		expect(asked).toEqual([
			"panel"
		]);
		expect(inFlightOf(runtime, load, panel())).toBe(false);
		void runtime.dispatch(load, "panel");
		expect(inFlightOf(runtime, load, panel())).toBe(true);
		const answers = await runtime.dispatch(function* reads(draft: IWorld): IActionGenerator<boolean[]> {
			return [
				yield* inFlight(stub, draft.Panels[0]!),
				yield* inFlight(save, draft.Panels[0]!)
			];
		}, "root");
		expect(answers).toEqual([
			true,
			false
		]);
		expect(records.filter((record) => record.Kind === "step").map((record) => record.Kind === "step" && record.InFlightAnswers)).toEqual([
			[
				true
			],
			[
				false
			]
		]);
	});

	it("answers an action's select fresh, past a memo a view built, and records the nested answers on the step", async () => {
		const h = build();
		function* saving(draft: IPanel): ISelectorGenerator<boolean> {
			return yield* inFlight(save, draft);
		}
		function* both(draft: IPanel): ISelectorGenerator<boolean[]> {
			return [
				yield* select(saving),
				yield* inFlight(load, draft)
			];
		}
		await createRoot(async (dispose) => {
			createEffect(() => {
				h.runtime.runSelector(saving, h.panel);
				h.runtime.runSelector(both, h.panel);
			});
			await settled();
			const saves = h.runtime.dispatch(save, "panel");
			const read = await h.runtime.dispatch(function* reads(_draft: IWorld): IActionGenerator<boolean[]> {
				return yield* select(both, (world: IWorld) => world.Panels[0]);
			}, "root");
			expect(read).toEqual([
				true,
				false
			]);
			const start = h.records.find((record) => record.Kind === "action:start" && record.Name === "reads");
			const actionId = start?.Kind === "action:start" ? start.ActionId : undefined;
			expect(h.steps().filter((record) => record.Kind === "step" && record.ActionId === actionId)).toEqual([
				expect.objectContaining({
					InFlightAnswers: [
						true,
						false
					]
				})
			]);
			h.releases[0]();
			await saves;
			dispose();
		});
	});

	it("records the answers a selected guard read before it threw, on the step the throw resumes", async () => {
		const h = build();
		function* notSaving(draft: IPanel): ISelectorGenerator<true> {
			if (yield* inFlight(save, draft)) {
				throw new Error("busy");
			}
			return true;
		}
		const saves = h.runtime.dispatch(save, "panel");
		const refused = await h.runtime.dispatch(function* guarded(_draft: IWorld): IActionGenerator<string> {
			try {
				yield* select(notSaving, (world: IWorld) => world.Panels[0]);
				return "ran";
			} catch (error) {
				return (error as Error).message;
			}
		}, "root");
		expect(refused).toBe("busy");
		const start = h.records.find((record) => record.Kind === "action:start" && record.Name === "guarded");
		const actionId = start?.Kind === "action:start" ? start.ActionId : undefined;
		expect(h.steps().filter((record) => record.Kind === "step" && record.ActionId === actionId)).toEqual([
			expect.objectContaining({
				Changes: [],
				InFlightAnswers: [
					true
				]
			})
		]);
		h.releases[0]();
		await saves;
	});

	it("updates a memo over a function marked after the memo first ran", async () => {
		const h = build();
		function* stash(_draft: IPanel): IActionGenerator {
			yield* wait();
		}
		function* stashing(draft: IPanel): ISelectorGenerator<boolean> {
			return yield* inFlight(stash, draft);
		}
		await createRoot(async (dispose) => {
			const seen: boolean[] = [];
			createEffect(() => {
				seen.push(h.runtime.runSelector(stashing, h.panel));
			});
			await settled();
			const stashed = h.runtime.dispatch(latest(stash), "panel");
			await settled();
			h.releases[0]();
			await stashed;
			await settled();
			expect(seen).toEqual([
				false,
				true,
				false
			]);
			dispose();
		});
	});

	it("refuses a stub-map entry under its Type: the read is the runtime's", () => {
		expect(() =>
			createTestRuntime<IWorld>(seed(), {
				inFlight: () => true
			})
		).toThrow('"inFlight" is a read');
	});

	it("refuses an owner a plain object stands for, in an action as in a selector", async () => {
		const h = build();
		await expect(
			h.runtime.dispatch(function* reads(_draft: IPanel): IActionGenerator<boolean> {
				return yield* inFlight(load, {
					$Id: "panel"
				});
			}, "panel")
		).rejects.toThrow("the owner is a plain object");
	});
});
