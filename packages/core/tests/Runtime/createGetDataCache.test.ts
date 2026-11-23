import type { ISetState } from "../../src/Runtime/sliceSetState";
import { describe, expect, it, vi } from "vitest";
import { createDataSourceMap } from "../../src/Runtime/createDataSourceMap";
import { createGetDataCache } from "../../src/Runtime/createGetDataCache";
import { createJournal } from "../../src/Runtime/createJournal";
import { createWriteGateway } from "../../src/Runtime/createWriteGateway";
import { rawOf } from "../../src/Runtime/viewProxy";
import * as reactive from "../reactive";
import { createTreeState, minted } from "../testHelpers";

function makeCache() {
	const disposeCallbacks: ((id: string) => void)[] = [];
	let calls = 0;
	const cache = createGetDataCache({
		onDispose: (cb) => disposeCallbacks.push(cb),
		resolveData: (key, fromId) => {
			calls++;
			return `${key}:${fromId ?? ""}`;
		},
		resolveGlobalData: (key) => {
			calls++;
			return `${key}:global`;
		}
	});
	const fireDispose = (id: string) => {
		disposeCallbacks.forEach((cb) => {
			cb(id);
		});
	};
	return {
		cache,
		fireDispose,
		callCount: () => calls
	};
}

describe("createGetDataCache", () => {
	it("memoizes a scoped resolution — repeated reads of the same (key, fromId) build one memo", () => {
		const { cache, callCount } = makeCache();

		expect(cache.resolve("Theme", "entityA")).toBe("Theme:entityA");
		expect(cache.resolve("Theme", "entityA")).toBe("Theme:entityA");
		expect(callCount()).toBe(1);
	});

	it("keys scoped memos by both fromId and key — distinct pairs get distinct memos", () => {
		const { cache, callCount } = makeCache();

		cache.resolve("Theme", "entityA");
		cache.resolve("Theme", "entityB");
		cache.resolve("Roles", "entityA");
		expect(callCount()).toBe(3);
	});

	it("frees a scoped memo when its from entity disposes", () => {
		const { cache, fireDispose, callCount } = makeCache();

		cache.resolve("Theme", "entityA");
		cache.resolve("Theme", "entityA");
		expect(callCount()).toBe(1);

		fireDispose("entityA");

		cache.resolve("Theme", "entityA");
		expect(callCount()).toBe(2);
	});

	it("disposing an unrelated entity leaves a scoped memo intact", () => {
		const { cache, fireDispose, callCount } = makeCache();

		cache.resolve("Theme", "entityA");
		expect(callCount()).toBe(1);

		fireDispose("entityB");

		cache.resolve("Theme", "entityA");
		expect(callCount()).toBe(1);
	});

	it("memoizes global resolutions per key", () => {
		const { cache, callCount } = makeCache();

		expect(cache.resolveGlobal("Theme")).toBe("Theme:global");
		expect(cache.resolveGlobal("Theme")).toBe("Theme:global");
		expect(callCount()).toBe(1);

		cache.resolveGlobal("Roles");
		expect(callCount()).toBe(2);
	});

	it("dispose() tears down global memos — a later resolve rebuilds", () => {
		const { cache, callCount } = makeCache();

		cache.resolveGlobal("Theme");
		expect(callCount()).toBe(1);

		cache.dispose();

		cache.resolveGlobal("Theme");
		expect(callCount()).toBe(2);
	});

	it("keeps an empty anchor's memo out of the global store", () => {
		const { cache, callCount } = makeCache();

		expect(cache.resolve("Theme", "")).toBe("Theme:");
		expect(cache.resolveGlobal("Theme")).toBe("Theme:global");
		expect(callCount()).toBe(2);

		expect(cache.resolve("Theme", "")).toBe("Theme:");
		expect(cache.resolveGlobal("Theme")).toBe("Theme:global");
		expect(callCount()).toBe(2);
	});
});

