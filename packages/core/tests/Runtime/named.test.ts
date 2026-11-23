import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionTrace } from "../../src/Types/IActionTrace";
import type { IEntity } from "../../src/Types/IEntity";
import type { IMessageOf } from "../../src/Types/IReceiver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { actionNamed, callerModule, named, UnnamedActionError } from "../../src/Runtime/named";
import { receiver } from "../../src/Runtime/receiver";
import { workTag } from "../../src/Runtime/workTag";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { settled } from "../../src/Testing/createTestRuntime";
import { mountComponent } from "../testHelpers";
import { nameInA } from "./namedFixtureA";
import { nameInB } from "./namedFixtureB";
import { build, type IDoc, type IWorld, seed, wait } from "./namedShared";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"Named/Ping": {};
		"Named/Required": {};
	}
}

const publishAny = publish as unknown as (topic: string, data?: Record<string, unknown>) => Generator<any, void, any>;
const openResourceAny = openResource as unknown as (entity: object, key: string, ...rest: unknown[]) => IActionGenerator;

function* save(draft: IDoc, note: string): IActionGenerator<string> {
	draft.Note = note;
	yield* wait(note);
	return note;
}
named(save, "Doc/Save");

function* unnamedSave(draft: IDoc, note: string): IActionGenerator<string> {
	draft.Note = note;
	return note;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("named", () => {
	it("returns the action and keys it by name for the page", () => {
		function* returned(_draft: IDoc): IActionGenerator {}
		expect(named(returned, "Named/Returned")).toBe(returned);
		expect(actionNamed("Named/Returned")).toBe(returned);
		expect(actionNamed("Named/Nobody")).toBeUndefined();
	});

	it("refuses a second name, saying both", () => {
		function* twice(_draft: IDoc): IActionGenerator {}
		named(twice, "Named/Twice");
		expect(() => named(twice, "Named/Twice")).toThrow('action "twice" is already named "Named/Twice", and can\'t also be "Named/Twice"');
		expect(() => named(twice, "Named/Again")).toThrow('already named "Named/Twice", and can\'t also be "Named/Again"');
	});

	it("refuses what isn't a function or a non-empty string name", () => {
		function* refused(_draft: IDoc): IActionGenerator {}
		expect(() => named(null as never, "Named/Null")).toThrow(TypeError);
		expect(() => named(refused, "")).toThrow(TypeError);
		expect(() => named(refused, 5 as never)).toThrow(TypeError);
	});

	it("sits beside an arrival mark and a work tag", async () => {
		const Busy = workTag("Named/Busy");
		function* marked(draft: IDoc, note: string): IActionGenerator {
			draft.Note = note;
			yield* wait(note);
		}
		named(marked, "Named/Marked");
		latest(marked);
		Busy.mark(marked);
		const h = build();
		const first = h.runtime.dispatch(marked, "a", "one");
		const second = h.runtime.dispatch(marked, "a", "two");
		await settled();
		h.releases.get("two")!();
		await expect(first).resolves.toBeUndefined();
		await second;
		expect(h.starts().map((record) => record.Name)).toEqual([
			"Named/Marked",
			"Named/Marked"
		]);
	});

	it("refuses, in development, a mark on a function that has already been dispatched", async () => {
		function* early(draft: IDoc): IActionGenerator {
			draft.N++;
		}
		const h = build();
		await h.runtime.dispatch(early, "a");
		expect(() => named(early, "Named/Early")).toThrow('action "early" has already been dispatched or delivered');
	});

	it("replaces the function under a name marked again from the same module, as a hot reload does", () => {
		function* before(_draft: IDoc): IActionGenerator {}
		function* after(_draft: IDoc): IActionGenerator {}
		nameInA(before, "Named/Reloaded");
		expect(() => nameInA(after, "Named/Reloaded")).not.toThrow();
		expect(actionNamed("Named/Reloaded")).toBe(after);
	});

	it("refuses a name another module has given another function, naming both modules", () => {
		function* first(_draft: IDoc): IActionGenerator {}
		function* copied(_draft: IDoc): IActionGenerator {}
		nameInA(first, "Named/Copied");
		expect(() => nameInB(copied, "Named/Copied")).toThrow(
			/"Named\/Copied" already names action "first" in .*namedFixtureA\.ts, and .*namedFixtureB\.ts names "copied"/
		);
		expect(() => nameInB(copied, "Named/Copied")).toThrow(
			/If the action was moved to .*namedFixtureB\.ts during this session, reload the page/
		);
		expect(actionNamed("Named/Copied")).toBe(first);
	});

	it("counts a stack it can't read as a reload", () => {
		function* first(_draft: IDoc): IActionGenerator {}
		function* second(_draft: IDoc): IActionGenerator {}
		nameInA(first, "Named/Unread");
		const errors = Error as unknown as {
			stackTraceLimit: number;
		};
		const limit = errors.stackTraceLimit;
		errors.stackTraceLimit = 0;
		try {
			expect(() => nameInB(second, "Named/Unread")).not.toThrow();
		} finally {
			errors.stackTraceLimit = limit;
		}
		expect(actionNamed("Named/Unread")).toBe(second);
	});
});

describe("callerModule", () => {
	it("takes the first frame outside the one that took the stack, without its query string", () => {
		expect(
			callerModule(
				[
					"Error",
					"    at named (http://localhost:5173/node_modules/.vite/deps/treflex.js?v=1a2b:812:15)",
					"    at named (http://localhost:5173/node_modules/.vite/deps/treflex.js?v=1a2b:820:3)",
					"    at http://localhost:5173/src/features/counter.ts?t=1712345:14:1"
				].join("\n")
			)
		).toBe("http://localhost:5173/src/features/counter.ts");
		expect(
			callerModule(
				[
					"named@http://localhost:5173/node_modules/.vite/deps/treflex.js?v=1:812:15",
					"@http://localhost:5173/src/features/counter.ts?t=2:14:1"
				].join("\n")
			)
		).toBe("http://localhost:5173/src/features/counter.ts");
		expect(callerModule("    at Object.<anonymous> (/app/src/counter.ts:3:1)\n    at named (/app/src/counter.ts:4:1)")).toBeNull();
	});

	it("reads nothing from a stack with no frames", () => {
		expect(callerModule(undefined)).toBeNull();
		expect(callerModule("Error")).toBeNull();
	});
});

describe("what a name leaves", () => {
	it("puts Name and Label on action:start, and Receiver on a delivery's with no Name", async () => {
		const Doc = receiver<IDoc>("Named/DocReceiver")({
			*"Named/Ping"(draft) {
				draft.N++;
			}
		});
		const h = build();
		h.runtime.registerReceiver(Doc);
		await h.runtime.dispatch(function* binds(draft: IDoc): IActionGenerator {
			bind(draft, Doc);
		}, "a");
		await h.runtime.dispatch(function* (_draft: IWorld): IActionGenerator {
			yield* publishAny("Named/Ping");
		}, "root");
		const saving = h.runtime.dispatch(save, "a", "kept");
		await settled();
		h.releases.get("kept")!();
		await saving;
		expect(
			h.starts().map((record) => ({
				Name: record.Name,
				Label: record.Label,
				Receiver: record.Receiver
			}))
		).toEqual([
			{
				Name: null,
				Label: "binds",
				Receiver: undefined
			},
			{
				Name: null,
				Label: null,
				Receiver: undefined
			},
			{
				Name: null,
				Label: "Named/DocReceiver",
				Receiver: "Named/DocReceiver"
			},
			{
				Name: "Doc/Save",
				Label: "save",
				Receiver: undefined
			}
		]);
		expect(h.starts().filter((record) => "Receiver" in record)).toHaveLength(1);
	});

	it("puts Name and Label on a snapshot's in-flight entry", async () => {
		const h = build();
		const saving = h.runtime.dispatch(save, "a", "held");
		await settled();
		expect(JSON.parse(createSnapshot(h.runtime)).InFlight).toEqual([
			{
				ActionId: expect.any(String),
				Name: "Doc/Save",
				Label: "save",
				EntityId: "a",
				State: "holding"
			}
		]);
		h.releases.get("held")!();
		await saving;
	});

	it("puts Name and Label on the failure event, the Action/Error payload and onError's context", async () => {
		function* failsNamed(_draft: IDoc): IActionGenerator {
			throw new Error("boom");
		}
		named(failsNamed, "Named/Fails");
		const heard: IMessageOf<"Action/Error">[] = [];
		const ErrorBoundary = receiver<IWorld>("Named/ErrorBoundary")({
			*"Action/Error"(_draft, failure) {
				heard.push(failure);
			}
		});
		const h = build();
		h.runtime.registerReceiver(ErrorBoundary);
		await h.runtime.dispatch(function* (draft: IWorld): IActionGenerator {
			bind(draft, ErrorBoundary);
		}, "root");
		await h.runtime.dispatch(failsNamed, "a").catch(() => {});
		await settled();
		expect(
			heard.map((failure) => [
				failure.Name,
				failure.Label
			])
		).toEqual([
			[
				"Named/Fails",
				"failsNamed"
			]
		]);
		expect(
			h.failures.map((failure) => [
				failure.Name,
				failure.Label
			])
		).toEqual([
			[
				"Named/Fails",
				"failsNamed"
			]
		]);

		const contexts: unknown[] = [];
		const top = createRuntime<IWorld>(seed(), {
			onError: (_error, context) => contexts.push(context)
		});
		await top.dispatch(failsNamed, "a").catch(() => {});
		await settled();
		expect(contexts).toEqual([
			{
				Name: "Named/Fails",
				Label: "failsNamed",
				EntityId: "a"
			}
		]);
	});

	it("puts name and label on a trace", async () => {
		const h = build();
		const traces: IActionTrace[] = [];
		createTraceAggregator(h.runtime, (trace) => traces.push(trace));
		const saving = h.runtime.dispatch(save, "a", "traced");
		await settled();
		h.releases.get("traced")!();
		await saving;
		expect(
			traces.map((trace) => [
				trace.name,
				trace.label
			])
		).toEqual([
			[
				"Doc/Save",
				"save"
			]
		]);
	});

	it("shows the name in a message, and the label when there is none", async () => {
		function* holds(_draft: IDoc): IActionGenerator {
			yield* wait("long");
		}
		named(holds, "Named/Holds");
		const h = build();
		vi.useFakeTimers();
		try {
			const held = h.runtime.dispatch(holds, "a");
			const queued = h.runtime.dispatch(unnamedSave, "a", "x");
			await vi.advanceTimersByTimeAsync(1500);
			const longHold = h.diags.find((event) => event.code === "action/long-hold")!;
			expect(longHold.message).toContain('Action "Named/Holds" has held entity "a"');
			expect(longHold.data?.queued).toEqual([
				"unnamedSave"
			]);
			h.releases.get("long")!();
			await held;
			await queued;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("requireNames in development", () => {
	it("rejects runtime.dispatch of an unnamed action with UnnamedActionError, before it starts", async () => {
		const h = build({
			requireNames: true
		});
		await expect(h.runtime.dispatch(unnamedSave, "a", "x")).rejects.toBeInstanceOf(UnnamedActionError);
		await expect(h.runtime.dispatch(unnamedSave, "a", "x")).rejects.toThrow('action "unnamedSave" has no durable name');
		expect(h.starts()).toEqual([]);
		expect(h.runtime.state.Docs[0]!.Note).toBe("");
	});

	it("throws UnnamedActionError in the starter at a start's yield", async () => {
		const caught: unknown[] = [];
		function* starts(draft: IWorld): IActionGenerator {
			try {
				yield* start(unnamedSave, draft.Docs[0]!, "x");
			} catch (error) {
				caught.push(error);
			}
		}
		named(starts, "Named/Starts");
		const h = build({
			requireNames: true
		});
		await h.runtime.dispatch(starts, "root");
		await settled();
		expect(caught).toHaveLength(1);
		expect(caught[0]).toBeInstanceOf(UnnamedActionError);
		expect(h.starts().map((record) => record.Name)).toEqual([
			"Named/Starts"
		]);
	});

	it("runs a named action, a delivery, an r.run action and component-state work", async () => {
		const Doc = receiver<IDoc>("Named/RequiredReceiver")({
			*"Named/Required"(draft) {
				draft.N++;
			}
		});
		function* binds(draft: IDoc): IActionGenerator {
			bind(draft, Doc);
		}
		named(binds, "Named/Binds");
		function* pings(_draft: IWorld): IActionGenerator {
			yield* publishAny("Named/Required");
		}
		named(pings, "Named/Pings");
		let run!: Promise<unknown>;
		function* opens(draft: IDoc): IActionGenerator {
			yield* openResourceAny(draft, "Named/Run", {
				Type: "named/run"
			});
		}
		named(opens, "Named/Opens");
		const h = build({
			requireNames: true
		});
		h.runtime.registerReceiver(Doc);
		(
			h.runtime as unknown as {
				registerResourceType(type: string, impl: (params: unknown, r: any) => void): void;
			}
		).registerResourceType("named/run", (_params, r) => {
			run = r.run(
				(function* inRun(): IActionGenerator<string> {
					return "ran";
				})()
			);
		});
		await h.runtime.dispatch(binds, "a");
		await h.runtime.dispatch(pings, "root");
		await settled();
		expect(h.runtime.state.Docs[0]!.N).toBe(1);
		await h.runtime.dispatch(opens, "a");
		await settled();
		await expect(run).resolves.toBe("ran");
		const id = mountComponent(h.runtime, "a", {
			Typed: ""
		});
		await expect(
			h.runtime.dispatch(function* types(
				draft: IEntity & {
					Typed: string;
				}
			): IActionGenerator {
				draft.Typed = "x";
			}, id)
		).resolves.toBeUndefined();
	});

	it("requires nothing of a runtime without it: an unnamed action records Name: null", async () => {
		const h = build();
		await expect(h.runtime.dispatch(unnamedSave, "a", "x")).resolves.toBe("x");
		expect(
			h.starts().map((record) => [
				record.Name,
				record.Label
			])
		).toEqual([
			[
				null,
				"unnamedSave"
			]
		]);
	});
});

describe("build", () => {
	it("takes a non-empty string or nothing, and throws TypeError for anything else", () => {
		expect(() =>
			createRuntime(
				{
					$Id: "r"
				},
				{
					build: ""
				}
			)
		).toThrow(TypeError);
		expect(() =>
			createRuntime(
				{
					$Id: "r"
				},
				{
					build: 5 as never
				}
			)
		).toThrow(TypeError);
		expect(() =>
			createRuntime(
				{
					$Id: "r"
				},
				{
					build: null as never
				}
			)
		).toThrow(TypeError);
		expect(() =>
			createRuntime(
				{
					$Id: "r"
				},
				{
					build: "2026-11-18T10:00:00Z"
				}
			).dispose()
		).not.toThrow();
		expect(() =>
			createRuntime(
				{
					$Id: "r"
				},
				{
					build: undefined
				}
			).dispose()
		).not.toThrow();
	});
});
