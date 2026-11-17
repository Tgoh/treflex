import type { IRuntime } from "treflex";
import type { IPortal } from "./Portal";
import type { IAutosave, ISessionStore } from "./session";
import { createTestRuntime, guids, settled } from "treflex";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTrip } from "../trips/Planner";
import { getDefaultState } from "./Portal";
import { APP_VERSION, boot, createAutosave as createAutosaveFor, registerReceivers, watchTabs, wrap } from "./session";

const runtimes: IRuntime<IPortal>[] = [];
const autosaves: IAutosave[] = [];

const createAutosave = (...args: Parameters<typeof createAutosaveFor>): IAutosave => {
	const autosave = createAutosaveFor(...args);
	autosaves.push(autosave);
	return autosave;
};

afterEach(() => {
	for (const autosave of autosaves.splice(0)) autosave.disable();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function memoryStore(initial: string | null = null): ISessionStore & {
	value: string | null;
} {
	const store = {
		value: initial,
		read: () => store.value,
		write: (value: string) => {
			store.value = value;
		},
		clear: () => {
			store.value = null;
		}
	};
	return store;
}

function running(): IRuntime<IPortal> {
	const runtime = createTestRuntime<IPortal>(getDefaultState(), {
		generateGuid: guids("s"),
		"Backend/CheckProvider": () => new Promise(() => {})
	});
	registerReceivers(runtime);
	runtimes.push(runtime);
	return runtime;
}

describe("the session", () => {
	it("boots fresh from an empty store", async () => {
		const { runtime, restored } = await boot(memoryStore());
		runtimes.push(runtime);
		expect(restored).toBeNull();
		expect(runtime.state.Trips.Trips).toHaveLength(0);
		await settled();
		expect(runtime.state.Aquarium.Schools).toHaveLength(3);
		expect(runtime.state.Chat.Conversations).toHaveLength(8);
		expect(runtime.timers(runtime.state.Chat).map((row) => row.Key)).toEqual([
			"Chat/Cue"
		]);
	});

	it("restores a saved session and tells the apps what was running", async () => {
		const before = running();
		await before.dispatch(startTrip, "Trips", "lisbon");
		await settled();
		const store = memoryStore(wrap(before));

		const { runtime, restored } = await boot(store);
		runtimes.push(runtime);
		await settled();
		expect(restored?.dropped.length).toBeGreaterThan(0);
		expect(runtime.state.Trips.Trips).toHaveLength(1);
		expect(runtime.state.Tour.Reloaded).toBe(false);
		expect(runtime.state.Trips.Restore?.Trips[0].Stopped).toHaveLength(3);
	});

	it("discards a session another app version wrote", async () => {
		const store = memoryStore(
			JSON.stringify({
				AppVersion: APP_VERSION + 1,
				Snapshot: "{}"
			})
		);
		const { runtime, restored } = await boot(store);
		runtimes.push(runtime);
		expect(restored).toBeNull();
		expect(store.value).toBeNull();
	});

	it("saves soon after a change to saved state, and not once disabled", async () => {
		const runtime = running();
		const store = memoryStore();
		const autosave = createAutosave(runtime, store, {
			delayMs: 0
		});
		await runtime.dispatch(startTrip, "Trips", "kyoto");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(store.value).toContain("kyoto");
		expect(autosave.state().Last?.Entities).toBeGreaterThan(5);

		autosave.disable();
		store.clear();
		await runtime.dispatch(startTrip, "Trips", "lisbon");
		autosave.saveNow();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(store.value).toBeNull();
	});

	describe("tabs on one store", () => {
		function fakePage(visible: boolean) {
			const listeners = new Map<string, ((event?: unknown) => void)[]>();
			const on = (type: string, listener: (event: never) => void): void => {
				listeners.set(type, [
					...(listeners.get(type) ?? []),
					listener as (event?: unknown) => void
				]);
			};
			const fire = (type: string, event?: unknown): void => {
				for (const listener of listeners.get(type) ?? []) listener(event);
			};
			const document = {
				visibilityState: visible ? "visible" : "hidden",
				addEventListener: on
			};
			return {
				document,
				window: {
					addEventListener: on
				},
				hide: () => {
					document.visibilityState = "hidden";
					fire("visibilitychange");
				},
				show: () => {
					document.visibilityState = "visible";
					fire("visibilitychange");
				},
				unload: () => fire("pagehide"),
				throughCache: () => {
					fire("pagehide", {
						persisted: true
					});
					document.visibilityState = "hidden";
					fire("visibilitychange");
					document.visibilityState = "visible";
					fire("visibilitychange");
					fire("pageshow", {
						persisted: true
					});
				}
			};
		}

		const never = () => new Promise<void>(() => {});

		async function tab(store: ISessionStore, visible: boolean, delayMs = 0) {
			return watch(await booted(store, delayMs), store, visible);
		}

		async function booted(store: ISessionStore, delayMs = 0) {
			let autosave: IAutosave | undefined;
			const { runtime, read } = await boot(store, {
				options: {
					pauseTimers: true
				},
				backend: {
					wait: never,
					chatWait: never
				},
				attach: (r) => {
					autosave = createAutosave(r, store, {
						delayMs,
						paused: true
					});
				}
			});
			runtimes.push(runtime);
			await settled();
			return {
				runtime,
				read,
				autosave: autosave!
			};
		}

		function watch({ runtime, read, autosave }: Awaited<ReturnType<typeof booted>>, store: ISessionStore, visible: boolean) {
			const page = fakePage(visible);
			const reloads = {
				count: 0
			};
			watchTabs({
				document: page.document,
				window: page.window,
				autosave,
				store,
				read,
				reload: () => reloads.count++
			});
			return {
				runtime,
				reloads,
				...page
			};
		}
		const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
		const plan = async (t: Awaited<ReturnType<typeof tab>>, destination: "lisbon" | "kyoto" | "reykjavik") => {
			await t.runtime.dispatch(startTrip, "Trips", destination);
			await tick();
		};

		it("writes nothing from a tab that boots hidden, its unload included, until it is shown", async () => {
			const store = memoryStore();
			const a = await tab(store, true);
			const written = store.value;
			const b = await tab(store, false);
			expect(store.value).toBe(written);
			await plan(b, "kyoto");
			b.unload();
			expect(store.value).toBe(written);

			a.hide();
			b.show();
			expect(b.reloads.count).toBe(0);
			expect(store.value).toContain("kyoto");
		});

		it("reloads a tab that booted hidden when it is shown after another tab wrote", async () => {
			const store = memoryStore();
			const a = await tab(store, true);
			const b = await tab(store, false);
			await plan(a, "lisbon");
			a.hide();
			b.show();
			expect(b.reloads.count).toBe(1);
			expect(store.value).toContain("lisbon");
		});

		it("stops writing while hidden and carries on when shown with no other writer", async () => {
			const store = memoryStore();
			const a = await tab(store, true);
			a.hide();
			await plan(a, "kyoto");
			a.unload();
			expect(store.value).not.toContain("kyoto");

			a.show();
			expect(a.reloads.count).toBe(0);
			expect(store.value).toContain("kyoto");
		});

		it("reloads a page that comes back from the back/forward cache, having saved only its own state", async () => {
			const store = memoryStore();
			const a = await tab(store, true);
			await plan(a, "kyoto");
			const own = store.value;
			expect(own).toContain("kyoto");
			a.throughCache();
			expect(a.reloads.count).toBe(1);
			expect(store.value).toBe(own);
			await plan(a, "lisbon");
			a.unload();
			expect(store.value).toBe(own);
		});

		it("checks the store when it starts visible, so another tab's write since boot read it stands", async () => {
			const store = memoryStore();
			const a = await tab(store, true);
			const b = await booted(store);
			await plan(a, "kyoto");
			a.hide();
			expect(store.value).toContain("kyoto");
			const watched = watch(b, store, true);
			expect(watched.reloads.count).toBe(1);
			expect(store.value).toContain("kyoto");
		});

		it("saves a change still waiting on the autosave delay as the tab is hidden", async () => {
			const store = memoryStore();
			const a = await tab(store, true, 400);
			await a.runtime.dispatch(startTrip, "Trips", "reykjavik");
			a.hide();
			expect(store.value).toContain("reykjavik");
		});

		it("reloads a tab shown after another tab cleared the session", async () => {
			const store = memoryStore();
			const a = await tab(store, true);
			a.hide();
			store.clear();
			a.show();
			expect(a.reloads.count).toBe(1);
		});

		it("loses nothing over a quick chain of switches between three tabs", async () => {
			const store = memoryStore();
			const a = await tab(store, true);
			a.hide();
			const b = await tab(store, true);
			await plan(b, "reykjavik");

			b.hide();
			a.show();
			expect(a.reloads.count).toBe(1);
			const reloadedA = await tab(store, true);

			reloadedA.hide();
			b.show();
			expect(b.reloads.count).toBe(1);
			const reloadedB = await tab(store, true);
			await plan(reloadedB, "lisbon");

			reloadedB.hide();
			reloadedA.show();
			expect(reloadedA.reloads.count).toBe(1);
			expect(store.value).toContain("lisbon");
			expect(store.value).toContain("reykjavik");
		});
	});

	it("warns once when this browser won't save, and says so until a save works", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const runtime = running();
			let full = true;
			const store = memoryStore();
			const write = store.write;
			store.write = (value) => {
				if (full) throw new Error("QuotaExceededError");
				write(value);
			};
			const autosave = createAutosave(runtime, store);
			const seen: boolean[] = [];
			autosave.onChange((state) => seen.push(state.Failing));
			autosave.saveNow();
			autosave.saveNow();
			autosave.saveNow();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(autosave.state().Failing).toBe(true);
			expect(seen).toEqual([
				true
			]);

			full = false;
			autosave.saveNow();
			expect(autosave.state().Failing).toBe(false);
			expect(autosave.state().Last).not.toBeNull();
		} finally {
			warn.mockRestore();
		}
	});
});
