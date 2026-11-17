import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import type { IAskEntry } from "../../src/Types/IAskEntry";
import type { IAskId } from "../../src/Types/IAskId";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { entity } from "../../src/Effects/entity";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { start } from "../../src/Effects/start";
import { select } from "../../src/Reads/select";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { EntityReplacedError } from "../../src/Runtime/draftNode";
import { EntityGoneError } from "../../src/Runtime/entityGoneError";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open } from "../../src/Runtime/open";
import { pendingAsks } from "../../src/Runtime/pendingAsks";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { wrapSetState } from "../../src/Runtime/sliceSetState";
import { transient } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { createTestRuntime, settled } from "../../src/Testing/createTestRuntime";
import { minted, mountComponent, pendingAsksOf } from "../testHelpers";

type IAnswer = "yes" | "no" | undefined;

interface IDialogState extends IEntity {
	Inits: number;
}

interface IDialogRow extends IEntity {
	Path: string;
	State: IDialogState;
	Error: string | null;
}

interface IPanel extends IEntity {
	Finally: number;
	Result: string | null;
}

interface IForm {
	Name: string;
}

interface IWorld extends IPanel {
	Name: string;
	Panels: IPanel[];
	Other: IPanel[];
	TreeDialogs: IEntity[];
	Saves: number;
	Log: string[];
	Form: IForm;
	Copy?: unknown;
}

const dialogs = (owner: IEntity) =>
	transient(owner, "Asks/Dialogs", {
		Rows: [] as IDialogRow[]
	});

const otherDialogs = (owner: IEntity) =>
	transient(owner, "Asks/OtherDialogs", {
		Rows: [] as IDialogRow[]
	});

function peek<S extends object>(
	runtime: IRuntimeInternal<IWorld>,
	slot: (owner: IEntity) => Generator<any, S, any>,
	owner: IEntity = runtime.state
): S {
	return runtime.processSelector(
		function* (draft: IEntity) {
			return yield* slot(draft);
		},
		() => owner
	);
}

function seed(): IWorld {
	return {
		$Id: "root",
		Name: "old",
		Finally: 0,
		Result: null,
		Panels: [
			{
				$Id: "panel",
				Finally: 0,
				Result: null
			},
			{
				$Id: "panel-2",
				Finally: 0,
				Result: null
			}
		],
		Other: [],
		TreeDialogs: [],
		Saves: 0,
		Log: [],
		Form: {
			Name: ""
		}
	};
}

class SaveRefusal extends Error {}

function* dialogInit(draft: IDialogState): IActionGenerator {
	draft.Inits++;
}

function* openDialog<R>(owner: IPanel, path: string, onSubmit?: (choice: NonNullable<IAnswer>) => IActionGenerator<R>) {
	const state = yield* entity({
		Inits: 0
	});
	const row = yield* entity<IDialogRow>({
		Path: path,
		State: state,
		Error: null
	});
	function* rowOf(): IActionGenerator<IDialogRow | undefined> {
		return (yield* dialogs(owner)).Rows.find((x) => x.$Id === row.$Id);
	}
	const slot = yield* dialogs(owner);
	slot.Rows.push(row);
	try {
		yield* start(dialogInit, state.$Id);
		while (true) {
			const current = yield* rowOf();
			if (!current) return undefined;
			const choice = yield* open(
				ask<IAnswer>(state.$Id, {
					Path: path
				})
			);
			if (choice === undefined) return undefined;
			if (!onSubmit) return choice;
			const submitting = yield* rowOf();
			if (submitting) submitting.Error = null;
			try {
				return yield* onSubmit(choice);
			} catch (thrown) {
				if (!(thrown instanceof SaveRefusal)) throw thrown;
				const failed = yield* rowOf();
				if (failed) failed.Error = thrown.message;
			}
		}
	} finally {
		const index = slot.Rows.findIndex((x) => x.$Id === row.$Id);
		if (index >= 0) slot.Rows.splice(index, 1);
	}
}

function* opens(draft: IPanel, path: string) {
	const result = yield* openDialog(draft, path);
	draft.Result = String(result);
	return result;
}

function* savesOnSecondTry(draft: IWorld, path: string) {
	return yield* openDialog(draft, path, function* (choice) {
		draft.Saves++;
		if (draft.Saves === 1) throw new SaveRefusal("try again");
		return `saved:${choice}`;
	});
}

function* answers(_owner: IEntity, id: IAskId<IAnswer>, value: IAnswer): IActionGenerator {
	yield* answer(id, value);
}

function* removesRows(draft: IEntity): IActionGenerator {
	(yield* dialogs(draft)).Rows = [];
}

function* asksOn(_draft: IEntity, ownerId: string) {
	return yield* open(
		ask<IAnswer>(ownerId, {
			Path: "Demo/On"
		})
	);
}

function build() {
	const runtime = createRuntime<IWorld>(seed(), {
		onError: () => {}
	}) as IRuntimeInternal<IWorld>;
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const releases = new Map<string, (value?: unknown) => void>();
	const rejects = new Map<string, (error: unknown) => void>();
	runtime.registerImplementation(
		"asks/wait",
		(effect: { Type: string; Name: string }) =>
			new Promise((resolve, reject) => {
				releases.set(effect.Name, resolve);
				rejects.set(effect.Name, reject);
			})
	);
	return {
		runtime,
		records,
		listed: (owner: IEntity = runtime.state) => pendingAsksOf(runtime, owner),
		rows: (owner: IEntity = runtime.state) => peek(runtime, dialogs, owner).Rows,
		disposals: (id: string) => records.filter((record) => record.Kind === "entity:dispose" && record.EntityId === id).length,
		ended: (kind: "ask:answer" | "ask:abandon", id: string) => records.filter((record) => record.Kind === kind && record.AskId === id),
		asksTable: () => records.filter((record) => record.Kind === "table" && record.Table === "asks"),
		release: (name: string, value?: unknown) => {
			const release = releases.get(name);
			if (!release) throw new Error(`nothing waits on ${name}`);
			releases.delete(name);
			release(value);
		},
		fail: (name: string, error: unknown) => {
			const reject = rejects.get(name);
			if (!reject) throw new Error(`nothing waits on ${name}`);
			rejects.delete(name);
			reject(error);
		}
	};
}

function* wait(name: string): Generator<any, any, any> {
	return yield {
		Type: "asks/wait",
		Name: name
	};
}

const tick = settled;

async function waitFor(predicate: () => boolean): Promise<void> {
	await settled();
	expect(predicate()).toBe(true);
}

async function opened(listed: () => readonly IAskEntry[], count = 1): Promise<IAskEntry> {
	await waitFor(() => listed().length === count);
	return listed()[count - 1]!;
}

function idOf(entry: IAskEntry): IAskId<IAnswer> {
	return entry.Id as IAskId<IAnswer>;
}

