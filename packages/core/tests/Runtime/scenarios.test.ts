import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator, IOpenGenerator } from "../../src/Types/IAction";
import type { IAskId } from "../../src/Types/IAskId";
import type { IEntity } from "../../src/Types/IEntity";
import type { IResourceContext } from "../../src/Types/IResource";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { entity } from "../../src/Effects/entity";
import { openResource } from "../../src/Effects/openResource";
import { publish } from "../../src/Effects/publish";
import { resource } from "../../src/Effects/resource";
import { start } from "../../src/Effects/start";
import { startTimer } from "../../src/Effects/startTimer";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { pendingAsks } from "../../src/Runtime/pendingAsks";
import { receiver } from "../../src/Runtime/receiver";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { settled } from "../../src/Testing/createTestRuntime";
import { pendingAsksOf } from "../testHelpers";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"Scenario/Pushed": {
			Text: string;
		};
		"Scenario/Ping": {};
	}
}

declare module "../../src/Registries/ITimerRegistry" {
	interface ITimerRegistry {
		"Scenario/Poll": {};
	}
}

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"scenario/lookup": {
			Methods: {
				find(): string;
			};
		};
	}
	interface IResourceRegistry {
		"Scenario/Lookup": {
			Type: "scenario/lookup";
		};
	}
}

function world<T extends object>(seed: T) {
	const errors: unknown[] = [];
	const runtime = createRuntime<T>(seed, {
		onError: (error) => errors.push(error)
	}) as IRuntimeInternal<T>;
	const pending = new Map<string, ((value: unknown) => void)[]>();
	const sent: {
		Name: string;
		Body: unknown;
	}[] = [];
	runtime.registerImplementation(
		"call",
		(effect: { Type: string; Name: string; Body?: unknown }) =>
			new Promise((resolve) => {
				sent.push({
					Name: effect.Name,
					Body: effect.Body
				});
				const queue = pending.get(effect.Name) ?? [];
				queue.push(resolve);
				pending.set(effect.Name, queue);
			})
	);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	return {
		runtime,
		errors,
		sent,
		diags,
		calls: (name: string) => sent.filter((call) => call.Name === name),
		waiting: (name: string) => pending.get(name)?.length ?? 0,
		reply: (name: string, value?: unknown) => {
			const queue = pending.get(name);
			const resolve = queue?.shift();
			if (!resolve) {
				throw new Error(`nothing waits on "${name}"`);
			}
			resolve(value);
		}
	};
}

function* call<R = unknown>(name: string, body?: unknown): Generator<any, R, any> {
	return yield {
		Type: "call",
		Name: name,
		Body: body
	};
}

interface IHasDialog extends IEntity {
	Dialog: IEntity | null;
}

function* confirm(draft: IHasDialog) {
	draft.Dialog = yield* entity({});
	const yes = yield* open(
		ask<boolean>(draft.Dialog, {
			Path: "Scenario/Confirm"
		})
	);
	draft.Dialog = null;
	return yes === true;
}

