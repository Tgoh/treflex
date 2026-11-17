import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { settled } from "../../src/Testing/createTestRuntime";
import { inFlightOf } from "../testHelpers";

interface IDoc extends IEntity {
	Log: string[];
}

interface IWorld extends IEntity {
	Log: string[];
	Docs: IDoc[];
}

function build() {
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Log: [],
			Docs: [
				{
					$Id: "doc",
					Log: []
				}
			]
		},
		{
			onError: () => {}
		}
	);
	const releases = new Map<string, () => void>();
	runtime.registerImplementation(
		"test/wait",
		(effect: { Type: string; Name: string }) =>
			new Promise<void>((resolve) => {
				releases.set(effect.Name, resolve);
			})
	);
	const release = async (name: string): Promise<void> => {
		const resolve = releases.get(name);
		if (!resolve) {
			throw new Error(`nothing waits on "${name}"`);
		}
		releases.delete(name);
		resolve();
		await settled();
	};
	const doc = () => runtime.state.Docs[0]!;
	const inFlight = () =>
		(runtime as IRuntimeInternal<IWorld>)
			.get("runtime/inFlightActions")()
			.map((entry) => entry.Label);
	return {
		runtime,
		releases,
		release,
		doc,
		inFlight
	};
}

function* wait(name: string): Generator<any, unknown, any> {
	return yield {
		Type: "test/wait",
		Name: name
	};
}

function* slow(draft: IDoc, name = "slow"): IActionGenerator {
	draft.Log.push(`${name}:start`);
	yield* wait(name);
	draft.Log.push(`${name}:end`);
}

const save = leading(function* saveDoc(draft: IDoc): IActionGenerator {
	draft.Log.push("save:start");
	yield* wait("save");
	draft.Log.push("save:end");
});

const sendThenConfirm = leading(function* sendThenConfirm(draft: IDoc) {
	yield* open(wait("send"));
	yield* wait("confirm");
	draft.Log.push("confirmed");
});

describe("the record of running work, at each move through the gate", () => {
	it("counts an arrival that takes a free gate, and drops its repeat", async () => {
		const h = build();
		const first = h.runtime.dispatch(save, "doc");
		expect(inFlightOf(h.runtime, save, h.doc())).toBe(true);
		await expect(h.runtime.dispatch(save, "doc")).resolves.toBeUndefined();
		await h.release("save");
		await first;
		expect(inFlightOf(h.runtime, save, h.doc())).toBe(false);
	});

	it("counts an arrival queued behind other work, and drops its repeat", async () => {
		const h = build();
		const blocker = h.runtime.dispatch(slow, "doc");
		const queued = h.runtime.dispatch(save, "doc");
		await settled();
		expect(h.doc().Log).toEqual([
			"slow:start"
		]);
		expect(inFlightOf(h.runtime, save, h.doc())).toBe(true);
		await expect(h.runtime.dispatch(save, "doc")).resolves.toBeUndefined();
		await h.release("slow");
		await h.release("save");
		await Promise.all([
			blocker,
			queued
		]);
		expect(inFlightOf(h.runtime, save, h.doc())).toBe(false);
	});

	it("counts a queued arrival once the pump begins it, and drops its repeat", async () => {
		const h = build();
		const blocker = h.runtime.dispatch(slow, "doc");
		const queued = h.runtime.dispatch(save, "doc");
		await h.release("slow");
		expect(h.doc().Log).toEqual([
			"slow:start",
			"slow:end",
			"save:start"
		]);
		expect(inFlightOf(h.runtime, save, h.doc())).toBe(true);
		await expect(h.runtime.dispatch(save, "doc")).resolves.toBeUndefined();
		await h.release("save");
		await Promise.all([
			blocker,
			queued
		]);
	});

	it("counts a run that takes its hold back at once, and drops its repeat", async () => {
		const h = build();
		const first = h.runtime.dispatch(sendThenConfirm, "doc");
		await h.release("send");
		expect([
			...h.releases.keys()
		]).toEqual([
			"confirm"
		]);
		expect(inFlightOf(h.runtime, sendThenConfirm, h.doc())).toBe(true);
		await expect(h.runtime.dispatch(sendThenConfirm, "doc")).resolves.toBeUndefined();
		await h.release("confirm");
		await first;
		expect(inFlightOf(h.runtime, sendThenConfirm, h.doc())).toBe(false);
	});

	it("counts a run queued to take its hold back behind work that got in, and drops its repeat", async () => {
		const h = build();
		const first = h.runtime.dispatch(sendThenConfirm, "doc");
		await settled();
		const blocker = h.runtime.dispatch(slow, "doc");
		await h.release("send");
		expect([
			...h.releases.keys()
		]).toEqual([
			"slow"
		]);
		expect(inFlightOf(h.runtime, sendThenConfirm, h.doc())).toBe(true);
		await expect(h.runtime.dispatch(sendThenConfirm, "doc")).resolves.toBeUndefined();
		await h.release("slow");
		await h.release("confirm");
		await Promise.all([
			first,
			blocker
		]);
		expect(inFlightOf(h.runtime, sendThenConfirm, h.doc())).toBe(false);
	});

	it("lists a queued run its replacement stopped until it settles, and no longer after", async () => {
		const h = build();
		const load = latest(function* loadDoc(draft: IDoc, name: string): IActionGenerator {
			yield* slow(draft, name);
		});
		const blocker = h.runtime.dispatch(slow, "doc");
		const replaced = h.runtime.dispatch(load, "doc", "a");
		const replacing = h.runtime.dispatch(load, "doc", "b");
		await expect(replaced).resolves.toBeUndefined();
		expect(h.inFlight()).toEqual([
			"slow",
			"loadDoc"
		]);
		expect(inFlightOf(h.runtime, load, h.doc())).toBe(true);
		await h.release("slow");
		await h.release("b");
		await Promise.all([
			blocker,
			replacing
		]);
		expect(inFlightOf(h.runtime, load, h.doc())).toBe(false);
		expect(h.doc().Log).toEqual([
			"slow:start",
			"slow:end",
			"b:start",
			"b:end"
		]);
	});

	it("flips a view reading it when a stopped root settles ahead of its stopped branch", async () => {
		const h = build();
		const act = latest(function* act(_draft: IDoc, park: boolean): IActionGenerator {
			if (park) {
				yield* parallel(wait("forever"));
			}
		});
		await createRoot(async (dispose) => {
			const seen: boolean[] = [];
			createEffect(() => {
				seen.push(inFlightOf(h.runtime, act, h.doc()));
			});
			await settled();
			const done = h.runtime.dispatch(act, "doc", true);
			await settled();
			await h.runtime.dispatch(act, "doc", false);
			await done;
			await settled();
			expect(inFlightOf(h.runtime, act, h.doc())).toBe(false);
			expect(seen).toEqual([
				false,
				true,
				false
			]);
			dispose();
		});
	});

	it("drops a repeat without leaving it counted or listed", async () => {
		const h = build();
		const first = h.runtime.dispatch(save, "doc");
		await expect(h.runtime.dispatch(save, "doc")).resolves.toBeUndefined();
		expect(h.inFlight()).toEqual([
			"saveDoc"
		]);
		await h.release("save");
		await first;
		expect(inFlightOf(h.runtime, save, h.doc())).toBe(false);
		expect(h.inFlight()).toEqual([]);
	});
});
