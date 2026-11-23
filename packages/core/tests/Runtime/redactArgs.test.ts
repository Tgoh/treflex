import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionTrace } from "../../src/Types/IActionTrace";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { start } from "../../src/Effects/start";
import * as core from "../../src/index";
import { resumable } from "../../src/Resume/resumable";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { named } from "../../src/Runtime/named";
import { receiver } from "../../src/Runtime/receiver";
import { argsRedacted, redactArgs } from "../../src/Runtime/redactArgs";
import { build, type IDoc, type IWorld } from "./namedShared";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"RedactArgs/Ping": {};
	}
}

type IEffectRecord = Extract<
	IRecord,
	{
		Kind: "effect";
	}
>;

function startDescriptors(records: IRecord[]): Record<string, unknown>[] {
	return records
		.filter((record): record is IEffectRecord => record.Kind === "effect" && record.Type === "start")
		.map((record) => record.Descriptor as Record<string, unknown>);
}

describe("redactArgs", () => {
	it("is exported from treflex, marks the action and returns it", () => {
		function* login(draft: IDoc, _user: string, _password: string): IActionGenerator {
			draft.N++;
		}
		expect(core.redactArgs).toBe(redactArgs);
		expect(redactArgs(login)).toBe(login);
		expect(argsRedacted(login)).toBe(true);
	});

	it("keeps the arguments out of action:start, and the action still receives them", async () => {
		const received: unknown[][] = [];
		function* login(draft: IDoc, user: string, password: string): IActionGenerator {
			received.push([
				user,
				password
			]);
			draft.Note = user;
		}
		redactArgs(login);
		const h = build();
		await h.runtime.dispatch(login, "a", "ada", "hunter2");
		expect(received).toEqual([
			[
				"ada",
				"hunter2"
			]
		]);
		const [record] = h.starts();
		expect(record?.Args).toEqual([]);
		expect(record?.ArgsRedacted).toBe(true);
		expect(JSON.stringify(h.records)).not.toContain("hunter2");
	});

	it("leaves an unmarked action's record as it was", async () => {
		function* plain(draft: IDoc, note: string): IActionGenerator {
			draft.Note = note;
		}
		const h = build();
		await h.runtime.dispatch(plain, "a", "shown");
		const [record] = h.starts();
		expect(record?.Args).toEqual([
			"shown"
		]);
		expect(record && "ArgsRedacted" in record).toBe(false);
	});

	it("keeps the arguments out of the start descriptor and the started action's record", async () => {
		const received: unknown[] = [];
		function* login(_draft: IDoc, password: string): IActionGenerator {
			received.push(password);
		}
		redactArgs(login);
		function* parent(_draft: IWorld): IActionGenerator {
			yield* start(login, "a", "hunter2");
		}
		function* plain(_draft: IDoc, _note: string): IActionGenerator {}
		function* plainParent(_draft: IWorld): IActionGenerator {
			yield* start(plain, "a", "shown");
		}
		const h = build();
		await h.runtime.dispatch(parent, "root");
		await h.runtime.dispatch(plainParent, "root");
		await core.settled();
		expect(received).toEqual([
			"hunter2"
		]);
		const [redacted, shown] = startDescriptors(h.records);
		expect(redacted).toMatchObject({
			Type: "start",
			EntityId: "a",
			Label: "login",
			Args: [],
			ArgsRedacted: true
		});
		expect(shown).toMatchObject({
			Args: [
				"shown"
			]
		});
		expect(shown && "ArgsRedacted" in shown).toBe(false);
		const started = h.starts().find((record) => record.Label === "login");
		expect(started).toMatchObject({
			Args: [],
			ArgsRedacted: true
		});
		expect(JSON.stringify(h.records)).not.toContain("hunter2");
	});

	it("flags the trace", async () => {
		function* login(_draft: IDoc, _password: string): IActionGenerator {}
		redactArgs(login);
		function* plain(_draft: IDoc, _note: string): IActionGenerator {}
		const h = build();
		const traces: IActionTrace[] = [];
		createTraceAggregator(h.runtime, (trace) => traces.push(trace));
		await h.runtime.dispatch(login, "a", "hunter2");
		await h.runtime.dispatch(plain, "a", "shown");
		expect(traces[0]).toMatchObject({
			label: "login",
			args: [],
			argsRedacted: true
		});
		expect(traces[1]?.args).toEqual([
			"shown"
		]);
		expect(traces[1] && "argsRedacted" in traces[1]).toBe(false);
	});

	it("throws for a value that isn't a function", () => {
		expect(() => redactArgs(undefined as never)).toThrow(TypeError);
	});

	it("throws when marked twice", () => {
		function* login(_draft: IDoc, _password: string): IActionGenerator {}
		redactArgs(login);
		expect(() => redactArgs(login)).toThrow('action "login" is already marked redactArgs');
	});

	it("throws on a resumable action, and resumable throws on a redacted one", () => {
		function* kept(_draft: IDoc, _password: string): IActionGenerator {}
		named(kept, "RedactArgs/Kept");
		resumable(kept);
		expect(() => redactArgs(kept)).toThrow('action "RedactArgs/Kept" is marked resumable');
		expect(argsRedacted(kept)).toBe(false);

		function* withheld(_draft: IDoc, _password: string): IActionGenerator {}
		named(withheld, "RedactArgs/Withheld");
		redactArgs(withheld);
		expect(() => resumable(withheld)).toThrow('action "RedactArgs/Withheld" is marked redactArgs');
	});

	it("refuses, in development, a mark on a function that has already been dispatched", async () => {
		function* early(_draft: IDoc, _password: string): IActionGenerator {}
		const h = build();
		await h.runtime.dispatch(early, "a", "hunter2");
		expect(() => redactArgs(early)).toThrow('action "early" has already been dispatched or delivered');
		expect(argsRedacted(early)).toBe(false);
	});

	it("throws on a receiver's handle", () => {
		const Doc = receiver<IDoc>("RedactArgs/Receiver")({
			*"RedactArgs/Ping"(draft) {
				draft.N++;
			}
		});
		expect(() => redactArgs(Doc.handle as never)).toThrow("is a receiver's handle");
		expect(argsRedacted(Doc.handle)).toBe(false);
	});
});