function* answerDialog(dialog: IEntity, value: boolean): IActionGenerator {
	yield* answer((yield* pendingAsks(dialog))[0]!.Id as IAskId<boolean>, value);
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("asking the user something", () => {
	interface ITemplate extends IHasDialog {
		Body: string;
		Published: string | null;
	}

	it("A1: what they confirmed is what gets saved, though a newer version lands during the dialog", async () => {
		const w = world<ITemplate>({
			$Id: "template",
			Body: "v1",
			Published: null,
			Dialog: null
		});
		function* publishTemplate(draft: ITemplate) {
			const confirmed = draft.Body;
			if (!(yield* confirm(draft))) return;
			yield* call("save", confirmed);
			draft.Published = confirmed;
		}
		function* receiveVersion(draft: ITemplate, body: string): IActionGenerator {
			draft.Body = body;
		}
		const publishing = w.runtime.dispatch(publishTemplate, "template");
		await settled();
		const arriving = w.runtime.dispatch(receiveVersion, "template", "v2");
		await w.runtime.dispatch(answerDialog, w.runtime.state.Dialog!, true);
		w.reply("save");
		await Promise.all([
			publishing,
			arriving
		]);
		expect(w.calls("save").map((c) => c.Body)).toEqual([
			"v1"
		]);
		expect(w.runtime.state.Published).toBe("v1");
		expect(w.runtime.state.Body).toBe("v2");
	});

	interface IPayment extends IEntity {
		Paid: boolean;
	}
	interface IReport extends IHasDialog {
		Rows: IPayment[];
	}

	it("A2: the row they were looking at gets marked, and a reload during the dialog drops nothing it needs", async () => {
		const w = world<IReport>({
			$Id: "report",
			Dialog: null,
			Rows: [
				{
					$Id: "p1",
					Paid: false
				},
				{
					$Id: "p2",
					Paid: false
				}
			]
		});
		function* markPaid(draft: IReport, rowId: string) {
			if (!(yield* confirm(draft))) return;
			const row = draft.Rows.find((r) => r.$Id === rowId);
			if (!row) return;
			row.Paid = true;
			yield* call("markPaid", row.$Id);
		}
		function* archivePaid(draft: IReport): IActionGenerator {
			draft.Rows = draft.Rows.filter((r) => !r.Paid);
		}
		const marking = w.runtime.dispatch(markPaid, "report", "p1");
		await settled();
		const reloading = w.runtime.dispatch(archivePaid, "report");
		await w.runtime.dispatch(answerDialog, w.runtime.state.Dialog!, true);
		w.reply("markPaid");
		await Promise.all([
			marking,
			reloading
		]);
		expect(w.errors).toEqual([]);
		expect(w.calls("markPaid").map((c) => c.Body)).toEqual([
			"p1"
		]);
		expect(
			w.runtime.state.Rows.map((r) => [
				r.$Id,
				r.Paid
			])
		).toEqual([
			[
				"p1",
				true
			],
			[
				"p2",
				false
			]
		]);
	});

	interface IComponent extends IHasDialog {
		Status: "Draft" | "Published";
		Deleted: boolean;
	}

	it("A3: the asker re-checks after the dialog, so a draft published during it isn't deleted", async () => {
		const w = world<IComponent>({
			$Id: "component",
			Dialog: null,
			Status: "Draft",
			Deleted: false
		});
		function* deleteDraft(draft: IComponent) {
			if (!(yield* confirm(draft)) || draft.Status !== "Draft") return;
			yield* call("delete", draft.Status);
			draft.Deleted = true;
		}
		function* publishComponent(draft: IComponent): IActionGenerator {
			draft.Status = "Published";
		}
		const deleting = w.runtime.dispatch(deleteDraft, "component");
		await settled();
		const publishing = w.runtime.dispatch(publishComponent, "component");
		await w.runtime.dispatch(answerDialog, w.runtime.state.Dialog!, true);
		await Promise.all([
			deleting,
			publishing
		]);
		expect(w.calls("delete")).toEqual([]);
		expect(w.runtime.state).toMatchObject({
			Status: "Published",
			Deleted: false
		});
	});

	interface ILayoutRow extends IEntity {
		Name: string;
	}
	interface ILayout extends IHasDialog {
		Rows: ILayoutRow[];
	}

	it("A4: the row they confirmed goes, whatever else was clicked meanwhile", async () => {
		const w = world<ILayout>({
			$Id: "layout",
			Dialog: null,
			Rows: [
				{
					$Id: "header",
					Name: "Header"
				},
				{
					$Id: "body",
					Name: "Body"
				},
				{
					$Id: "footer",
					Name: "Footer"
				}
			]
		});
		function* deleteRow(draft: ILayout, rowId: string) {
			if (!(yield* confirm(draft))) return;
			draft.Rows.splice(
				draft.Rows.findIndex((r) => r.$Id === rowId),
				1
			);
		}
		function* moveFirstToEnd(draft: ILayout): IActionGenerator {
			draft.Rows.push(draft.Rows.shift()!);
		}
		const deleting = w.runtime.dispatch(deleteRow, "layout", "body");
		await settled();
		const moving = w.runtime.dispatch(moveFirstToEnd, "layout");
		await w.runtime.dispatch(answerDialog, w.runtime.state.Dialog!, true);
		await Promise.all([
			deleting,
			moving
		]);
		expect(w.runtime.state.Rows.map((r) => r.$Id)).toEqual([
			"footer",
			"header"
		]);
	});

	interface IPerson extends IHasDialog {
		Asked: number;
	}

	it("A5: a second dialog on an entity opens beside the first, and pendingAsks lists them in opening order", async () => {
		const w = world<IPerson>({
			$Id: "person",
			Dialog: null,
			Asked: 0
		});
		function* askName(draft: IPerson) {
			draft.Asked++;
			return yield* open(
				ask<string>(draft, {
					Path: "Scenario/Name",
					Options: {
						Nth: draft.Asked
					}
				})
			);
		}
		function* answers(_draft: IPerson, id: IAskId<string>, value: string): IActionGenerator {
			yield* answer(id, value);
		}
		const first = w.runtime.dispatch(askName, "person");
		const second = w.runtime.dispatch(askName, "person");
		await settled();
		expect(w.runtime.state.Asked).toBe(2);
		const [one, two] = pendingAsksOf(w.runtime, w.runtime.state);
		expect([
			one!.Request,
			two!.Request
		]).toEqual([
			{
				Path: "Scenario/Name",
				Options: {
					Nth: 1
				}
			},
			{
				Path: "Scenario/Name",
				Options: {
					Nth: 2
				}
			}
		]);
		await w.runtime.dispatch(answers, "person", two!.Id as IAskId<string>, "second");
		expect(await second).toBe("second");
		await w.runtime.dispatch(answers, "person", one!.Id as IAskId<string>, "first");
		expect(await first).toBe("first");
	});

	interface IInbox extends IHasDialog {
		Messages: string[];
	}
	interface IApp extends IEntity {
		Inbox: IInbox;
	}

	async function inboxWorld(
		onPushed: (
			draft: IInbox,
			e: {
				Text: string;
			}
		) => IOpenGenerator
	) {
		const w = world<IApp>({
			$Id: "app",
			Inbox: {
				$Id: "inbox",
				Dialog: null,
				Messages: []
			}
		});
		const Pushes = receiver<IInbox>("Scenario/InboxPushes")({
			"Scenario/Pushed": onPushed
		});
		w.runtime.registerReceiver(Pushes);
		await w.runtime.dispatch(function* listens(draft: IInbox): IActionGenerator {
			bind(draft, Pushes);
		}, "inbox");
		const push = (text: string) =>
			w.runtime.dispatch(function* pushes(): IActionGenerator {
				yield* publish("Scenario/Pushed", {
					Text: text
				});
			}, "app");
		return {
			w,
			push
		};
	}

	it("A6: a stream's delivery lands during the dialog", async () => {
		const { w, push } = await inboxWorld(function* (draft, e) {
			draft.Messages.push(e.Text);
		});
		const asking = w.runtime.dispatch(confirm, "inbox");
		await settled();
		await push("hello");
		await settled();
		expect(w.runtime.state.Inbox.Messages).toEqual([
			"hello"
		]);
		await w.runtime.dispatch(answerDialog, w.runtime.state.Inbox.Dialog!, true);
		expect(await asking).toBe(true);
	});

	it("A7: answering always works, and can't queue behind the action waiting for it", async () => {
		const w = world<IPerson>({
			$Id: "person",
			Dialog: null,
			Asked: 0
		});
		const asking = w.runtime.dispatch(confirm, "person");
		await settled();
		await w.runtime.dispatch(answerDialog, w.runtime.state.Dialog!, false);
		expect(await asking).toBe(false);
	});

	interface IWindow extends IEntity {
		Dialogs: IEntity[];
		Result: string | null;
	}
	interface IShell extends IEntity {
		Windows: IWindow[];
	}

	it("A8: the waiter carries on with undefined when the dialog's row goes, and nothing is stuck", async () => {
		const w = world<IShell>({
			$Id: "shell",
			Windows: [
				{
					$Id: "window",
					Dialogs: [],
					Result: null
				}
			]
		});
		function* asksInWindow(draft: IWindow) {
			const row = yield* entity({});
			draft.Dialogs.push(row);
			draft.Result = String(
				yield* open(
					ask<string>(row.$Id, {
						Path: "Scenario/Window"
					})
				)
			);
		}
		function* closesAllDialogs(draft: IShell): IActionGenerator {
			for (const window of draft.Windows) {
				window.Dialogs = [];
			}
		}
		const asking = w.runtime.dispatch(asksInWindow, "window");
		await settled();
		await w.runtime.dispatch(closesAllDialogs, "shell");
		await asking;
		expect(w.runtime.state.Windows[0].Result).toBe("undefined");
		expect(w.runtime.get("runtime/inFlightActions")()).toEqual([]);
	});

	it("A8: closing the window answers undefined on each dialog's own row, and the waiter carries on and takes the row down", async () => {
		const w = world<IShell>({
			$Id: "shell",
			Windows: [
				{
					$Id: "window",
					Dialogs: [],
					Result: null
				}
			]
		});
		function* asksInWindow(draft: IWindow) {
			const row = yield* entity({});
			draft.Dialogs.push(row);
			draft.Result = String(
				yield* open(
					ask<string>(row.$Id, {
						Path: "Scenario/Window"
					})
				)
			);
			draft.Dialogs = draft.Dialogs.filter((x) => x.$Id !== row.$Id);
		}
		function* dismisses(draft: IEntity): IActionGenerator {
			for (const entry of yield* pendingAsks(draft)) {
				yield* answer(entry.Id as IAskId<string | undefined>);
			}
		}
		function* closesAllDialogs(draft: IShell): IActionGenerator {
			const dialogIds = draft.Windows.flatMap((window) => window.Dialogs.map((dialog) => dialog.$Id));
			for (const id of dialogIds) {
				yield* start(dismisses, id);
			}
		}
		const asking = w.runtime.dispatch(asksInWindow, "window");
		await settled();
		await w.runtime.dispatch(closesAllDialogs, "shell");
		await asking;
		expect(w.runtime.state.Windows[0].Result).toBe("undefined");
		expect(w.runtime.state.Windows[0].Dialogs).toEqual([]);
		expect(w.runtime.get("runtime/inFlightActions")()).toEqual([]);
	});
});

describe("loading and saving", () => {
	interface IRecord extends IEntity {
		Name: string;
		Notes: string;
	}

	it("L1: nothing else runs on an entity while it loads a fresh copy", async () => {
		const w = world<IRecord>({
			$Id: "record",
			Name: "old",
			Notes: ""
		});
		function* load(draft: IRecord): IActionGenerator {
			draft.Name = yield* call<string>("fetch");
		}
		function* rename(draft: IRecord, suffix: string): IActionGenerator {
			draft.Name = `${draft.Name}${suffix}`;
		}
		const loading = w.runtime.dispatch(load, "record");
		const renaming = w.runtime.dispatch(rename, "record", "!");
		await settled();
		expect(w.runtime.state.Name).toBe("old");
		w.reply("fetch", "fresh");
		await Promise.all([
			loading,
			renaming
		]);
		expect(w.runtime.state.Name).toBe("fresh!");
	});

	it("L2: typed input during a refresh applies on top, and the refresh isn't abandoned", async () => {
		const w = world<IRecord>({
			$Id: "record",
			Name: "old",
			Notes: "old notes"
		});
		function* refresh(draft: IRecord): IActionGenerator {
			const fresh = yield* call<{
				Name: string;
				Notes: string;
			}>("fetch");
			draft.Name = fresh.Name;
			draft.Notes = fresh.Notes;
		}
		function* typeNotes(draft: IRecord, notes: string): IActionGenerator {
			draft.Notes = notes;
		}
		const refreshing = w.runtime.dispatch(refresh, "record");
		const typing = w.runtime.dispatch(typeNotes, "record", "mine");
		w.reply("fetch", {
			Name: "server",
			Notes: "server notes"
		});
		await Promise.all([
			refreshing,
			typing
		]);
		expect(w.runtime.state).toMatchObject({
			Name: "server",
			Notes: "mine"
		});
	});

	interface IForm extends IHasDialog {
		Value: string;
		Saved: string | null;
	}

	it("L3: an edit during the dialog lands, and the save is held, so an edit during it waits until it's done", async () => {
		const w = world<IForm>({
			$Id: "form",
			Dialog: null,
			Value: "original",
			Saved: null
		});
		function* confirmThenSave(draft: IForm) {
			if (!(yield* confirm(draft))) return;
			yield* call("save", draft.Value);
			draft.Saved = draft.Value;
		}
		function* edit(draft: IForm, value: string): IActionGenerator {
			draft.Value = value;
		}
		const saving = w.runtime.dispatch(confirmThenSave, "form");
		await settled();
		const duringDialog = w.runtime.dispatch(edit, "form", "during the dialog");
		await w.runtime.dispatch(answerDialog, w.runtime.state.Dialog!, true);
		await settled();
		const duringSave = w.runtime.dispatch(edit, "form", "during the save");
		await settled();
		expect(w.runtime.state.Value).toBe("during the dialog");
		w.reply("save");
		await Promise.all([
			saving,
			duringDialog,
			duringSave
		]);
		expect(w.calls("save").map((c) => c.Body)).toEqual([
			"during the dialog"
		]);
		expect(w.runtime.state).toMatchObject({
			Saved: "during the dialog",
			Value: "during the save"
		});
	});

	it("L9: a fetch that never returns doesn't freeze the entity for good, and something says so", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout"
			]
		});
		const w = world<IRecord>({
			$Id: "record",
			Name: "old",
			Notes: ""
		});
		w.runtime.registerImplementation(
			"fetchWithLimit",
			() =>
				new Promise((_resolve, reject) => {
					setTimeout(() => reject(new Error("timed out")), 5000);
				})
		);
		function* load(draft: IRecord): IActionGenerator {
			try {
				draft.Name = yield {
					Type: "fetchWithLimit"
				};
			} catch {
				draft.Notes = "couldn't load";
			}
		}
		function* rename(draft: IRecord): IActionGenerator {
			draft.Name = "typed";
		}
		const loading = w.runtime.dispatch(load, "record");
		const renaming = w.runtime.dispatch(rename, "record");
		await vi.advanceTimersByTimeAsync(1500);
		expect(w.diags.find((d) => d.code === "action/long-hold")?.data).toMatchObject({
			holder: "load",
			queued: [
				"rename"
			]
		});
		await vi.advanceTimersByTimeAsync(4000);
		await Promise.all([
			loading,
			renaming
		]);
		expect(w.runtime.state).toMatchObject({
			Name: "typed",
			Notes: "couldn't load"
		});
	});
});

