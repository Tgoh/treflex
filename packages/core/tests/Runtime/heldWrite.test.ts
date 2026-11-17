import type { IActionGenerator, IOpenGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { transient } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { settled } from "../../src/Testing/createTestRuntime";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"HeldWrite/Updated": {
			DocumentId: string;
			Title: string;
		};
	}
}

interface IDoc extends IEntity {
	DocumentId: string;
	Title: string;
	Meta: {
		Note: string;
	};
}

interface ISession extends IEntity {
	Docs: IDoc[];
	Other: IDoc[];
}

const seed = (): ISession => ({
	$Id: "session",
	Docs: [
		{
			$Id: "doc",
			DocumentId: "d1",
			Title: "old",
			Meta: {
				Note: ""
			}
		},
		{
			$Id: "doc-2",
			DocumentId: "d2",
			Title: "old",
			Meta: {
				Note: ""
			}
		}
	],
	Other: []
});

function* park(): IActionGenerator<unknown> {
	return yield {
		Type: "park"
	};
}

function build() {
	const releases: (() => void)[] = [];
	const errors: unknown[] = [];
	const runtime = createRuntime<ISession>(seed(), {
		onError: (error) => errors.push(error)
	});
	runtime.registerImplementation(
		"park",
		() =>
			new Promise<void>((resolve) => {
				releases.push(resolve);
			})
	);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (diag) => diags.push(diag));
	const held = () => diags.filter((diag) => diag.code === "entity/written-while-held");
	const releaseAll = async () => {
		while (releases.length > 0) {
			releases.shift()!();
			await settled();
		}
	};
	return {
		runtime,
		errors,
		held,
		releaseAll,
		doc: () => runtime.state.Docs[0]!
	};
}

function* save(draft: IDoc): IActionGenerator<string> {
	yield* park();
	return draft.Title;
}

function* retitle(draft: ISession, title: string): IActionGenerator {
	draft.Docs[0]!.Title = title;
}

const Session = receiver<ISession>("HeldWriteSession")({
	*"HeldWrite/Updated"(draft, message) {
		const doc = draft.Docs.find((d) => d.DocumentId === message.DocumentId);
		if (doc) {
			doc.Title = message.Title;
		}
	}
});