export function askRules(label: string): void {
	describe(`asks ${label}`, () => {
		describe("the hold rule", () => {
			const refused = (reason: string) => ({
				name: "AskRefusedError",
				reason,
				entityId: "root"
			});

			it("allows open(ask(draft)), lets other work on the entity run during the wait, and takes the answer at the owner", async () => {
				const { runtime, listed } = build();
				function* asker(draft: IWorld) {
					const value = yield* open(
						ask<IAnswer>(draft, {
							Path: "Confirm"
						})
					);
					draft.Log.push(`got:${value}`);
				}
				function* note(draft: IWorld): IActionGenerator {
					draft.Log.push("meanwhile");
				}
				const asking = runtime.dispatch(asker, "root");
				const entry = await opened(listed);
				await runtime.dispatch(note, "root");
				await runtime.dispatch(answers, entry.OwnerId, idOf(entry), "yes");
				await asking;
				expect(runtime.state.Log).toEqual([
					"meanwhile",
					"got:yes"
				]);
				runtime.dispose();
			});

			it("refuses a bare ask on the asker's own entity, below it and beside it, before any ask opens", async () => {
				const { runtime, asksTable } = build();
				function* bare(_draft: IEntity, ownerId: string): IActionGenerator {
					yield* ask(ownerId, {
						Path: "Bare"
					});
				}
				for (const ownerId of [
					"root",
					"panel"
				]) {
					await expect(runtime.dispatch(bare, "root", ownerId)).rejects.toMatchObject({
						...refused("outside-open"),
						ownerId
					});
				}
				await expect(runtime.dispatch(bare, "panel", "panel-2")).rejects.toMatchObject({
					reason: "outside-open",
					entityId: "panel",
					ownerId: "panel-2"
				});
				expect(asksTable()).toHaveLength(0);
				runtime.dispose();
			});

			it("tells the author to wait inside open(...)", async () => {
				const { runtime } = build();
				function* bare(draft: IWorld): IActionGenerator {
					yield* ask(draft, {
						Path: "Bare"
					});
				}
				await expect(runtime.dispatch(bare, "root")).rejects.toThrow(/Wait for the answer inside open\(\.\.\.\)/);
				runtime.dispose();
			});

			it("refuses an ask from a branch, inside open(parallel(...)) or outside it, before any ask opens", async () => {
				const { runtime, asksTable } = build();
				function* asking(draft: IWorld): IActionGenerator {
					yield* ask(draft, {
						Path: "C"
					});
				}
				function* insideOpen(draft: IWorld) {
					yield* open(parallel(asking(draft), wait("x")));
				}
				function* outsideOpen(draft: IWorld): IActionGenerator {
					const [outcome] = yield* parallelSettled(asking(draft));
					if (!outcome.ok) throw outcome.error;
				}
				await expect(runtime.dispatch(insideOpen, "root")).rejects.toMatchObject({
					...refused("in-branch"),
					ownerId: "root"
				});
				await expect(runtime.dispatch(outsideOpen, "root")).rejects.toMatchObject(refused("in-branch"));
				expect(asksTable()).toHaveLength(0);
				runtime.dispose();
			});

			it("tells the author of an ask in a branch to ask from the action's own generator", async () => {
				const { runtime } = build();
				function* asking(draft: IWorld): IActionGenerator {
					yield* ask(draft, {
						Path: "C"
					});
				}
				await expect(
					runtime.dispatch(function* (draft: IWorld): IActionGenerator {
						yield* parallel(asking(draft));
					}, "root")
				).rejects.toThrow(/from a branch of parallel or parallelSettled\. An ask comes from the action's own generator/);
				runtime.dispose();
			});

			it("refuses a region entered in a branch, typed any, before the ask inside it runs", async () => {
				const { runtime, asksTable } = build();
				const untyped = open as (gen: any) => any;
				function* opensInBranch(draft: IWorld): IActionGenerator {
					yield* untyped(
						ask(draft, {
							Path: "C"
						})
					);
				}
				await expect(
					runtime.dispatch(function* (draft: IWorld) {
						yield* open(parallel(opensInBranch(draft)));
					}, "root")
				).rejects.toThrow(/called open\(\.\.\.\) in a branch of parallel or parallelSettled/);
				expect(asksTable()).toHaveLength(0);
				runtime.dispose();
			});

			it("allows an open helper that asks, called with a plain yield* from an open function", async () => {
				const { runtime, listed } = build();
				function* confirm(draft: IWorld) {
					return yield* open(
						ask<IAnswer>(draft, {
							Path: "Nested"
						})
					);
				}
				function* calls(draft: IWorld) {
					draft.Log.push(`got:${yield* confirm(draft)}`);
				}
				const asking = runtime.dispatch(calls, "root");
				await runtime.dispatch(answers, "root", idOf(await opened(listed)), "yes");
				await asking;
				expect(runtime.state.Log).toEqual([
					"got:yes"
				]);
				runtime.dispose();
			});

			it("allows a helper that asks bare, called inside open(...), and refuses it called bare", async () => {
				const { runtime, listed } = build();
				function* confirm(draft: IWorld, message: string) {
					return yield* ask<boolean>(draft, {
						Path: "Shared/Confirm",
						Options: {
							Message: message
						}
					});
				}
				function* bare(draft: IWorld): IActionGenerator {
					yield* confirm(draft, "sure?");
				}
				function* wrapped(draft: IWorld) {
					draft.Log.push(`got:${yield* open(confirm(draft, "sure?"))}`);
				}
				await expect(runtime.dispatch(bare, "root")).rejects.toMatchObject(refused("outside-open"));
				const asking = runtime.dispatch(wrapped, "root");
				const entry = await opened(listed);
				await runtime.dispatch(
					function* (_draft: IWorld, id: IAskId<boolean>) {
						yield* answer(id, true);
					},
					"root",
					entry.Id as IAskId<boolean>
				);
				await asking;
				expect(runtime.state.Log).toEqual([
					"got:true"
				]);
				runtime.dispose();
			});

			it("abandons an ask whose asker a record tap on its opening stops, so pendingAsks() keeps no stale entry", async () => {
				const { runtime, listed, records } = build();
				const flow = latest(function* flow(draft: IWorld) {
					return yield* open(
						ask<IAnswer>(draft, {
							Path: "Flow"
						})
					);
				});
				let again: Promise<unknown> | undefined;
				runtime.on("record", (record) => {
					if (!again && record.Kind === "table" && record.Table === "asks" && record.Prev === null) {
						again = runtime.dispatch(flow, "root");
					}
				});
				const first = runtime.dispatch(flow, "root");
				await tick();
				expect(await first).toBeUndefined();
				expect(listed()).toHaveLength(1);
				expect(records.filter((record) => record.Kind === "ask:abandon")).toMatchObject([
					{
						Reason: "cancelled"
					}
				]);
				const [kept] = listed();
				await runtime.dispatch(answers, "root", idOf(kept!), "yes");
				expect(await again).toBe("yes");
				expect(listed()).toHaveLength(0);
				runtime.dispose();
			});

			it("allows open(ask(...)) from an action on a form over part of an entity, and refuses it held", async () => {
				const { runtime, listed } = build();
				let got: IAnswer;
				const onForm = <A extends unknown[]>(action: IAction<IForm, A, unknown>, ...args: A) =>
					runtime.processAction(
						action,
						() => runtime.state.Form,
						wrapSetState(rawOf(runtime.state).Form, runtime.get("runtime/writeGateway")),
						() => undefined as unknown as string,
						...args
					);
				function* formAsker(_draft: IForm) {
					got = yield* open(
						ask<IAnswer>("panel", {
							Path: "C"
						})
					);
				}
				function* formHeld(_draft: IForm): IActionGenerator {
					yield* ask("panel", {
						Path: "C"
					});
				}
				const asking = onForm(formAsker);
				const entry = await opened(listed);
				await runtime.dispatch(answers, "panel", idOf(entry), "yes");
				await asking;
				expect(got).toBe("yes");
				await expect(onForm(formHeld)).rejects.toMatchObject(refused("outside-open"));
				runtime.dispose();
			});

			it("holds a component entity like any entity, so its action asks inside open(...)", async () => {
				const { runtime } = build();
				const local = mountComponent(runtime, "panel", {});
				function* bare(): IActionGenerator<unknown> {
					return yield* ask<IAnswer>("panel", {
						Path: "Local"
					});
				}
				await expect(runtime.dispatch(bare, local)).rejects.toMatchObject({
					...refused("outside-open"),
					entityId: local
				});
				const asking = runtime.dispatch(asksOn, local, "panel");
				await tick();
				await runtime.dispatch(answers, "panel", idOf(pendingAsksOf(runtime, runtime.state)[0]!), "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});
		});

		describe("a decision partway through an action (case 9)", () => {
			it("confirms on the asker's own entity inside open; the asker re-checks what changed during the wait", async () => {
				const { runtime, listed } = build();
				function* overwrite(draft: IWorld) {
					const choice = yield* open(
						ask<boolean>(draft, {
							Path: "Shared/Confirm",
							Options: {
								Message: "This overwrites 2 panels, continue?"
							}
						})
					);
					if (!choice || draft.Panels.length < 2) {
						draft.Log.push(`stopped:${choice}:${draft.Panels.length}`);
						return;
					}
					draft.Log.push("overwrote");
				}
				function* removesPanel(draft: IWorld): IActionGenerator {
					draft.Panels.pop();
				}
				const asking = runtime.dispatch(overwrite, "root");
				const entry = await opened(listed);
				expect(entry.Request).toEqual({
					Path: "Shared/Confirm",
					Options: {
						Message: "This overwrites 2 panels, continue?"
					}
				});
				expect(entry.OwnerId).toBe("root");
				await runtime.dispatch(removesPanel, "root");
				await runtime.dispatch(
					function* (_draft: IWorld, id: IAskId<boolean>) {
						yield* answer(id, true);
					},
					entry.OwnerId,
					entry.Id as IAskId<boolean>
				);
				await asking;
				expect(runtime.state.Log).toEqual([
					"stopped:true:1"
				]);
				expect(listed()).toHaveLength(0);
				runtime.dispose();
			});

			it("owned by what it is about: removing the owner ends it, and the asker resumes with undefined", async () => {
				const { runtime, listed } = build();
				function* closes(draft: IWorld, panelId: string) {
					const panel = draft.Panels.find((p) => p.$Id === panelId);
					if (!panel) return;
					const choice = yield* open(
						ask<IAnswer>(panel, {
							Path: "Panel/Close"
						})
					);
					draft.Log.push(`choice:${choice}`);
				}
				function* clears(draft: IWorld): IActionGenerator {
					draft.Panels = [];
				}
				const asking = runtime.dispatch(closes, "root", "panel");
				await opened(listed);
				expect(pendingAsksOf(runtime, runtime.state.Panels[0]!)).toHaveLength(1);
				expect(pendingAsksOf(runtime, runtime.state.Panels[1]!)).toHaveLength(0);
				await runtime.dispatch(clears, "root");
				await asking;
				expect(runtime.state.Log).toEqual([
					"choice:undefined"
				]);
				expect(listed()).toHaveLength(0);
				runtime.dispose();
			});
		});

		describe("a decision whose value the server must accept (case 10)", () => {
			interface IRenameResult {
				Name: string;
			}
			class ApiError extends Error {}

			function* renameFlow(draft: IWorld) {
				const renamed = yield* open(
					ask<IRenameResult>(draft, {
						Path: "Rename",
						Options: {
							Name: draft.Name
						}
					})
				);
				if (!renamed) {
					draft.Log.push("dismissed");
					return;
				}
				draft.Log.push(`renamed:${renamed.Name}:draft=${draft.Name}`);
			}

			function* rename(draft: IWorld, askId: IAskId<IRenameResult>, name: string) {
				try {
					const result: IRenameResult = yield* wait(`api:${name}`);
					draft.Name = result.Name;
					yield* answer(askId, result);
				} catch (e) {
					if (!(e instanceof ApiError)) throw e;
					return {
						Error: e.message
					};
				}
			}

			it("saves, fails as data with the ask still open, retries and answers; the asker sees the draft as rename left it", async () => {
				const { runtime, listed, release, fail } = build();
				const asking = runtime.dispatch(renameFlow, "root");
				const entry = await opened(listed);
				const id = entry.Id as IAskId<IRenameResult>;
				const first = runtime.dispatch(rename, "root", id, "taken");
				await tick();
				fail("api:taken", new ApiError("That name is taken"));
				expect(await first).toEqual({
					Error: "That name is taken"
				});
				expect(listed()).toEqual([
					entry
				]);
				expect(listed()[0]).toBe(entry);
				const second = runtime.dispatch(rename, "root", id, "good");
				await tick();
				release("api:good", {
					Name: "Good"
				});
				expect(await second).toBeUndefined();
				await asking;
				expect(runtime.state.Log).toEqual([
					"renamed:Good:draft=Good"
				]);
				expect(listed()).toHaveLength(0);
				runtime.dispose();
			});

			it("types the answer as the ask's type, and an entry's id needs a cast to it", () => {
				function* typed(draft: IWorld) {
					const renamed = yield* open(
						ask<IRenameResult>(draft, {
							Path: "Rename"
						})
					);
					const name: string | undefined = renamed?.Name;
					return name;
				}
				function* untyped(draft: IWorld) {
					const renamed = yield* open(
						ask(draft, {
							Path: "Rename"
						})
					);
					// @ts-expect-error without a type argument the answer is unknown
					return renamed.Name;
				}
				const entry = {} as IAskEntry;
				// @ts-expect-error an entry's id is IAskId<unknown>, invariant in its answer
				const unnarrowed: IAskId<IRenameResult> = entry.Id;
				const narrowed: IAskId<IRenameResult> = entry.Id as IAskId<IRenameResult>;
				void [
					typed,
					untyped,
					unnarrowed,
					narrowed
				];
			});
		});

		describe("pendingAsks(owner)", () => {
			it("lists the pending asks at or below the owner in opening order, each with its id, owner and request", async () => {
				const { runtime, listed } = build();
				const first = runtime.dispatch(asksOn, "root", "panel-2");
				await opened(listed);
				const second = runtime.dispatch(asksOn, "root", "root");
				await opened(listed, 2);
				const third = runtime.dispatch(asksOn, "root", "panel");
				await opened(listed, 3);
				expect(listed().map((entry) => entry.OwnerId)).toEqual([
					"panel-2",
					"root",
					"panel"
				]);
				expect(listed()[0]).toEqual({
					Id: expect.stringMatching(/^[0-9a-f-]{36}$/),
					OwnerId: "panel-2",
					Request: {
						Path: "Demo/On"
					}
				});
				expect(pendingAsksOf(runtime, runtime.state.Panels[0]!).map((entry) => entry.OwnerId)).toEqual([
					"panel"
				]);
				expect(new Set(listed().map((entry) => entry.Id)).size).toBe(3);
				runtime.dispose();
				await Promise.all([
					first,
					second,
					third
				]);
			});

			it("keeps each entry one frozen object across unrelated changes, and in an action reads the same objects", async () => {
				const { runtime, listed } = build();
				const asking = runtime.dispatch(asksOn, "root", "panel");
				const entry = await opened(listed);
				expect(Object.isFrozen(entry)).toBe(true);
				expect(Object.isFrozen(listed())).toBe(true);
				function* edits(draft: IWorld): IActionGenerator {
					draft.Name = "new";
					draft.Panels[1]!.Result = "touched";
				}
				await runtime.dispatch(edits, "root");
				const other = runtime.dispatch(asksOn, "root", "panel-2");
				await opened(listed, 2);
				expect(listed()[0]).toBe(entry);
				let read: readonly IAskEntry[] = [];
				function* reads(draft: IWorld): IActionGenerator {
					read = yield* pendingAsks(draft);
				}
				await runtime.dispatch(reads, "root");
				expect(read[0]).toBe(entry);
				expect(read).toHaveLength(2);
				const selected = runtime.processSelector(
					function* (draft: IWorld) {
						return yield* pendingAsks(draft);
					},
					() => runtime.state
				);
				expect(selected[0]).toBe(entry);
				runtime.dispose();
				await Promise.all([
					asking,
					other
				]);
			});

			it("reacts in a view to an ask opening, being answered and its asker being stopped, and not to a move under the same entities", async () => {
				const { runtime, listed } = build();
				function* moves(draft: IWorld): IActionGenerator {
					const [panel] = draft.Panels.splice(0, 1);
					draft.Other.push(panel!);
				}
				const flow = latest(function* flow(_draft: IWorld, ownerId: string) {
					return yield* open(
						ask<IAnswer>(ownerId, {
							Path: "Flow"
						})
					);
				});
				await createRoot(async (dispose) => {
					const underRoot: (readonly string[])[] = [];
					createEffect(() => {
						underRoot.push(pendingAsksOf(runtime, runtime.state).map((entry) => entry.OwnerId));
					});
					await tick();
					const answered = runtime.dispatch(asksOn, "root", "panel");
					const entry = await opened(listed);
					await runtime.dispatch(answers, "panel", idOf(entry), "yes");
					expect(await answered).toBe("yes");
					await tick();

					const stopped = runtime.dispatch(flow, "root", "panel");
					const first = await opened(listed);
					const replacing = runtime.dispatch(flow, "root", "panel");
					expect(await stopped).toBeUndefined();
					await tick();
					const [kept] = listed();
					expect(listed()).toHaveLength(1);
					expect(kept).not.toBe(first);

					const beforeMove = underRoot.length;
					await runtime.dispatch(moves, "root");
					await tick();
					expect(underRoot.length).toBe(beforeMove);
					expect(listed()).toEqual([
						kept
					]);
					expect(pendingAsksOf(runtime, runtime.state.Other[0]!)).toEqual([
						kept
					]);
					expect(pendingAsksOf(runtime, runtime.state.Panels[0]!)).toHaveLength(0);
					await runtime.dispatch(answers, "panel", idOf(kept!), "no");
					expect(await replacing).toBe("no");
					await tick();
					expect(underRoot.slice(0, 3)).toEqual([
						[],
						[
							"panel"
						],
						[]
					]);
					expect(underRoot.at(-1)).toEqual([]);
					dispose();
				});
				runtime.dispose();
			});

			it("follows a move between subtrees: the old owner's read drops it and the new one's lists it", async () => {
				const { runtime, listed } = build();
				function* seats(draft: IWorld): IActionGenerator {
					draft.Other.push(
						minted("group", {
							Finally: 0,
							Result: null,
							Inner: [
								minted("inner", {
									Finally: 0,
									Result: null
								})
							]
						})
					);
				}
				function* moves(draft: IWorld): IActionGenerator {
					const group = draft.Other[0] as IPanel & {
						Inner: IPanel[];
					};
					const [inner] = group.Inner.splice(0, 1);
					draft.Panels.push(inner!);
				}
				await runtime.dispatch(seats, "root");
				const asking = runtime.dispatch(asksOn, "root", "~inner");
				const entry = await opened(listed);
				const group = () => runtime.state.Other[0]!;
				expect(pendingAsksOf(runtime, group())).toEqual([
					entry
				]);
				await createRoot(async (dispose) => {
					const seen: number[] = [];
					createEffect(() => {
						seen.push(pendingAsksOf(runtime, group()).length);
					});
					await tick();
					await runtime.dispatch(moves, "root");
					await tick();
					expect(seen).toEqual([
						1,
						0
					]);
					dispose();
				});
				expect(listed()).toEqual([
					entry
				]);
				await runtime.dispatch(answers, "~inner", idOf(entry), "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});

			it("refuses a plain object, and reads a component entity as any entity", () => {
				const { runtime } = build();
				const local = mountComponent(runtime, "panel", {});
				expect(() =>
					pendingAsksOf(runtime, {
						$Id: "root"
					})
				).toThrow(/pendingAsks\(\): the owner is a plain object/);
				function* readsLocal(draft: IEntity): IActionGenerator<number> {
					return (yield* pendingAsks(draft)).length;
				}
				return expect(runtime.dispatch(readsLocal, local))
					.resolves.toBe(0)
					.finally(() => runtime.dispose());
			});

			it("answers an action's select fresh, past a memo a view built", async () => {
				const { runtime } = build();
				function* pending(draft: IWorld): ISelectorGenerator<number> {
					return (yield* pendingAsks(draft)).length;
				}
				await createRoot(async (dispose) => {
					createEffect(() => {
						runtime.runSelector(pending, () => runtime.state);
					});
					await settled();
					const asking = runtime.dispatch(asksOn, "root", "panel");
					const read = await runtime.dispatch(function* reads(_draft: IWorld): IActionGenerator<number> {
						return yield* select(pending);
					}, "root");
					expect(read).toBe(1);
					await runtime.dispatch(answers, "panel", pendingAsksOf(runtime, runtime.state)[0]!.Id as IAskId<IAnswer>, "yes");
					await asking;
					dispose();
				});
				runtime.dispose();
			});

			it("is a read: an action's yield journals no effect, and a memoized selector re-derives", async () => {
				const runtime = createTestRuntime<IWorld>(seed());
				const records: IRecord[] = [];
				runtime.on("record", (record) => records.push(record));
				function* pending(draft: IWorld): ISelectorGenerator<number> {
					return (yield* pendingAsks(draft)).length;
				}
				await createRoot(async (dispose) => {
					const seen: number[] = [];
					createEffect(() => {
						seen.push((runtime as IRuntimeInternal<IWorld>).runSelector(pending, () => runtime.state));
					});
					await settled();
					const asking = runtime.dispatch(asksOn, "root", "panel");
					await settled();
					const read = await runtime.dispatch(function* reads(draft: IWorld): IActionGenerator<number> {
						return (yield* pendingAsks(draft)).length;
					}, "root");
					expect(read).toBe(1);
					expect(records.filter((record) => record.Kind === "effect" && record.Type === "pendingAsks")).toEqual([]);
					await runtime.dispatch(answers, "panel", pendingAsksOf(runtime, runtime.state)[0]!.Id as IAskId<IAnswer>, "yes");
					await asking;
					await settled();
					expect(seen).toEqual([
						0,
						1,
						0
					]);
					dispose();
				});
				runtime.dispose();
			});
		});

		describe("the request", () => {
			it("is a frozen copy taken at the yield, of plain data and of a live node", async () => {
				const { runtime, listed } = build();
				const request = {
					Path: "A",
					Options: {
						N: 1
					}
				};
				function* plain(draft: IWorld) {
					const value = yield* open(ask<IAnswer>(draft, request));
					request.Options.N = 3;
					return value;
				}
				function* live(draft: IWorld) {
					return yield* open(
						ask<IAnswer>(draft, {
							Path: "B",
							Panel: draft.Panels[0]
						})
					);
				}
				const asking = runtime.dispatch(plain, "root");
				const first = await opened(listed);
				request.Options.N = 2;
				expect(first.Request).toEqual({
					Path: "A",
					Options: {
						N: 1
					}
				});
				expect(first.Request).not.toBe(request);
				expect(Object.isFrozen(first.Request)).toBe(true);
				expect(
					Object.isFrozen(
						(
							first.Request as {
								Options: object;
							}
						).Options
					)
				).toBe(true);
				const livening = runtime.dispatch(live, "root");
				const second = await opened(listed, 2);
				const panel = (
					second.Request as {
						Panel: IPanel;
					}
				).Panel;
				expect(panel).toEqual({
					$Id: "panel",
					Finally: 0,
					Result: null
				});
				expect(Object.isFrozen(panel)).toBe(true);
				expect(rawOf(panel)).toBe(panel);
				runtime.dispose();
				await Promise.all([
					asking,
					livening
				]);
			});

			it("fails the yield when it isn't plain data, with the refusal other messages use, and opens no ask", async () => {
				const { runtime, asksTable } = build();
				function* bad(draft: IWorld) {
					yield* open(
						ask(draft, {
							Path: "C",
							onOk: () => 1
						})
					);
				}
				await expect(runtime.dispatch(bad, "root")).rejects.toBeInstanceOf(NonPlainDataError);
				expect(asksTable()).toHaveLength(0);
				runtime.dispose();
			});

			it("stays out of a snapshot", async () => {
				const { runtime, listed } = build();
				function* asker(draft: IWorld) {
					return yield* open(
						ask<IAnswer>(draft, {
							Path: "Secret/Path",
							Options: {
								Token: "zzz-request"
							}
						})
					);
				}
				const asking = runtime.dispatch(asker, "root");
				const entry = await opened(listed);
				const saved = createSnapshot(runtime);
				expect(saved).not.toContain("zzz-request");
				expect(saved).not.toContain(entry.Id);
				runtime.dispose();
				await asking;
			});
		});

		describe("a dismissal", () => {
			it("removes the row, disposes State once, and ends the ask", async () => {
				const { runtime, listed, rows, disposals, ended } = build();
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				const entry = await opened(listed);
				const stateId = rows()[0]!.State.$Id;
				expect(entry.OwnerId).toBe(stateId);

				await runtime.dispatch(answers, stateId, idOf(entry), undefined);

				expect(await asking).toBeUndefined();
				expect(rows()).toHaveLength(0);
				expect(disposals(stateId)).toBe(1);
				expect(ended("ask:answer", entry.Id)).toHaveLength(1);
				runtime.dispose();
			});
		});

		describe("a refused save", () => {
			it("keeps the row and the same State, ran init once, asks again under a new id, and the old id's answer is an ended ask", async () => {
				const { runtime, listed, rows, disposals, records } = build();
				const asking = runtime.dispatch(savesOnSecondTry, "root", "Demo/Name");
				const first = await opened(listed);
				const firstId = idOf(first);
				const stateId = rows()[0]!.State.$Id;

				await runtime.dispatch(answers, stateId, firstId, "yes");
				await waitFor(() => rows()[0]!.Error === "try again" && listed().length === 1 && listed()[0]!.Id !== firstId);

				const second = listed()[0]!;
				expect(rows()[0]!.State.$Id).toBe(stateId);
				expect(rows()[0]!.State.Inits).toBe(1);
				expect(disposals(stateId)).toBe(0);

				const answersBefore = records.filter((record) => record.Kind === "ask:answer").length;
				await runtime.dispatch(answers, stateId, firstId, "yes");
				await tick();
				expect(records.filter((record) => record.Kind === "ask:answer")).toHaveLength(answersBefore);
				expect(runtime.state.Saves).toBe(1);
				expect(rows()).toHaveLength(1);

				await runtime.dispatch(answers, stateId, idOf(second), "no");
				expect(await asking).toBe("saved:no");
				expect(rows()).toHaveLength(0);
				expect(disposals(stateId)).toBe(1);
				runtime.dispose();
			});
		});

		describe("someone else removes the row", () => {
			it("resumes the asker with undefined rather than leaving it parked", async () => {
				const { runtime, listed, rows, disposals, ended } = build();
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				const entry = await opened(listed);
				const stateId = rows()[0]!.State.$Id;

				await runtime.dispatch(removesRows, "root");

				expect(await asking).toBeUndefined();
				expect(runtime.state.Result).toBe("undefined");
				expect(disposals(stateId)).toBe(1);
				expect(ended("ask:abandon", entry.Id)).toMatchObject([
					{
						Reason: "disposed",
						OwnerId: stateId
					}
				]);
				runtime.dispose();
			});

			it("resumes on a row removed by a filter", async () => {
				const { runtime, listed } = build();
				function* filters(draft: IEntity): IActionGenerator {
					const slot = yield* dialogs(draft);
					slot.Rows = slot.Rows.filter((x) => x.Path !== "Demo/Name");
				}
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				await opened(listed);
				await runtime.dispatch(filters, "root");
				expect(await asking).toBeUndefined();
				runtime.dispose();
			});

			it("ends only the ask that row owned", async () => {
				const { runtime, listed } = build();
				const a = runtime.dispatch(opens, "root", "Demo/A");
				await opened(listed);
				const b = runtime.dispatch(opens, "panel", "Demo/B");
				const panelAsks = () => pendingAsksOf(runtime, runtime.state.Panels[0]!);
				const kept = await opened(panelAsks);
				await runtime.dispatch(removesRows, "root");
				expect(await a).toBeUndefined();
				await tick();
				expect(panelAsks()).toEqual([
					kept
				]);
				await runtime.dispatch(answers, kept.OwnerId, idOf(kept), "yes");
				expect(await b).toBe("yes");
				runtime.dispose();
			});
		});

		describe("the opener goes", () => {
			it("ends the ask with the slot, and an answer afterwards lands nowhere", async () => {
				const { runtime, records, disposals, ended } = build();
				const finals: string[] = [];
				function* opener(draft: IPanel) {
					const id = draft.$Id;
					try {
						return yield* openDialog(draft, "Demo/Name");
					} finally {
						finals.push(id);
					}
				}
				function* removesPanel(draft: IWorld): IActionGenerator {
					draft.Panels = draft.Panels.filter((x) => x.$Id !== "panel");
				}
				const asking = runtime.dispatch(opener, "panel");
				const entry = await opened(() => pendingAsksOf(runtime, runtime.state.Panels[0]!));

				await runtime.dispatch(removesPanel, "root");
				await asking;

				expect(finals).toStrictEqual([
					"panel"
				]);
				expect(disposals(entry.OwnerId)).toBe(1);
				expect(ended("ask:abandon", entry.Id)).toHaveLength(1);

				await runtime.dispatch(answers, "root", idOf(entry), "yes");
				await tick();
				expect(records.filter((record) => record.Kind === "ask:answer")).toHaveLength(0);
				runtime.dispose();
			});
		});

		describe("an owner copied in place", () => {
			const refuses = async (
				write: (draft: IWorld) => IActionGenerator,
				prepare: (runtime: IRuntimeInternal<IWorld>) => Promise<void>,
				error: new (...args: never[]) => Error,
				finish: (runtime: IRuntimeInternal<IWorld>, value: IAnswer) => Promise<void>
			) => {
				const { runtime } = build();
				await prepare(runtime);
				await expect(runtime.dispatch(write, "root")).rejects.toThrow(error);
				await finish(runtime, "yes");
				runtime.dispose();
			};

			function* treeAsker(draft: IWorld) {
				const row = yield* entity({});
				const rowId = row.$Id;
				draft.TreeDialogs.push(row);
				try {
					return yield* open(
						ask<IAnswer>(rowId, {
							Path: "Tree"
						})
					);
				} finally {
					const index = draft.TreeDialogs.findIndex((x) => x.$Id === rowId);
					if (index >= 0) draft.TreeDialogs.splice(index, 1);
				}
			}

			const entityRow = (owner: IEntity) =>
				transient(owner, "Asks/EntityRows", {
					Rows: [] as IEntity[]
				});

			function* slotEntityAsker(draft: IWorld) {
				const row = yield* entity({});
				const rowId = row.$Id;
				(yield* entityRow(draft)).Rows.push(row);
				try {
					return yield* open(
						ask<IAnswer>(rowId, {
							Path: "Slot"
						})
					);
				} finally {
					const rows = (yield* entityRow(draft)).Rows;
					const index = rows.findIndex((x) => x.$Id === rowId);
					if (index >= 0) rows.splice(index, 1);
				}
			}

			function* nestedAsker(draft: IWorld) {
				return yield* openDialog(draft, "Demo/Name");
			}

			function harness(asker: IAction<IWorld, [], unknown>, rowsOf: (runtime: IRuntimeInternal<IWorld>) => readonly unknown[]) {
				let asking!: Promise<unknown>;
				return {
					prepare: async (runtime: IRuntimeInternal<IWorld>) => {
						asking = runtime.dispatch(asker, "root");
						await waitFor(() => rowsOf(runtime).length === 1 && pendingAsksOf(runtime, runtime.state).length === 1);
					},
					finish: async (runtime: IRuntimeInternal<IWorld>, value: IAnswer) => {
						const [entry] = pendingAsksOf(runtime, runtime.state);
						await runtime.dispatch(answers, entry!.OwnerId, idOf(entry!), value);
						expect(await asking).toBe(value);
						expect(rowsOf(runtime)).toHaveLength(0);
					}
				};
			}

			const tree = () => harness(treeAsker, (runtime) => runtime.state.TreeDialogs);
			const slot = () => harness(slotEntityAsker, (runtime) => peek(runtime, entityRow).Rows);
			const nested = () => harness(nestedAsker, (runtime) => peek(runtime, dialogs).Rows);

			it("refuses a spread of a tree row over itself, and the ask stands", async () => {
				const { prepare, finish } = tree();
				await refuses(
					function* (draft) {
						draft.TreeDialogs[0] = {
							...draft.TreeDialogs[0]!
						};
					},
					prepare,
					EntityReplacedError,
					finish
				);
			});

			it("refuses a spread of a slot row over itself, and the ask stands", async () => {
				const { prepare, finish } = slot();
				await refuses(
					function* (draft) {
						const rows = (yield* entityRow(draft)).Rows;
						rows[0] = {
							...rows[0]!
						};
					},
					prepare,
					EntityReplacedError,
					finish
				);
			});

			it("refuses a spread pushed beside the row in a slot, and the ask stands", async () => {
				const { prepare, finish } = slot();
				await refuses(
					function* (draft) {
						const rows = (yield* entityRow(draft)).Rows;
						rows.push({
							...rows[0]!
						});
					},
					prepare,
					EntityReplacedError,
					finish
				);
			});

			it("refuses a JSON copy of a nested owner in a slot, and the ask stands", async () => {
				const { prepare, finish } = nested();
				await refuses(
					function* (draft) {
						const rows = (yield* dialogs(draft)).Rows;
						rows[0] = JSON.parse(JSON.stringify(rows[0]));
					},
					prepare,
					EntityReplacedError,
					finish
				);
			});

			it("refuses a tree row copied into another of the tree's arrays as a new value", async () => {
				const { prepare, finish } = tree();
				await refuses(
					function* (draft) {
						draft.Other.push({
							...(draft.TreeDialogs[0] as IPanel)
						});
					},
					prepare,
					EntityReplacedError,
					finish
				);
			});

			it("keeps the node and the ask through a reconcileRows refresh, matched on $Id", async () => {
				const cases = [
					tree(),
					slot()
				];
				for (const [index, { prepare, finish }] of cases.entries()) {
					const { runtime } = build();
					await prepare(runtime);
					const seen = () => (index === 0 ? runtime.state.TreeDialogs : peek(runtime, entityRow).Rows);
					function* refreshes(draft: IWorld, payload: IEntity[]): IActionGenerator {
						yield* reconcileRows(index === 0 ? draft.TreeDialogs : (yield* entityRow(draft)).Rows, payload, (row: IEntity) => row.$Id, {
							update: () => {}
						});
					}
					const node = rawOf(seen()[0]);
					await runtime.dispatch(refreshes, "root", JSON.parse(JSON.stringify(seen())));
					await tick();
					expect(seen()).toHaveLength(1);
					expect(rawOf(seen()[0])).toBe(node);
					await finish(runtime, "no");
					runtime.dispose();
				}
			});

			it("ends the ask when a refresh drops the row: that is a removal", async () => {
				const { prepare } = tree();
				const { runtime, records } = build();
				await prepare(runtime);
				function* refreshes(draft: IWorld): IActionGenerator {
					yield* reconcileRows(draft.TreeDialogs, [], (row: IEntity) => row.$Id, {
						update: () => {}
					});
				}
				await runtime.dispatch(refreshes, "root");
				await tick();
				expect(records.filter((record) => record.Kind === "ask:abandon")).toMatchObject([
					{
						Reason: "disposed"
					}
				]);
				runtime.dispose();
			});

			it("keeps the ask through a filter that keeps the row, a live node, in a slot and in the tree", async () => {
				for (const [index, { prepare, finish }] of [
					tree(),
					slot(),
					nested()
				].entries()) {
					const { runtime, records } = build();
					await prepare(runtime);
					function* filters(draft: IWorld): IActionGenerator {
						if (index === 0) {
							draft.TreeDialogs = draft.TreeDialogs.filter(() => true);
						} else if (index === 1) {
							const rows = yield* entityRow(draft);
							rows.Rows = rows.Rows.filter(() => true);
						} else {
							const rows = yield* dialogs(draft);
							rows.Rows = rows.Rows.filter(() => true);
						}
					}
					await runtime.dispatch(filters, "root");
					await tick();
					expect(records.filter((record) => record.Kind === "ask:abandon")).toHaveLength(0);
					await finish(runtime, "yes");
					runtime.dispose();
				}
			});
		});

		describe("moves", () => {
			it("keeps the ask through a reorder, and lists asks in opening order still", async () => {
				const { runtime, listed, rows, records } = build();
				const a = runtime.dispatch(opens, "root", "Demo/A");
				await opened(listed);
				const b = runtime.dispatch(opens, "root", "Demo/B");
				await opened(listed, 2);
				function* reorders(draft: IEntity): IActionGenerator {
					(yield* dialogs(draft)).Rows.reverse();
				}
				await runtime.dispatch(reorders, "root");
				await tick();
				expect(rows().map((x) => x.Path)).toStrictEqual([
					"Demo/B",
					"Demo/A"
				]);
				expect(listed().map((entry) => (entry.Request as IDialogRow).Path)).toStrictEqual([
					"Demo/A",
					"Demo/B"
				]);
				expect(records.filter((record) => record.Kind === "ask:abandon")).toHaveLength(0);
				const [first, second] = listed();
				await runtime.dispatch(answers, second!.OwnerId, idOf(second!), "yes");
				expect(await b).toBe("yes");
				await runtime.dispatch(answers, first!.OwnerId, idOf(first!), "no");
				expect(await a).toBe("no");
				runtime.dispose();
			});

			it("keeps the ask through a move between slots of one owner, and of two", async () => {
				const { runtime, listed, records } = build();
				function* asker(draft: IEntity) {
					const state = yield* entity({
						Inits: 1
					});
					const slot = yield* dialogs(draft);
					slot.Rows.push({
						Path: "Demo/Move",
						State: state,
						Error: null
					} as IDialogRow);
					return yield* open(
						ask<IAnswer>(state.$Id, {
							Path: "Demo/Move"
						})
					);
				}
				function* movesToOther(draft: IEntity): IActionGenerator {
					const from = yield* dialogs(draft);
					const to = yield* otherDialogs(draft);
					const [row] = from.Rows.splice(0, 1);
					to.Rows.push(row!);
				}
				function* movesToPanel(draft: IWorld): IActionGenerator {
					const from = yield* otherDialogs(draft);
					const to = yield* dialogs(draft.Panels[1]!);
					const [row] = from.Rows.splice(0, 1);
					to.Rows.push(row!);
				}
				const asking = runtime.dispatch(asker, "root");
				const entry = await opened(listed);

				await runtime.dispatch(movesToOther, "root");
				await tick();
				expect(peek(runtime, otherDialogs).Rows[0]!.State.$Id).toBe(entry.OwnerId);
				await runtime.dispatch(movesToPanel, "root");
				await tick();
				expect(pendingAsksOf(runtime, runtime.state.Panels[1]!)).toEqual([
					entry
				]);
				expect(records.filter((record) => record.Kind === "ask:abandon")).toHaveLength(0);

				await runtime.dispatch(answers, entry.OwnerId, idOf(entry), "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});

			it("keeps the ask through a move of the owning entity in the tree", async () => {
				const { runtime, listed, records } = build();
				function* moves(draft: IWorld): IActionGenerator {
					const [row] = draft.Panels.splice(0, 1);
					draft.Other.push(row!);
				}
				const asking = runtime.dispatch(asksOn, "root", "panel");
				const entry = await opened(listed);
				await runtime.dispatch(moves, "root");
				await tick();
				expect(runtime.state.Other[0]!.$Id).toBe("panel");
				expect(records.filter((record) => record.Kind === "ask:abandon")).toHaveLength(0);
				await runtime.dispatch(answers, "panel", idOf(entry), "no");
				expect(await asking).toBe("no");
				runtime.dispose();
			});

			it("ends the ask when the owner leaves in one step and returns in a later one", async () => {
				const { runtime, listed, rows, records } = build();
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				const entry = await opened(listed);
				const plain = JSON.parse(JSON.stringify(rows()[0])) as IDialogRow;
				await runtime.dispatch(removesRows, "root");
				expect(await asking).toBeUndefined();
				function* returns(draft: IEntity, again: IDialogRow): IActionGenerator {
					(yield* dialogs(draft)).Rows.push(again);
				}
				await runtime.dispatch(returns, "root", plain);
				expect(listed()).toHaveLength(0);
				await runtime.dispatch(answers, plain.State.$Id, idOf(entry), "yes");
				await tick();
				expect(records.filter((record) => record.Kind === "ask:answer")).toHaveLength(0);
				runtime.dispose();
			});
		});

		describe("restore", () => {
			it("brings back no row and no ask on a fresh restore of a session with one open", async () => {
				const { runtime, listed } = build();
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				const entry = await opened(listed);
				const saved = createSnapshot(runtime);
				expect(saved).not.toContain(entry.Id);
				expect(saved).not.toContain("Demo/Name");
				await runtime.dispatch(removesRows, "root");
				await asking;
				runtime.dispose();

				const { runtime: restored } = await restoreRuntime<IWorld>(saved, {
					rootId: "root",
					options: {
						onError: () => {}
					}
				});
				const fresh = restored as IRuntimeInternal<IWorld>;
				expect(peek(fresh, dialogs).Rows).toHaveLength(0);
				expect(pendingAsksOf(fresh, fresh.state)).toHaveLength(0);
				await fresh.dispatch(answers, "root", idOf(entry), "yes");
				fresh.dispose();
			});

			it("gives a fresh restore's ask a new id, and an id from before the restore answers nothing", async () => {
				const { runtime, listed } = build();
				function* treeAsker(draft: IWorld, rowId: string) {
					const row = minted(rowId);
					draft.TreeDialogs.push(row);
					return yield* open(
						ask<IAnswer>(row.$Id, {
							Path: "Tree"
						})
					);
				}
				const asking = runtime.dispatch(treeAsker, "root", "dialog");
				const stale = await opened(listed);
				const saved = createSnapshot(runtime);
				function* removes(draft: IWorld): IActionGenerator {
					draft.TreeDialogs = [];
				}
				await runtime.dispatch(removes, "root");
				await asking;
				runtime.dispose();

				const records: IRecord[] = [];
				const { runtime: fresh } = await restoreRuntime<IWorld>(saved, {
					rootId: "root",
					options: {
						onError: () => {}
					},
					setup: (runtime) => {
						runtime.on("record", (record) => records.push(record));
					}
				});
				expect(fresh.state.TreeDialogs[0]!.$Id).toBe(stale.OwnerId);
				const opening = fresh.dispatch(treeAsker, "root", "dialog-2");
				await waitFor(() => pendingAsksOf(fresh, fresh.state).length === 1);
				expect(pendingAsksOf(fresh, fresh.state)[0]!.Id).not.toBe(stale.Id);
				await fresh.dispatch(answers, stale.OwnerId, idOf(stale), "yes");
				await tick();
				expect(records.filter((record) => record.Kind === "ask:answer")).toHaveLength(0);
				await fresh.dispatch(removes, "root");
				await opening;
				fresh.dispose();
			});
		});

		describe("a stopped asker", () => {
			it("has its ask ended, and an answer afterwards is an ended ask", async () => {
				const { runtime, listed, records, ended } = build();
				const starts = latest(function* starts(_draft: IWorld, asks: boolean) {
					if (asks) {
						return yield* open(
							ask<IAnswer>("panel", {
								Path: "Stopped"
							})
						);
					}
					return undefined;
				});
				const starting = runtime.dispatch(starts, "root", true);
				const entry = await opened(listed);
				await runtime.dispatch(starts, "root", false);
				await starting;
				await tick();
				expect(listed()).toHaveLength(0);
				expect(ended("ask:abandon", entry.Id)).toMatchObject([
					{
						Reason: "cancelled"
					}
				]);
				await runtime.dispatch(answers, "root", idOf(entry), "yes");
				await tick();
				expect(records.filter((record) => record.Kind === "ask:answer")).toHaveLength(0);
				runtime.dispose();
			});
		});

		describe("an owner in the tree", () => {
			it("ends the ask when the owner leaves, with no slot and no row", async () => {
				const { runtime, listed, ended } = build();
				function* asker(draft: IWorld) {
					const value = yield* open(
						ask<IAnswer>(draft.Panels[0]!, {
							Path: "Panel"
						})
					);
					draft.Result = String(value);
					return value;
				}
				function* removes(draft: IWorld): IActionGenerator {
					draft.Panels.shift();
				}
				const asking = runtime.dispatch(asker, "root");
				const entry = await opened(listed);
				await runtime.dispatch(removes, "root");
				expect(await asking).toBeUndefined();
				expect(runtime.state.Result).toBe("undefined");
				expect(ended("ask:abandon", entry.Id)).toMatchObject([
					{
						Reason: "disposed",
						OwnerId: "panel"
					}
				]);
				runtime.dispose();
			});
		});

		describe("an owner holding several asks", () => {
			it("ends every one when it goes", async () => {
				const { runtime, listed } = build();
				function* removes(draft: IWorld): IActionGenerator {
					draft.Panels.shift();
				}
				const first = runtime.dispatch(asksOn, "root", "panel");
				const second = runtime.dispatch(asksOn, "root", "panel");
				await opened(listed, 2);
				await runtime.dispatch(removes, "root");
				expect(await first).toBeUndefined();
				expect(await second).toBeUndefined();
				runtime.dispose();
			});
		});

		describe("an opener added in the same step", () => {
			it("opens a dialog, since the helper's first yield lands the entity", async () => {
				const { runtime } = build();
				function* opensOnNew(draft: IWorld) {
					draft.Other.push(
						minted("new", {
							Finally: 0,
							Result: null
						})
					);
					return yield* openDialog(draft.Other[0]!, "Demo/Name");
				}
				const asking = runtime.dispatch(opensOnNew, "root");
				const entry = await opened(() => (runtime.state.Other[0] ? pendingAsksOf(runtime, runtime.state.Other[0]) : []));
				await runtime.dispatch(answers, entry.OwnerId, idOf(entry), "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});

			it("takes its slot in that step, since the slot's own yield lands it", async () => {
				const { runtime } = build();
				function* writesFirst(draft: IWorld): IActionGenerator<number> {
					draft.Other.push(
						minted("new", {
							Finally: 0,
							Result: null
						})
					);
					return (yield* dialogs(draft.Other[0]!)).Rows.length;
				}
				await expect(runtime.dispatch(writesFirst, "root")).resolves.toBe(0);
				runtime.dispose();
			});
		});

		describe("an owner that isn't attached", () => {
			it("throws EntityGoneError for an unknown id", async () => {
				const { runtime } = build();
				const asking = runtime.dispatch(asksOn, "root", "missing");
				await expect(asking).rejects.toBeInstanceOf(EntityGoneError);
				await expect(asking).rejects.toThrow(/ask: no entity "missing"/);
				runtime.dispose();
			});

			it("throws for an entity removed earlier in the step", async () => {
				const { runtime } = build();
				function* asker(draft: IWorld) {
					draft.Panels = [];
					yield* open(
						ask("panel", {
							Path: "Gone"
						})
					);
				}
				await expect(runtime.dispatch(asker, "root")).rejects.toThrow(/ask: no entity "panel"/);
				runtime.dispose();
			});

			it("throws for a value that was never written, and for one with no $Id", async () => {
				const { runtime } = build();
				function* literal() {
					yield* open(
						ask(
							{
								$Id: "fresh"
							},
							{}
						)
					);
				}
				function* noId() {
					yield* open(ask({} as IEntity, {}));
				}
				await expect(runtime.dispatch(literal, "root")).rejects.toThrow(/ask: no entity "fresh"/);
				await expect(runtime.dispatch(noId, "root")).rejects.toThrow(/ask: no entity "undefined"/);
				runtime.dispose();
			});

			describe("because it is inside its own cascade", () => {
				function* removesPanel(draft: IWorld): IActionGenerator {
					draft.Panels.shift();
				}

				it("throws from a tap on entity:dispose", async () => {
					const { runtime } = build();
					let asking: Promise<unknown> | undefined;
					runtime.on("record", (r) => {
						if (r.Kind === "entity:dispose" && r.EntityId === "panel") asking = runtime.dispatch(asksOn, "panel-2", "panel");
					});
					await runtime.dispatch(removesPanel, "root");
					await expect(asking).rejects.toThrow(/ask: no entity "panel"/);
					runtime.dispose();
				});

				it("throws from a tap on ask:abandon", async () => {
					const { runtime, listed } = build();
					const first = runtime.dispatch(asksOn, "root", "panel");
					await opened(listed);
					let asking: Promise<unknown> | undefined;
					runtime.on("record", (r) => {
						if (r.Kind === "ask:abandon") asking = runtime.dispatch(asksOn, "panel-2", "panel");
					});
					await runtime.dispatch(removesPanel, "root");
					expect(await first).toBeUndefined();
					await expect(asking).rejects.toThrow(/ask: no entity "panel"/);
					runtime.dispose();
				});

				it("throws from a tables callback", async () => {
					const { runtime } = build();
					let asking: Promise<unknown> | undefined;
					runtime.get("runtime/writeGateway").onDispose((id) => {
						if (id === "panel") asking = runtime.dispatch(asksOn, "panel-2", "panel");
					}, "tables");
					await runtime.dispatch(removesPanel, "root");
					await expect(asking).rejects.toThrow(/ask: no entity "panel"/);
					runtime.dispose();
				});
			});

			it("accepts an entity added in the same step, since the yield lands the write", async () => {
				const { runtime, listed } = build();
				function* asker(draft: IWorld) {
					draft.Other.push(
						minted("new", {
							Finally: 0,
							Result: null
						})
					);
					return yield* open(
						ask<IAnswer>("~new", {
							Path: "New"
						})
					);
				}
				const asking = runtime.dispatch(asker, "root");
				const entry = await opened(listed);
				await runtime.dispatch(answers, "~new", idOf(entry), "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});
		});

		describe("where an ask is answered", () => {
			it("refuses an answer from above the owner or beside it, leaves the ask open, and takes one on the owner", async () => {
				const { runtime, listed, records } = build();
				const asking = runtime.dispatch(asksOn, "root", "panel");
				const entry = await opened(listed);
				const id = idOf(entry);
				await expect(runtime.dispatch(answers, "root", id, "no")).rejects.toMatchObject({
					name: "AnswerOutsideOwnerError",
					ownerId: "panel",
					answererId: "root"
				});
				await expect(runtime.dispatch(answers, "panel-2", id, "no")).rejects.toMatchObject({
					name: "AnswerOutsideOwnerError",
					answererId: "panel-2"
				});
				expect(records.filter((record) => record.Kind === "ask:answer")).toHaveLength(0);
				expect(listed()).toEqual([
					entry
				]);
				await runtime.dispatch(answers, "panel", id, "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});

			it("takes an answer from below the owner", async () => {
				const { runtime, listed } = build();
				function* seatsNested(draft: IWorld): IActionGenerator {
					draft.Other.push(
						minted("outer", {
							Finally: 0,
							Result: null,
							Inner: [
								minted("inner", {
									Finally: 0,
									Result: null
								})
							]
						})
					);
				}
				await runtime.dispatch(seatsNested, "root");
				const asking = runtime.dispatch(asksOn, "root", "~outer");
				const entry = await opened(listed);
				await runtime.dispatch(answers, "~inner", idOf(entry), "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});

			it("answers from a component entity mounted under the ask's owner, and refuses one mounted elsewhere", async () => {
				const { runtime, listed } = build();
				const under = mountComponent(runtime, "panel", {});
				const elsewhere = mountComponent(runtime, "panel-2", {});
				const asking = runtime.dispatch(asksOn, "root", "panel");
				const entry = await opened(listed);
				await expect(runtime.dispatch(answers, elsewhere, idOf(entry), "yes")).rejects.toMatchObject({
					name: "AnswerOutsideOwnerError"
				});
				await runtime.dispatch(answers, under, idOf(entry), "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});
		});

		describe("an ask's wait", () => {
			it("delivers an answer that reached its wait though the owner leaves in the same task", async () => {
				const { runtime, listed } = build();
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				const entry = await opened(listed);
				const answering = runtime.dispatch(answers, entry.OwnerId, idOf(entry), "yes");
				const removing = runtime.dispatch(removesRows, "root");
				await Promise.all([
					answering,
					removing
				]);
				expect(await asking).toBe("yes");
				runtime.dispose();
			});

			it("takes the first answer, and ignores a second and an unknown id", async () => {
				const { runtime, listed, records } = build();
				const asking = runtime.dispatch(asksOn, "root", "panel");
				const id = idOf(await opened(listed));
				function* twice(_draft: IPanel): IActionGenerator<boolean> {
					yield* answer(id, "yes");
					yield* answer(id, "no");
					yield* answer("nobody" as IAskId<IAnswer>, "no");
					return true;
				}
				expect(await runtime.dispatch(twice, "panel")).toBe(true);
				expect(await asking).toBe("yes");
				expect(records.filter((record) => record.Kind === "ask:answer")).toHaveLength(1);
				runtime.dispose();
			});

			it("doesn't run the code after the wait when the runtime is disposed over it, and no answer lands", async () => {
				const { runtime, listed, records } = build();
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				await opened(listed);
				runtime.dispose();
				await asking.catch(() => {});
				await tick();
				expect(runtime.state.Result).toBeNull();
				expect(records.filter((record) => record.Kind === "ask:answer")).toHaveLength(0);
			});

			it("names a waiting asker in a snapshot's InFlight", async () => {
				const { runtime, listed } = build();
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				const entry = await opened(listed);
				expect(JSON.parse(createSnapshot(runtime)).InFlight).toMatchObject([
					{
						Label: "opens",
						EntityId: "root"
					}
				]);
				await runtime.dispatch(answers, entry.OwnerId, idOf(entry), undefined);
				await asking;
				runtime.dispose();
			});

			it("takes a record tap that dispatches on the open's table record", async () => {
				const { runtime, listed } = build();
				function* x(draft: IWorld): IActionGenerator {
					draft.Saves++;
				}
				runtime.on(
					"record",
					(r) => r.Kind === "table" && r.Table === "asks" && r.Value?.State === "pending" && runtime.dispatch(x, "root")
				);
				const asking = runtime.dispatch(opens, "root", "Demo/Name");
				const entry = await opened(listed);
				expect(runtime.state.Saves).toBe(1);
				await runtime.dispatch(answers, entry.OwnerId, idOf(entry), "yes");
				expect(await asking).toBe("yes");
				runtime.dispose();
			});

			it("runs under the test runtime with no stubs", async () => {
				const runtime = createTestRuntime<IWorld>(seed());
				function* asker(draft: IWorld) {
					draft.TreeDialogs.push(minted("marker"));
					return yield* open(
						ask<IAnswer>(draft.TreeDialogs[0]!, {
							Path: "Marker"
						})
					);
				}
				const asking = runtime.dispatch(asker, "root");
				await waitFor(() => pendingAsksOf(runtime, runtime.state).length === 1);
				const [entry] = pendingAsksOf(runtime, runtime.state);
				await runtime.dispatch(answers, entry!.OwnerId, idOf(entry!), "yes");
				expect(await asking).toBe("yes");
			});
		});

		describe("a component entity as owner", () => {
			it("owns an ask from its own action and from a tree action, listed under the entity it mounts under", async () => {
				const { runtime, listed } = build();
				const local = mountComponent(runtime, "panel", {});
				const own = runtime.dispatch(asksOn, local, local);
				const fromTree = runtime.dispatch(asksOn, "root", local);
				const panel = runtime.state.Panels[0]!;
				await waitFor(() => listed(panel).length === 2);
				runtime.unmountComponent(local);
				expect(await own).toBeUndefined();
				expect(await fromTree).toBeUndefined();
				expect(listed(panel)).toEqual([]);
				runtime.dispose();
			});
		});
	});
}

function* brandPins(askId: IAskId<"yes">): IActionGenerator {
	// @ts-expect-error a plain string is not an ask id
	yield* answer("ask-1", "yes");
	// @ts-expect-error the response parameter is invariant
	const widened: IAskId<"yes" | "no"> = askId;
	void widened;
}
void brandPins;

function* dismissalPins(askId: IAskId<string>): IActionGenerator {
	yield* answer(askId);
	yield* answer(askId, undefined);
	yield* answer(askId, "a name");
	// @ts-expect-error a value of the wrong type is not an answer
	yield* answer(askId, 42);
}
void dismissalPins;