describe("doing it again, or changing your mind", () => {
	interface IDoc extends IEntity {
		Saves: number;
		Rows: string[];
	}

	it("R1: a double-click on Save saves once", async () => {
		const w = world<IDoc>({
			$Id: "doc",
			Saves: 0,
			Rows: []
		});
		const save = leading(function* save(draft: IDoc): IActionGenerator {
			yield* call("save");
			draft.Saves++;
		});
		const first = w.runtime.dispatch(save, "doc");
		const second = w.runtime.dispatch(save, "doc");
		expect(await second).toBeUndefined();
		w.reply("save");
		await first;
		expect(w.calls("save")).toHaveLength(1);
		expect(w.runtime.state.Saves).toBe(1);
	});

	interface ISearch extends IEntity {
		Query: string;
		Results: string[];
	}

	it("R2: search as you type: the newest search wins, and older ones are abandoned", async () => {
		const w = world<ISearch>({
			$Id: "search",
			Query: "",
			Results: []
		});
		const search = latest(function* search(draft: ISearch, query: string): IActionGenerator {
			draft.Query = query;
			draft.Results = yield* call<string[]>("search", query);
		});
		const typed = [
			"a",
			"ab",
			"abc"
		].map((query) => w.runtime.dispatch(search, "search", query));
		await settled();
		expect(w.runtime.state.Query).toBe("abc");
		for (const call of w.calls("search")) {
			w.reply("search", [
				`${call.Body}!`
			]);
		}
		await Promise.all(typed);
		await settled();
		expect(w.runtime.state.Results).toEqual([
			"abc!"
		]);
	});

	interface ISearchBox extends IEntity {
		Query: string;
		Rows: {
			Id: string;
			Name: string;
		}[];
	}
	interface IPicker extends IEntity {
		Picked: string | null;
		Search: ISearchBox;
	}

	it("R3: picking a result abandons the search that's out, run on a child the pick replaces", async () => {
		const w = world<IPicker>({
			$Id: "picker",
			Picked: null,
			Search: {
				$Id: "box-1",
				Query: "",
				Rows: []
			}
		});
		const runSearch = latest(function* runSearch(draft: ISearchBox, query: string): IActionGenerator {
			draft.Query = query;
			draft.Rows = yield* call<ISearchBox["Rows"]>("search", query);
		});
		function* pick(draft: IPicker, id: string): IActionGenerator {
			draft.Picked = draft.Search.Rows.find((row) => row.Id === id)!.Name;
			draft.Search = yield* entity<ISearchBox>({
				Query: "",
				Rows: []
			});
		}
		const first = w.runtime.dispatch(runSearch, "box-1", "acme");
		w.reply("search", [
			{
				Id: "c1",
				Name: "Acme Ltd"
			}
		]);
		await first;
		const second = w.runtime.dispatch(runSearch, "box-1", "acme l");
		await w.runtime.dispatch(pick, "picker", "c1");
		w.reply("search", []);
		expect(await second).toBeUndefined();
		expect(w.runtime.state.Picked).toBe("Acme Ltd");
		expect(w.runtime.state.Search.Rows).toEqual([]);
	});

	it("R4: pressing Reload twice gives one useful result", async () => {
		const w = world<IDoc>({
			$Id: "doc",
			Saves: 0,
			Rows: []
		});
		const reload = leading(function* reload(draft: IDoc): IActionGenerator {
			draft.Rows = yield* call<string[]>("reload");
		});
		const first = w.runtime.dispatch(reload, "doc");
		await w.runtime.dispatch(reload, "doc");
		w.reply("reload", [
			"fresh"
		]);
		await first;
		expect(w.calls("reload")).toHaveLength(1);
		expect(w.runtime.state.Rows).toEqual([
			"fresh"
		]);
	});

	interface IOutput extends IEntity {
		Text: string | null;
	}
	interface IRegression extends IEntity {
		Selected: string | null;
		Output: IOutput;
	}

	it("R5: another criterion abandons the earlier load, which runs on an output child the next click replaces", async () => {
		const w = world<IRegression>({
			$Id: "regression",
			Selected: null,
			Output: {
				$Id: "output-0",
				Text: null
			}
		});
		function* readOutput(draft: IOutput, criterion: string): IActionGenerator {
			draft.Text = yield* call<string>("output", criterion);
		}
		function* clickCriteria(draft: IRegression, criterion: string): IActionGenerator {
			draft.Selected = criterion;
			draft.Output = yield* entity<IOutput>({
				Text: null
			});
			yield* start(readOutput, draft.Output.$Id, criterion);
		}
		await w.runtime.dispatch(clickCriteria, "regression", "first");
		await w.runtime.dispatch(clickCriteria, "regression", "second");
		await settled();
		w.reply("output", "first's output");
		w.reply("output", "second's output");
		await settled();
		expect(w.runtime.state.Selected).toBe("second");
		expect(w.runtime.state.Output.Text).toBe("second's output");
	});

	interface IPreview extends IEntity {
		File: string;
		Pdf: string | null;
	}
	interface IBatch extends IEntity {
		Preview: IPreview | null;
	}

	it("R6: the old PDF's answer goes nowhere once another customer's preview replaces it", async () => {
		const w = world<IBatch>({
			$Id: "batch",
			Preview: null
		});
		function* loadPdf(draft: IPreview): IActionGenerator {
			draft.Pdf = yield* call<string>("pdf", draft.File);
		}
		function* openPdf(draft: IBatch, file: string): IActionGenerator {
			draft.Preview = yield* entity<IPreview>({
				File: file,
				Pdf: null
			});
			yield* start(loadPdf, draft.Preview.$Id);
		}
		await w.runtime.dispatch(openPdf, "batch", "alice.pdf");
		await w.runtime.dispatch(openPdf, "batch", "bob.pdf");
		await settled();
		w.reply("pdf", "alice's bytes");
		await settled();
		expect(w.runtime.state.Preview).toMatchObject({
			File: "bob.pdf",
			Pdf: null
		});
		w.reply("pdf", "bob's bytes");
		await settled();
		expect(w.runtime.state.Preview?.Pdf).toBe("bob's bytes");
	});

	interface IAppWindow extends IEntity {
		Data: string | null;
	}
	interface ISession extends IEntity {
		Windows: IAppWindow[];
	}
	interface IDesk extends IEntity {
		Session: ISession | null;
	}

	const desk = (): IDesk => ({
		$Id: "desk",
		Session: {
			$Id: "session",
			Windows: [
				{
					$Id: "window",
					Data: null
				}
			]
		}
	});

	function* read(draft: IAppWindow): IActionGenerator {
		draft.Data = yield* call<string>("read");
	}
	function* removeWindow(draft: ISession, id: string): IActionGenerator {
		draft.Windows = draft.Windows.filter((window) => window.$Id !== id);
	}
	function* requestClose(draft: IAppWindow): IActionGenerator {
		yield* start(removeWindow, "session", draft.$Id);
	}

	it("R7: logging out ends everything at once", async () => {
		const w = world<IDesk>(desk());
		const reading = w.runtime.dispatch(read, "window");
		await w.runtime.dispatch(function* logOut(draft: IDesk): IActionGenerator {
			draft.Session = null;
		}, "desk");
		expect(await reading).toBeUndefined();
		expect(w.runtime.get("runtime/inFlightActions")()).toEqual([]);
	});

	it("R7: a close waits for a short read", async () => {
		const w = world<IDesk>(desk());
		const reading = w.runtime.dispatch(read, "window");
		const closing = w.runtime.dispatch(requestClose, "window");
		await settled();
		expect(w.runtime.state.Session?.Windows).toHaveLength(1);
		w.reply("read", "data");
		await Promise.all([
			reading,
			closing
		]);
		await settled();
		expect(w.runtime.state.Session?.Windows).toEqual([]);
	});

	it("R7: a long read is open, so a close gets in at once", async () => {
		const w = world<IDesk>(desk());
		function* longRead(draft: IAppWindow) {
			draft.Data = yield* open(call<string>("read"));
		}
		const reading = w.runtime.dispatch(longRead, "window");
		await w.runtime.dispatch(requestClose, "window");
		await settled();
		expect(w.runtime.state.Session?.Windows).toEqual([]);
		expect(await reading).toBeUndefined();
	});
});

