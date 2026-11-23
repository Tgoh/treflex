import type { IRuntime, IRuntimeOptions } from "treflex";
import type { IRestoreOutcome, IRestoreResult } from "treflex/snapshot";
import type { IFakeBackendOptions } from "../backend/fakeBackend";
import type { IPortal } from "./Portal";
import type { IRestoredWork } from "./topics";
import { createRuntime } from "treflex";
import { createSnapshot, restoreRuntime, SnapshotRejectedError } from "treflex/snapshot";
import { AquariumReceiver } from "../aquarium/Aquarium";
import { FishReceiver } from "../aquarium/Fish";
import { registerFakeBackend } from "../backend/fakeBackend";
import { ChatReceiver } from "../chat/Chat";
import { ConversationReceiver } from "../chat/Conversation";
import { TourReceiver } from "../tour/Tour";
import { carryOn, PlannerReceiver } from "../trips/Planner";
import { TripReceiver } from "../trips/Trip";
import { wallClock } from "./clock";
import { announceRestore, getDefaultState, init, PortalReceiver, ROOT_ID } from "./Portal";

export const SESSION_KEY = "treflex-portal-session";
// Bump when a change to the shape of state, or a renamed receiver, makes an older saved session wrong.
export const APP_VERSION = 7;

export interface ISessionStore {
	read(): string | null;
	write(value: string): void;
	clear(): void;
}

export function browserStore(key = SESSION_KEY): ISessionStore {
	return {
		read: () => {
			try {
				return localStorage.getItem(key);
			} catch {
				return null;
			}
		},
		write: (value) => {
			localStorage.setItem(key, value);
		},
		clear: () => {
			try {
				localStorage.removeItem(key);
			} catch {}
		}
	};
}

export function wrap(runtime: IRuntime<IPortal>): string {
	return JSON.stringify({
		AppVersion: APP_VERSION,
		Snapshot: createSnapshot(runtime)
	});
}

export function unwrap(stored: string): string | null {
	try {
		const { AppVersion, Snapshot } = JSON.parse(stored);
		if (AppVersion === APP_VERSION && typeof Snapshot === "string") return Snapshot;
	} catch {}
	return null;
}

const RECEIVERS = [
	PortalReceiver,
	TourReceiver,
	PlannerReceiver,
	TripReceiver,
	AquariumReceiver,
	FishReceiver,
	ChatReceiver,
	ConversationReceiver
];

export const RECEIVER_IDS: readonly string[] = RECEIVERS.map((r) => r.Id);

export function registerReceivers(runtime: IRuntime<IPortal>): void {
	for (const r of RECEIVERS) runtime.registerReceiver(r);
}

/**
 * Announces what the restore resumed and dropped, then starts the dropped trip searches again. It starts only what
 * `dropped` names, never what the tree looks to need: a resumed flight question is already running.
 */
export async function repairRestore(runtime: IRuntime<IPortal>, outcome: IRestoreResult): Promise<void> {
	const work = (
		entries: readonly {
			name: string | null;
			entityId: string;
		}[]
	): IRestoredWork[] =>
		entries.map((entry) => ({
			Name: entry.name,
			EntityId: entry.entityId
		}));
	// Announced first, so the Portal/Restored cases read each dropped search before it starts again and can't miss one that finishes.
	await runtime.dispatch(announceRestore, ROOT_ID, work(outcome.resumed), work(outcome.dropped));
	await runtime.dispatch(carryOn, runtime.state.Trips.$Id, outcome.dropped);
}

export interface IBootOptions {
	options?: IRuntimeOptions;
	backend?: IFakeBackendOptions;
	// Runs inside setup, before anything dispatches: an action samples the taps at its dispatch.
	attach?: (runtime: IRuntime<IPortal>) => void;
}

export interface IBooted {
	runtime: IRuntime<IPortal>;
	restored: IRestoreOutcome | null;
	/** What the store held once boot had read it: the session it restored, or null. */
	read: string | null;
}

export async function boot(store: ISessionStore, { options = {}, backend, attach }: IBootOptions = {}): Promise<IBooted> {
	const setup = (runtime: IRuntime<IPortal>): void => {
		registerReceivers(runtime);
		registerFakeBackend(runtime, backend);
		attach?.(runtime);
	};
	const stored = store.read();
	const saved = stored === null ? null : unwrap(stored);
	if (stored !== null && saved === null) store.clear();
	if (saved !== null) {
		try {
			const { runtime, result } = await restoreRuntime<IPortal>(saved, {
				rootId: ROOT_ID,
				options,
				setup,
				repair: repairRestore
			});
			if (result.repairError !== undefined) console.error("[portal] the restore's repair failed:", result.repairError);
			return {
				runtime,
				restored: result,
				read: stored
			};
		} catch (error) {
			if (!(error instanceof SnapshotRejectedError)) throw error;
			store.clear();
		}
	}
	const runtime = createRuntime<IPortal>(getDefaultState(), options);
	setup(runtime);
	await runtime.dispatch(init, ROOT_ID);
	return {
		runtime,
		restored: null,
		read: null
	};
}

