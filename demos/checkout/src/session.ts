import type { IRuntime, IRuntimeOptions } from "treflex";
import type { IRestoreOutcome } from "treflex/snapshot";
import type { ILedger } from "./server/effects";
import type { IFakeServer, IServerWait } from "./server/fakeServer";
import type { IShop } from "./shop/shop";
import { createRuntime } from "treflex";
import { createSnapshot, restoreRuntime, SnapshotRejectedError } from "treflex/snapshot";
import { createFakeServer, serverImplementations } from "./server/fakeServer";
import { repairRestore } from "./shop/repair";
import { getDefaultState, SHOP_ID } from "./shop/shop";

export const SESSION_KEY = "treflex-checkout-session";
export const SERVER_KEY = "treflex-checkout-server";
// Bump when a change to the shape of state makes an older saved session wrong.
export const APP_VERSION = 1;

export interface IStore {
	read(): string | null;
	write(value: string): void;
	clear(): void;
}

export function browserStore(key: string): IStore {
	return {
		read: () => {
			try {
				return localStorage.getItem(key);
			} catch {
				return null;
			}
		},
		write: (value) => {
			try {
				localStorage.setItem(key, value);
			} catch {}
		},
		clear: () => {
			try {
				localStorage.removeItem(key);
			} catch {}
		}
	};
}

export function wrap(runtime: IRuntime<IShop>): string {
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

/** The fake server for the page: its ledger is kept in `store`, apart from the app's session, so it outlives a reload. */
export function storedServer(store: IStore): {
	server: IFakeServer;
	onChange(listener: () => void): void;
} {
	const listeners: (() => void)[] = [];
	let saved: ILedger | undefined;
	try {
		saved = JSON.parse(store.read() ?? "null") ?? undefined;
	} catch {}
	const server = createFakeServer(saved, (ledger) => {
		store.write(JSON.stringify(ledger));
		for (const listener of listeners) listener();
	});
	return {
		server,
		onChange: (listener) => listeners.push(listener)
	};
}

const SLOW: Record<string, number> = {
	"Server/Pay": 2500,
	"Server/ReserveStock": 1200
};

export const pageWait: IServerWait = (type) =>
	new Promise((resolve) => {
		setTimeout(resolve, SLOW[type] ?? 600);
	});

export interface IBooted {
	runtime: IRuntime<IShop>;
	restored: IRestoreOutcome | null;
}

export async function boot(store: IStore, server: IFakeServer, wait: IServerWait, options: IRuntimeOptions = {}): Promise<IBooted> {
	const implementations = serverImplementations(server, wait);
	const setup = (runtime: IRuntime<IShop>): void => {
		for (const [type, fn] of Object.entries(implementations)) runtime.registerImplementation(type, fn);
	};
	const stored = store.read();
	const saved = stored === null ? null : unwrap(stored);
	if (stored !== null && saved === null) store.clear();
	if (saved !== null) {
		try {
			const { runtime, result } = await restoreRuntime<IShop>(saved, {
				rootId: SHOP_ID,
				options,
				setup,
				repair: repairRestore
			});
			if (result.repairError !== undefined) console.error("[checkout] the restore's repair failed:", result.repairError);
			return {
				runtime,
				restored: result
			};
		} catch (error) {
			if (!(error instanceof SnapshotRejectedError)) throw error;
			store.clear();
		}
	}
	const runtime = createRuntime<IShop>(getDefaultState(), options);
	setup(runtime);
	return {
		runtime,
		restored: null
	};
}

/**
 * Saves a moment after each change to saved state and each action's start and end, so the in-flight list the repair
 * reads is current. `save` saves at once, for the page to call as it is hidden; after `stop` nothing is saved.
 */
export function autosave(
	runtime: IRuntime<IShop>,
	store: IStore,
	delayMs = 300
): {
	save(): void;
	stop(): void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const save = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		if (!stopped) store.write(wrap(runtime));
	};
	const off = runtime.on(
		"record",
		(record) => {
			if (!("Root" in record) || record.Root !== "AppState" || timer !== undefined || stopped) return;
			timer = setTimeout(save, delayMs);
		},
		{
			kinds: [
				"action:start",
				"action:end",
				"step",
				"table",
				"entity:dispose"
			]
		}
	);
	return {
		save,
		stop: () => {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			off();
		}
	};
}