describe("getData exactness over the write-gateway index", () => {
	type IWorldState = {
		$Id: string;
		source: {
			$Id: string;
			Value: number;
		};
		consumer: {
			$Id: string;
			Value: number;
		};
		other: {
			$Id: string;
			Value: number;
			items: {
				$Id: string;
			}[];
		};
	};

	function buildWorld() {
		const gateway = createWriteGateway({
			journal: createJournal(),
			emitDiag: () => {}
		});
		const {
			raw,
			state,
			setState: wrapped
		} = createTreeState<IWorldState>(
			{
				$Id: "root",
				source: {
					$Id: "source",
					Value: 1
				},
				consumer: {
					$Id: "consumer",
					Value: 0
				},
				other: {
					$Id: "other",
					Value: 0,
					items: []
				}
			},
			gateway
		);
		gateway.connect(raw, wrapped);
		const setState: ISetState<IWorldState> = (...args: ((x: any) => any)[]) => gateway.exemptFrame(() => wrapped(...args));
		const dataSources = createDataSourceMap({
			onDispose: (cb) => gateway.onDispose(cb, "tables")
		});
		let resolveRuns = 0;
		const cache = createGetDataCache({
			onDispose: (cb) => gateway.onDispose(cb, "caches"),
			resolveData: (key, fromId) => {
				resolveRuns++;
				return dataSources.resolve(key, fromId, gateway.lookup());
			},
			resolveGlobalData: (key) => {
				resolveRuns++;
				return dataSources.resolveGlobal(key, gateway.lookup());
			}
		});
		return {
			state,
			setState,
			dataSources,
			cache,
			lookup: gateway.lookup,
			resolveRuns: () => resolveRuns
		};
	}

	it("a scalar write re-runs zero getData memos — related or not", () => {
		const world = buildWorld();
		world.dataSources.add("Theme", "root", "source");

		expect(rawOf(world.cache.resolve("Theme", "consumer") as object)).toBe(rawOf(world.state.source));
		expect(world.resolveRuns()).toBe(1);

		world.setState((s) => {
			s.other.Value = 42;
		});
		world.setState((s) => {
			s.consumer.Value = 7;
		});
		// Even a scalar write INSIDE the resolved source: the memo returns
		// the node, whose cell only changes on structural moves — consumers
		// reading fields off it subscribe to those fields directly.
		world.setState((s) => {
			s.source.Value = 2;
		});
		expect(world.resolveRuns()).toBe(1);

		world.setState((s) => {
			s.other.items.push(minted("noise"));
		});
		expect(world.resolveRuns()).toBe(1);
	});

	it("a path-query consumer does not re-run on unrelated churn (the pathResultsEqual workaround retired)", () => {
		reactive.root((dispose) => {
			const world = buildWorld();
			world.dataSources.add("Theme", "root", "source");

			let consumerRuns = 0;
			const consumer = reactive.memo(() => {
				consumerRuns++;
				return world.dataSources.resolveWithPath("Theme", "consumer", world.lookup());
			});
			expect(consumer().ancestors).toEqual([
				"consumer",
				"root"
			]);
			expect(consumerRuns).toBe(1);

			world.setState((s) => {
				s.other.items.push(minted("window-1"));
			});
			world.setState((s) => {
				s.other.Value = 9;
			});
			expect(consumerRuns).toBe(1);

			world.dataSources.add("Theme", "consumer", "other");
			expect(consumer().ancestors).toEqual([
				"consumer"
			]);
			expect(consumerRuns).toBe(2);
			dispose();
		});
	});

	it("a consumer in the mutation's flush sees cells for entities the same frame created", () => {
		reactive.root((dispose) => {
			const world = buildWorld();
			world.dataSources.add("Theme", "root", "source");

			let consumerRuns = 0;
			const consumer = reactive.memo(() =>
				world.state.other.items.map((item) => {
					consumerRuns++;
					return world.cache.resolve("Theme", item.$Id);
				})
			);
			expect(consumer()).toEqual([]);

			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				world.setState((s) => {
					s.other.items.push(minted("graft-1"));
				});
				expect(rawOf(consumer()[0] as object)).toBe(rawOf(world.state.source));
				expect(consumerRuns).toBe(1);
				expect(warn).not.toHaveBeenCalled();
			} finally {
				warn.mockRestore();
			}
			dispose();
		});
	});
});