describe("lists and children", () => {
	interface IRow extends IEntity {
		Key: string;
		Value: number;
		Saved?: string;
	}
	interface IList extends IEntity {
		Rows: IRow[];
	}

	const list = (): IList => ({
		$Id: "list",
		Rows: [
			{
				$Id: "r1",
				Key: "one",
				Value: 1
			},
			{
				$Id: "r2",
				Key: "two",
				Value: 2
			}
		]
	});

	function* saveRow(draft: IRow): IActionGenerator {
		yield* call("save", draft.Key);
		draft.Saved = draft.Key;
	}

	it("C1: a save parked on a row lands on that row after a reload reorders the list", async () => {
		const w = world<IList>(list());
		const saving = w.runtime.dispatch(saveRow, "r1");
		await w.runtime.dispatch(function* reload(draft: IList): IActionGenerator {
			yield* reconcileRows(
				draft.Rows,
				[
					{
						Key: "two",
						Value: 20
					},
					{
						Key: "one",
						Value: 10
					}
				],
				(row) => row.Key,
				{
					update: () => {}
				}
			);
		}, "list");
		w.reply("save");
		await saving;
		expect(
			w.runtime.state.Rows.map((row) => [
				row.Key,
				row.Saved ?? null
			])
		).toEqual([
			[
				"two",
				null
			],
			[
				"one",
				"one"
			]
		]);
	});

	it("C2: a reload's new data waits for a busy row's save, and idle rows update together", async () => {
		const w = world<IList>(list());
		function* applyRow(draft: IRow, value: number): IActionGenerator {
			draft.Value = value;
		}
		function* reload(draft: IList): IActionGenerator {
			const fresh = yield* call<Record<string, number>>("list");
			for (const [id, key] of draft.Rows.map(
				(row) =>
					[
						row.$Id,
						row.Key
					] as const
			)) {
				yield* start(applyRow, id, fresh[key]);
			}
		}
		const saving = w.runtime.dispatch(saveRow, "r1");
		const reloading = w.runtime.dispatch(reload, "list");
		w.reply("list", {
			one: 10,
			two: 20
		});
		await reloading;
		expect(w.runtime.state.Rows.map((row) => row.Value)).toEqual([
			1,
			20
		]);
		w.reply("save");
		await saving;
		await settled();
		expect(w.runtime.state.Rows.map((row) => row.Value)).toEqual([
			10,
			20
		]);
	});

	it("C3: a row removed while its save is parked ends the save", async () => {
		const w = world<IList>(list());
		const saving = w.runtime.dispatch(saveRow, "r1");
		await w.runtime.dispatch(function* removeFirst(draft: IList): IActionGenerator {
			draft.Rows.shift();
		}, "list");
		expect(await saving).toBeUndefined();
		expect(w.runtime.get("runtime/inFlightActions")()).toEqual([]);
	});

	interface IFeed extends IEntity {
		Items: {
			Id: string;
			Text: string;
		}[];
	}

	it("C4: a live push during a load isn't lost: it queues and applies on top as an add-or-replace", async () => {
		const w = world<IFeed>({
			$Id: "feed",
			Items: []
		});
		function* load(draft: IFeed): IActionGenerator {
			draft.Items = yield* call<IFeed["Items"]>("load");
		}
		function* pushed(draft: IFeed, item: IFeed["Items"][number]): IActionGenerator {
			const at = draft.Items.findIndex((existing) => existing.Id === item.Id);
			if (at === -1) {
				draft.Items.push(item);
			} else {
				draft.Items[at] = item;
			}
		}
		const loading = w.runtime.dispatch(load, "feed");
		const pushing = w.runtime.dispatch(pushed, "feed", {
			Id: "new",
			Text: "pushed"
		});
		w.reply("load", [
			{
				Id: "old",
				Text: "from the load"
			}
		]);
		await Promise.all([
			loading,
			pushing
		]);
		expect(w.runtime.state.Items.map((item) => item.Id)).toEqual([
			"old",
			"new"
		]);
	});
});