describe("entity/written-while-held", () => {
	it("reports a receiver case on the parent writing into a child whose action holds it at a wait", async () => {
		const h = build();
		h.runtime.registerReceiver(Session);
		await h.runtime.dispatch(function* binds(draft: ISession): IActionGenerator {
			bind(draft, Session);
		}, "session");
		const saving = h.runtime.dispatch(save, "doc");
		await h.runtime.dispatch(function* announce(_draft: ISession): IActionGenerator {
			yield* publish("HeldWrite/Updated", {
				DocumentId: "d1",
				Title: "new"
			});
		}, "session");
		await settled();
		await h.releaseAll();
		await expect(saving).resolves.toBe("new");
		expect(h.held()).toEqual([
			expect.objectContaining({
				severity: "info",
				data: {
					writer: "HeldWriteSession",
					holder: "save",
					entityId: "doc",
					path: [
						"Title"
					]
				}
			})
		]);
		expect(h.held()[0]!.message).toContain('Action "HeldWriteSession" wrote Title on entity "doc" while action "save" holds it');
		expect(h.errors).toEqual([]);
	});

	it("reports reconcileRows' update in a parent's step writing into a held row, with the path inside the row", async () => {
		const h = build();
		const saving = h.runtime.dispatch(save, "doc");
		await h.runtime.dispatch(function* refresh(draft: ISession): IActionGenerator {
			yield* reconcileRows(
				draft.Docs,
				[
					{
						DocumentId: "d1",
						Note: "fresh"
					},
					{
						DocumentId: "d2",
						Note: "fresh"
					}
				],
				(row) => row.DocumentId,
				{
					update: (row, item) => {
						row.Meta.Note = item.Note;
					},
					add: () => {
						throw new Error("unreached");
					}
				}
			);
		}, "session");
		await h.releaseAll();
		await saving;
		expect(h.held().map((diag) => diag.data)).toEqual([
			{
				writer: "refresh",
				holder: "save",
				entityId: "doc",
				path: [
					"Meta",
					"Note"
				]
			}
		]);
	});

	it("reports once per pair of writer and holder actions, and again for another pair", async () => {
		const h = build();
		const saving = h.runtime.dispatch(save, "doc");
		await h.runtime.dispatch(retitle, "session", "one");
		await h.runtime.dispatch(retitle, "session", "two");
		await h.runtime.dispatch(function* renote(draft: ISession): IActionGenerator {
			draft.Docs[0]!.Meta.Note = "n";
			delete (draft.Docs[0] as Partial<IDoc>).Title;
		}, "session");
		await h.releaseAll();
		await saving;
		expect(
			h.held().map((diag) => [
				diag.data!.writer,
				diag.data!.path
			])
		).toEqual([
			[
				"retitle",
				[
					"Title"
				]
			],
			[
				"renote",
				[
					"Meta",
					"Note"
				]
			]
		]);
	});

	it("reports a write into the held entity's transient, naming the slot", async () => {
		const h = build();
		const saving = h.runtime.dispatch(function* busy(draft: IDoc): IActionGenerator {
			(yield* transient(draft, "Busy", {
				On: false
			})).On = true;
			yield* park();
		}, "doc");
		await h.runtime.dispatch(function* clearBusy(draft: ISession): IActionGenerator {
			(yield* transient(draft.Docs[0]!, "Busy", {
				On: false
			})).On = false;
		}, "session");
		await h.releaseAll();
		await saving;
		expect(h.held().map((diag) => diag.data)).toEqual([
			{
				writer: "clearBusy",
				holder: "busy",
				entityId: "doc",
				slot: "Busy",
				path: [
					"On"
				]
			}
		]);
	});

	it("names the holder and not the work queued behind it", async () => {
		const h = build();
		const saving = h.runtime.dispatch(save, "doc");
		const queued = h.runtime.dispatch(function* queuedSave(draft: IDoc): IActionGenerator {
			yield* park();
			draft.Title = "queued";
		}, "doc");
		await h.runtime.dispatch(retitle, "session", "new");
		await h.releaseAll();
		await Promise.all([
			saving,
			queued
		]);
		expect(h.held().map((diag) => diag.data!.holder)).toEqual([
			"save"
		]);
	});

	describe("stays quiet", () => {
		it("for the holder's own writes: its parallel branches, its yield* helpers and its finally", async () => {
			const h = build();
			function* helper(draft: IDoc): IActionGenerator {
				draft.Meta.Note = "helper";
				yield* park();
				draft.Meta.Note = "helper after";
			}
			const run = latest(function* own(draft: IDoc): IActionGenerator {
				try {
					yield* parallel(helper(draft), park());
					yield* helper(draft);
					yield* park();
				} finally {
					draft.Title = "finally";
				}
			});
			const first = h.runtime.dispatch(run, "doc");
			await settled();
			h.runtime.dispatch(run, "doc");
			await settled();
			await h.releaseAll();
			await first;
			await settled();
			expect(h.doc().Title).toBe("finally");
			expect(h.held()).toEqual([]);
		});

		it("for a write into a holder that let the hold go inside open(...)", async () => {
			const h = build();
			const saving = h.runtime.dispatch(function* saveOpen(draft: IDoc): IOpenGenerator<string> {
				yield* open(park());
				return draft.Title;
			}, "doc");
			await h.runtime.dispatch(retitle, "session", "new");
			await h.releaseAll();
			await expect(saving).resolves.toBe("new");
			expect(h.held()).toEqual([]);
		});

		it("for removing a held child and for moving rows within a list, which are writes to the parent", async () => {
			const h = build();
			const second = h.runtime.dispatch(save, "doc-2");
			const saving = h.runtime.dispatch(save, "doc");
			await h.runtime.dispatch(function* reorder(draft: ISession): IActionGenerator {
				draft.Docs.reverse();
				const [moved] = draft.Docs.splice(1, 1);
				draft.Other.push(moved!);
			}, "session");
			await h.runtime.dispatch(function* remove(draft: ISession): IActionGenerator {
				draft.Docs = draft.Docs.filter((d) => d.$Id !== "doc-2");
			}, "session");
			await expect(second).resolves.toBeUndefined();
			await h.releaseAll();
			await saving;
			expect(h.held()).toEqual([]);
		});

		it("for a write into an entity no action holds", async () => {
			const h = build();
			const saving = h.runtime.dispatch(save, "doc-2");
			await h.runtime.dispatch(retitle, "session", "new");
			await h.releaseAll();
			await saving;
			expect(h.held()).toEqual([]);
		});

		it("for a raw write, which reaches no running action", async () => {
			const h = build();
			const saving = h.runtime.dispatch(save, "doc");
			rawOf(h.doc()).Title = "raw";
			await h.releaseAll();
			await saving;
			expect(h.held()).toEqual([]);
		});

		it("for a parent starting the write into the child as work", async () => {
			const h = build();
			function* applyTitle(draft: IDoc, title: string): IActionGenerator {
				draft.Title = title;
			}
			const saving = h.runtime.dispatch(save, "doc");
			await h.runtime.dispatch(function* forward(draft: ISession): IActionGenerator {
				yield* start(applyTitle, draft.Docs[0]!, "new");
			}, "session");
			await h.releaseAll();
			await expect(saving).resolves.toBe("old");
			await settled();
			expect(h.doc().Title).toBe("new");
			expect(h.held()).toEqual([]);
		});
	});
});