export interface ISaveInfo {
	At: number;
	Bytes: number;
	Entities: number;
}

export interface ISaveState {
	Last: ISaveInfo | null;
	Failing: boolean;
}

export interface IAutosave {
	saveNow(): void;
	// A reset needs this before it clears the store: the save on pagehide would write the session back.
	disable(): void;
	/** While paused nothing is written, saveNow included. */
	setPaused(paused: boolean): void;
	/** The text this autosave last wrote, or null before its first write. */
	lastWritten(): string | null;
	state(): ISaveState;
	onChange(listener: (state: ISaveState) => void): () => void;
}

/** The part of `document` the tab watch uses. */
export interface ITabDocument {
	readonly visibilityState: string;
	addEventListener(type: "visibilitychange", listener: () => void): void;
}

/** The part of `window` the tab watch uses. */
export interface ITabWindow {
	addEventListener(type: "pagehide", listener: () => void): void;
	addEventListener(type: "pageshow", listener: (event: { persisted: boolean }) => void): void;
}

export interface ITabWatch {
	document: ITabDocument;
	window: ITabWindow;
	autosave: IAutosave;
	store: ISessionStore;
	/** What boot read from the store: `IBooted.read`. */
	read: string | null;
	reload(): void;
}

/**
 * The browser wiring for one tab's session, so the visitor's tab is the only writer. Only a
 * visible tab saves: a tab that starts hidden or is hidden writes nothing, its unload included,
 * until it is shown. Shown, starting visible included, it reloads if the store no longer holds what
 * it last wrote, or what boot read when it has written nothing, because another tab wrote or
 * cleared the session. A page back from the back/forward cache reloads.
 */
export function watchTabs({ document, window, autosave, store, read, reload }: ITabWatch): void {
	const leave = (): void => {
		autosave.disable();
		reload();
	};
	const shown = (): void => {
		const mine = autosave.lastWritten() ?? read;
		if (!autosave.state().Failing && store.read() !== mine) {
			leave();
			return;
		}
		autosave.setPaused(false);
	};
	if (document.visibilityState === "hidden") autosave.setPaused(true);
	else shown();
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "hidden") {
			shown();
			return;
		}
		autosave.saveNow();
		autosave.setPaused(true);
	});
	window.addEventListener("pagehide", () => autosave.saveNow());
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) leave();
	});
}

export function createAutosave(
	runtime: IRuntime<IPortal>,
	store: ISessionStore,
	{
		delayMs = 400,
		now = wallClock,
		paused: startPaused = false
	}: {
		delayMs?: number;
		now?: () => number;
		/** Start paused, for a tab whose watchTabs decides when it may write. */
		paused?: boolean;
	} = {}
): IAutosave {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disabled = false;
	let paused = startPaused;
	let written: string | null = null;
	let warned = false;
	let state: ISaveState = {
		Last: null,
		Failing: false
	};
	const listeners = new Set<(state: ISaveState) => void>();
	const set = (next: ISaveState): void => {
		state = next;
		for (const listener of listeners) listener(state);
	};

	const saveNow = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (disabled || paused) return;
		const value = wrap(runtime);
		try {
			store.write(value);
			written = value;
		} catch (error) {
			if (!warned) console.warn("[portal] this browser won't save the session:", error);
			warned = true;
			if (!state.Failing) {
				set({
					...state,
					Failing: true
				});
			}
			return;
		}
		set({
			Last: {
				At: now(),
				Bytes: value.length,
				Entities: value.split('\\"$Id\\":').length - 1
			},
			Failing: false
		});
	};

	runtime.on(
		"record",
		(record) => {
			if (!("Root" in record) || record.Root !== "AppState" || timer !== undefined || disabled || paused) return;
			timer = setTimeout(saveNow, delayMs);
		},
		{
			kinds: [
				"step",
				"table",
				"entity:dispose"
			]
		}
	);

	return {
		saveNow,
		disable: () => {
			disabled = true;
			if (timer !== undefined) clearTimeout(timer);
		},
		setPaused: (next) => {
			paused = next;
			if (paused && timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (!paused) saveNow();
		},
		lastWritten: () => written,
		state: () => state,
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}