describe("found by review", () => {
	interface ITaskList extends IHasDialog {
		Polls: number;
	}

	it("F2: a poll keeps running while a dialog is open", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout"
			]
		});
		const w = world<ITaskList>({
			$Id: "tasks",
			Dialog: null,
			Polls: 0
		});
		const Poll = receiver<ITaskList>("Scenario/TaskPoll")({
			*"Scenario/Poll"(draft) {
				draft.Polls++;
			}
		});
		w.runtime.registerReceiver(Poll);
		await w.runtime.dispatch(function* starts(draft: ITaskList): IActionGenerator {
			yield* startTimer(draft, "Scenario/Poll", Poll, 1000);
		}, "tasks");
		const reassigning = w.runtime.dispatch(confirm, "tasks");
		await vi.advanceTimersByTimeAsync(5500);
		expect(w.runtime.state.Polls).toBe(5);
		await w.runtime.dispatch(answerDialog, w.runtime.state.Dialog!, true);
		await reassigning;
		await vi.advanceTimersByTimeAsync(0);
		expect(w.runtime.state.Polls).toBe(5);
	});

	interface IAccountWindow extends IEntity {
		Name: string;
	}
	interface IWorkspace extends IEntity {
		Windows: IAccountWindow[];
		Log: string[];
	}

	it("F3: Save then close: it saves anyway, they hear the outcome, then the window goes", async () => {
		const w = world<IWorkspace>({
			$Id: "workspace",
			Windows: [
				{
					$Id: "account",
					Name: "Acme"
				}
			],
			Log: []
		});
		function* note(draft: IWorkspace, text: string): IActionGenerator {
			draft.Log.push(text);
		}
		function* removes(draft: IWorkspace, id: string): IActionGenerator {
			draft.Windows = draft.Windows.filter((window) => window.$Id !== id);
		}
		function* saveAccount(draft: IAccountWindow): IActionGenerator {
			yield* call("postAccount", draft.Name);
			yield* call("postContact", draft.Name);
			yield* start(note, "workspace", `saved ${draft.Name}`);
		}
		function* close(draft: IAccountWindow): IActionGenerator {
			yield* start(removes, "workspace", draft.$Id);
		}
		const saving = w.runtime.dispatch(saveAccount, "account");
		const closing = w.runtime.dispatch(close, "account");
		w.reply("postAccount");
		await settled();
		expect(w.runtime.state.Windows).toHaveLength(1);
		w.reply("postContact");
		await Promise.all([
			saving,
			closing
		]);
		await settled();
		expect(w.calls("postContact")).toHaveLength(1);
		expect(w.runtime.state.Log).toEqual([
			"saved Acme"
		]);
		expect(w.runtime.state.Windows).toEqual([]);
	});

	interface IKeyed extends IEntity {
		Key: string;
	}
	interface IKeyedList extends IEntity {
		Rows: IKeyed[];
	}

	it("F4: a row deleted during a refresh goes and stays gone", async () => {
		const w = world<IKeyedList>({
			$Id: "list",
			Rows: [
				{
					$Id: "a",
					Key: "a"
				},
				{
					$Id: "b",
					Key: "b"
				}
			]
		});
		function* refresh(draft: IKeyedList): IActionGenerator {
			const keys = yield* call<string[]>("list");
			yield* reconcileRows(
				draft.Rows,
				keys.map((key) => ({
					Key: key
				})),
				(row) => row.Key,
				{
					update: () => {}
				}
			);
		}
		function* deleteRow(draft: IKeyedList, key: string): IActionGenerator {
			draft.Rows = draft.Rows.filter((row) => row.Key !== key);
		}
		const refreshing = w.runtime.dispatch(refresh, "list");
		const deleting = w.runtime.dispatch(deleteRow, "list", "b");
		w.reply("list", [
			"a",
			"b",
			"c"
		]);
		await Promise.all([
			refreshing,
			deleting
		]);
		expect(w.runtime.state.Rows.map((row) => row.Key)).toEqual([
			"a",
			"c"
		]);
	});

	interface ICard extends IEntity {
		Title: string;
		Saved: string | null;
	}
	interface IColumn extends IEntity {
		Cards: ICard[];
	}
	interface IBoard extends IEntity {
		Columns: IColumn[];
	}

	it("F11: a card dragged between columns moves once, in one step, and its save carries on", async () => {
		const w = world<IBoard>({
			$Id: "board",
			Columns: [
				{
					$Id: "todo",
					Cards: [
						{
							$Id: "card",
							Title: "Ship it",
							Saved: null
						}
					]
				},
				{
					$Id: "done",
					Cards: []
				}
			]
		});
		function* saveCard(draft: ICard): IActionGenerator {
			draft.Saved = yield* call<string>("save", draft.Title);
		}
		function* drag(draft: IBoard, cardId: string, to: string): IActionGenerator {
			const from = draft.Columns.find((column) => column.Cards.some((card) => card.$Id === cardId))!;
			const [card] = from.Cards.splice(
				from.Cards.findIndex((c) => c.$Id === cardId),
				1
			);
			draft.Columns.find((column) => column.$Id === to)!.Cards.push(card);
		}
		const saving = w.runtime.dispatch(saveCard, "card");
		await w.runtime.dispatch(drag, "board", "card", "done");
		w.reply("save", "saved");
		await saving;
		expect(
			w.runtime.state.Columns.map((column) =>
				column.Cards.map((card) => [
					card.$Id,
					card.Saved
				])
			)
		).toEqual([
			[],
			[
				[
					"card",
					"saved"
				]
			]
		]);
	});
});

