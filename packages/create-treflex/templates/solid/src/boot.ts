import { createRuntime, type IRuntime, type IRuntimeOptions } from "treflex";
import {
	createSnapshot,
	restoreRuntime,
	SnapshotRejectedError,
} from "treflex/snapshot";
import { type IApp, seed } from "./app";
import { interrupted } from "./counter/counter";
import { delayImpl } from "./counter/implementations/delay";

const KEY = "app";
const APP_VERSION = 1;

// A failure nothing else takes is also thrown as an unhandled rejection
// without an onError.
const options: IRuntimeOptions = { onError: () => {} };

function setup(runtime: IRuntime<IApp>): void {
	runtime.registerImplementation(delayImpl);
	runtime.on("failure", (event) =>
		console.error(`${event.ActionName} failed`, event.Error),
	);
}

function readSave(): string | null {
	try {
		const stored = localStorage.getItem(KEY);
		if (stored === null) return null;
		const { AppVersion, Snapshot } = JSON.parse(stored);
		if (AppVersion === APP_VERSION && typeof Snapshot === "string") {
			return Snapshot;
		}
	} catch {}
	return null;
}

function writeSave(runtime: IRuntime<IApp>): void {
	try {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				AppVersion: APP_VERSION,
				Snapshot: createSnapshot(runtime),
			}),
		);
	} catch {}
}

async function restoreOrCreate(): Promise<IRuntime<IApp>> {
	const saved = readSave();
	if (saved) {
		try {
			const { runtime } = await restoreRuntime(saved, {
				rootId: "App",
				options,
				setup,
				repair: async (runtime, result) => {
					const counter = runtime.state.Counter;
					if (result.dropped.some((d) => d.entityId === counter.$Id)) {
						await runtime.dispatch(interrupted, counter);
					}
				},
			});
			return runtime;
		} catch (error) {
			if (!(error instanceof SnapshotRejectedError)) throw error;
			console.warn("Discarded a save the restore refused:", error);
		}
	}
	const runtime = createRuntime<IApp>(seed(), options);
	setup(runtime);
	return runtime;
}

export async function boot(): Promise<IRuntime<IApp>> {
	const runtime = await restoreOrCreate();
	addEventListener("pagehide", () => writeSave(runtime));
	return runtime;
}

// A feature's module swaps its actions and selectors into the running app, so
// an edit to one listed here stops here. Any other edit under this module
// reloads the page, which saves and restores.
import.meta.hot?.accept(["./counter/counter"], () => {});