describe("found by the second review", () => {
	interface IOwner extends IEntity {
		Found: string | null;
	}

	it("G1: r.run inside a method takes no hold, so the action waiting on the method isn't stuck", async () => {
		const w = world<IOwner>({
			$Id: "owner",
			Found: null
		});
		w.runtime.registerImplementation("lookupDb", () => "found it");
		let ctx!: IResourceContext<"scenario/lookup">;
		w.runtime.registerResourceType("scenario/lookup", (_params, r) => {
			ctx = r;
			r.methods({
				find: () =>
					r.run(
						(function* (): Generator<any, string, any> {
							return yield {
								Type: "lookupDb"
							};
						})()
					)
			});
		});
		await w.runtime.dispatch(function* opens(draft: IOwner): IActionGenerator {
			yield* openResource(draft, "Scenario/Lookup", {
				Type: "scenario/lookup"
			});
		}, "owner");
		await settled();
		expect(ctx).toBeDefined();
		await w.runtime.dispatch(function* finds(draft: IOwner): IActionGenerator {
			draft.Found = (yield* resource(draft, "Scenario/Lookup").find()) ?? null;
		}, "owner");
		expect(w.runtime.state.Found).toBe("found it");
	});

	interface IAppTiles extends IEntity {
		Selected: string[];
	}

	function* toggleAndLoad(draft: IAppTiles, appId: string): IActionGenerator {
		const at = draft.Selected.indexOf(appId);
		if (at === -1) {
			draft.Selected.push(appId);
		} else {
			draft.Selected.splice(at, 1);
		}
		yield* call("loadApp", appId);
	}

	it("G3: as the doc says happens: a second click on a tile that looked dead queues, and deselects it", async () => {
		const w = world<IAppTiles>({
			$Id: "tiles",
			Selected: []
		});
		const first = w.runtime.dispatch(toggleAndLoad, "tiles", "mail");
		const second = w.runtime.dispatch(toggleAndLoad, "tiles", "mail");
		w.reply("loadApp");
		await first;
		await settled();
		w.reply("loadApp");
		await second;
		expect(w.runtime.state.Selected).toEqual([]);
	});

	it("G3: with the doc's method, leading, the second click is dropped and the tile stays selected", async () => {
		const w = world<IAppTiles>({
			$Id: "tiles",
			Selected: []
		});
		const selectApp = leading(toggleAndLoad);
		const first = w.runtime.dispatch(selectApp, "tiles", "mail");
		expect(await w.runtime.dispatch(selectApp, "tiles", "mail")).toBeUndefined();
		w.reply("loadApp");
		await first;
		expect(w.runtime.state.Selected).toEqual([
			"mail"
		]);
	});

	interface ITasks extends IEntity {
		Refreshes: number;
		Bell: IEntity;
	}

	async function pinged(cases: (refresh: (draft: ITasks) => IActionGenerator) => (draft: ITasks) => IActionGenerator) {
		const w = world<ITasks>({
			$Id: "tasks",
			Refreshes: 0,
			Bell: {
				$Id: "bell"
			}
		});
		const refresh = leading(function* refresh(draft: ITasks): IActionGenerator {
			draft.Refreshes++;
			yield* call("refresh");
		});
		const Pings = receiver<ITasks>("Scenario/Pings")({
			"Scenario/Ping": cases(refresh)
		});
		w.runtime.registerReceiver(Pings);
		await w.runtime.dispatch(function* listens(draft: ITasks): IActionGenerator {
			bind(draft, Pings);
		}, "tasks");
		const ping = () =>
			w.runtime.dispatch(function* pings(_bell: IEntity): IActionGenerator {
				yield* publish("Scenario/Ping");
			}, "bell");
		return {
			w,
			ping
		};
	}

	it("G5: a mark on a helper reached by yield* from a receiver case does nothing for a message", async () => {
		const { w, ping } = await pinged(
			(refresh) =>
				function* delegates(draft) {
					yield* refresh(draft);
				}
		);
		await ping();
		await ping();
		w.reply("refresh");
		await settled();
		w.reply("refresh");
		await settled();
		expect(w.runtime.state.Refreshes).toBe(2);
	});

	it("G5: a mark on the receiver case does nothing for a message either, and every one runs", async () => {
		const { w, ping } = await pinged((refresh) =>
			leading(function* delegates(draft: ITasks): IActionGenerator {
				yield* refresh(draft);
			})
		);
		await ping();
		await ping();
		w.reply("refresh");
		await settled();
		w.reply("refresh");
		await settled();
		expect(w.runtime.state.Refreshes).toBe(2);
	});
});

describe("forms", () => {
	interface ICustomer extends IEntity {
		Name: string;
	}

	it("E1: typing then clicking Save straight away saves what was typed", async () => {
		const w = world<ICustomer>({
			$Id: "customer",
			Name: ""
		});
		function* setName(draft: ICustomer, name: string): IActionGenerator {
			draft.Name = name;
		}
		function* save(draft: ICustomer): IActionGenerator {
			yield* call("save", draft.Name);
		}
		void w.runtime.dispatch(setName, "customer", "Ada");
		const saving = w.runtime.dispatch(save, "customer");
		w.reply("save");
		await saving;
		expect(w.calls("save").map((c) => c.Body)).toEqual([
			"Ada"
		]);
	});

	interface IEditForm extends IEntity {
		Name: string;
	}
	interface IEditScreen extends IEntity {
		Form: IEditForm | null;
	}

	it("E7: Cancel with a field focused closes the form, and the blur's write does no harm", async () => {
		const w = world<IEditScreen>({
			$Id: "screen",
			Form: {
				$Id: "form",
				Name: "before"
			}
		});
		function* validate(draft: IEditForm): IActionGenerator {
			yield* call("validate", draft.Name);
		}
		function* setName(draft: IEditForm, name: string): IActionGenerator {
			draft.Name = name;
		}
		const validating = w.runtime.dispatch(validate, "form");
		const blurring = w.runtime.dispatch(setName, "form", "typed");
		await w.runtime.dispatch(function* cancel(draft: IEditScreen): IActionGenerator {
			draft.Form = null;
		}, "screen");
		expect(await blurring).toBeUndefined();
		expect(await validating).toBeUndefined();
		expect(w.errors).toEqual([]);
		expect(w.runtime.state.Form).toBeNull();
	});
});
