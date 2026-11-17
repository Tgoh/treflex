import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { parallel } from "../../src/Effects/parallel";
import { createRuntime, type IRuntime, type IRuntimeOptions } from "../../src/Runtime/createRuntime";
import { seat } from "../../src/Runtime/draftNode";
import { FINALLY_YIELD_LIMIT } from "../../src/Runtime/fiberMachine";
import { open } from "../../src/Runtime/open";
import { transient } from "../../src/Runtime/transient";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";

const loading = (draft: IEntity) =>
	transient(draft, "loading", {
		Count: 0
	});

function* counted<R>(draft: IEntity, body: () => IActionGenerator<R>): IActionGenerator<R> {
	const s = yield* loading(draft);
	s.Count++;
	try {
		return yield* body();
	} finally {
		s.Count--;
	}
}

function countOf(runtime: IRuntime<IWorld>, owner: IEntity): number {
	return runtime.processSelector(
		function* (draft: IEntity) {
			return (yield* loading(draft)).Count;
		},
		() => owner
	);
}

interface IPanel extends IEntity {
	Loaded?: string;
}

interface IWorld extends IEntity {
	Panels: IPanel[];
}

function seed(): IWorld {
	return {
		$Id: "root",
		Panels: [
			{
				$Id: "panel"
			}
		]
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const options: IRuntimeOptions = {
	onError: () => {}
};

function build() {
	return wire(createRuntime<IWorld>(seed(), options));
}

function wire(runtime: IRuntime<IWorld>) {
	const releases: ((value?: unknown) => void)[] = [];
	runtime.registerImplementation(
		"fetch",
		() =>
			new Promise((resolve) => {
				releases.push(resolve);
			})
	);
	const panel = () => runtime.state.Panels[0];
	const onPanel = <R>(action: IAction<IPanel, [], R>) => runtime.dispatch(action, "panel");
	return {
		runtime,
		releases,
		panel,
		onPanel
	};
}

function* fetchIt(): IActionGenerator<string> {
	return yield {
		Type: "fetch"
	};
}

function* trips(): IActionGenerator {
	yield* fetchIt();
	throw new Error("tripped");
}

function* load(draft: IPanel): IActionGenerator<string> {
	const loaded = yield* counted(draft, fetchIt);
	draft.Loaded = loaded;
	return loaded;
}

function* removePanel(draft: IWorld): IActionGenerator {
	draft.Panels = [];
}

function* addPanel(draft: IWorld): IActionGenerator {
	seat(draft.Panels, draft.Panels.length, seed().Panels[0]);
}

describe("a count kept in a slot and taken down in a finally", () => {
	it("lands a slot write in the same flush as the draft writes of its step", async () => {
		const h = build();
		await createRoot(async (dispose) => {
			const seen: string[] = [];
			createEffect(() => {
				seen.push(`${countOf(h.runtime, h.panel())}/${h.panel().Loaded ?? ""}`);
			});
			await settle();
			const done = h.onPanel(function* (draft) {
				yield* counted(draft, function* () {
					draft.Loaded = "starting";
					yield* fetchIt();
				});
				draft.Loaded = "finished";
			});
			await settle();
			h.releases[0]();
			await done;
			await settle();
			expect(seen).toEqual([
				"0/",
				"1/starting",
				"0/finished"
			]);
			dispose();
		});
	});

	it("lands a draft write made before the slot's yield ahead of the slot write, since the yield ends the step", async () => {
		const h = build();
		await createRoot(async (dispose) => {
			const seen: string[] = [];
			createEffect(() => {
				seen.push(`${countOf(h.runtime, h.panel())}/${h.panel().Loaded ?? ""}`);
			});
			await settle();
			const done = h.onPanel(function* (draft) {
				draft.Loaded = "ahead";
				yield* counted(draft, fetchIt);
			});
			await settle();
			h.releases[0]();
			await done;
			await settle();
			expect(seen).toEqual([
				"0/",
				"0/ahead",
				"1/ahead",
				"0/ahead"
			]);
			dispose();
		});
	});

	it("runs the finally of a branch its sibling's failure stopped, which writes its slot", async () => {
		const h = build();
		const done = h.onPanel(function* (draft) {
			yield* parallel(counted(draft, fetchIt), trips());
		});
		await settle();
		expect(countOf(h.runtime, h.panel())).toBe(1);
		h.releases[1]!();
		await expect(done).rejects.toThrow("tripped");
		expect(countOf(h.runtime, h.panel())).toBe(0);
	});

	it("does not throw when the owner is removed while its action waits with the slot written", async () => {
		const errors: unknown[] = [];
		const runtime = createRuntime<IWorld>(seed(), {
			onError: (error) => errors.push(error)
		});
		runtime.registerImplementation("fetch", () => new Promise(() => {}));
		const done = runtime.dispatch(load, "panel");
		await settle();
		await runtime.dispatch(removePanel, "root");
		await expect(done).resolves.toBeUndefined();
		expect(errors).toEqual([]);
	});

	it("keeps a stale finally off the slot of an owner re-added under the same $Id", async () => {
		const errors: unknown[] = [];
		const runtime = createRuntime<IWorld>(seed(), {
			onError: (error) => errors.push(error)
		});
		runtime.registerImplementation("fetch", () => new Promise(() => {}));
		const old = runtime.dispatch(load, "panel");
		await settle();
		await runtime.dispatch(removePanel, "root");
		await runtime.dispatch(addPanel, "root");
		void runtime.dispatch(load, "panel");
		await old;
		await settle();
		expect(countOf(runtime, runtime.state.Panels[0])).toBe(1);
		expect(errors).toEqual([]);
	});

	it("keeps a stale finally that runs after the re-add, in the same turn as the removal, off the new owner's slot", async () => {
		const errors: unknown[] = [];
		const runtime = createRuntime<IWorld>(seed(), {
			onError: (error) => errors.push(error)
		});
		runtime.registerImplementation("fetch", () => new Promise(() => {}));
		const old = runtime.dispatch(load, "panel");
		await settle();
		const reAdd = runtime.dispatch(function* (draft: IWorld): IActionGenerator {
			draft.Panels = [];
			yield* generateGuid();
			seat(draft.Panels, draft.Panels.length, seed().Panels[0]);
		}, "root");
		await reAdd;
		await old;
		expect(countOf(runtime, runtime.state.Panels[0])).toBe(0);
		expect(errors).toEqual([]);
	});

	it("shows a second caller a slot read and written in one step, during the first caller's open wait", async () => {
		const h = build();
		function* claimed(draft: IPanel) {
			const s = yield* loading(draft);
			if (s.Count > 0) {
				return "skipped";
			}
			s.Count++;
			try {
				return yield* open(fetchIt());
			} finally {
				s.Count--;
			}
		}
		const first = h.onPanel(claimed);
		await expect(h.onPanel(claimed)).resolves.toBe("skipped");
		h.releases[0]("loaded");
		await expect(first).resolves.toBe("loaded");
		expect(countOf(h.runtime, h.panel())).toBe(0);
		expect(h.releases).toHaveLength(1);
	});

	it("takes the count down when a finally inside it yields, and says so", async () => {
		const h = build();
		const codes: string[] = [];
		h.runtime.on("diag", (event) => {
			codes.push(event.code);
		});
		function* yieldingCleanup(): IActionGenerator<string> {
			try {
				return yield* fetchIt();
			} finally {
				yield* fetchIt();
			}
		}
		const done = h.onPanel(function* (draft) {
			yield* parallel(counted(draft, yieldingCleanup), trips());
		});
		await settle();
		expect(countOf(h.runtime, h.panel())).toBe(1);
		h.releases[1]!();
		await expect(done).rejects.toThrow("tripped");
		expect(codes).toEqual([
			"cancel/finally-yield"
		]);
		expect(countOf(h.runtime, h.panel())).toBe(0);
		expect(h.releases).toHaveLength(2);
	});

	it("leaves a finally past the close drain's limit unrun, its slot write with it, until the owner goes, and says so", async () => {
		const h = build();
		const codes: string[] = [];
		h.runtime.on("diag", (event) => {
			codes.push(event.code);
		});
		function* deep(depth: number): IActionGenerator<string> {
			if (depth === 0) {
				return yield* fetchIt();
			}
			try {
				return yield* deep(depth - 1);
			} finally {
				yield* fetchIt();
			}
		}
		const done = h.onPanel(function* (draft) {
			yield* parallel(
				counted(draft, () => deep(FINALLY_YIELD_LIMIT + 1)),
				trips()
			);
		});
		await settle();
		expect(countOf(h.runtime, h.panel())).toBe(1);
		h.releases[1]!();
		await expect(done).rejects.toThrow("tripped");
		expect(codes).toContain("cancel/finally-yield-limit");
		expect(countOf(h.runtime, h.panel())).toBe(1);
		await h.runtime.dispatch(removePanel, "root");
		await h.runtime.dispatch(addPanel, "root");
		expect(countOf(h.runtime, h.panel())).toBe(0);
	});

	it("starts the slot empty after a restore, with nothing of it in the snapshot", async () => {
		const a = build();
		void a.onPanel(load);
		await settle();
		expect(countOf(a.runtime, a.panel())).toBe(1);
		const saved = createSnapshot(a.runtime);
		expect(saved).not.toContain("loading");
		a.runtime.dispose();

		let b!: ReturnType<typeof wire>;
		await restoreRuntime<IWorld>(saved, {
			rootId: "root",
			options,
			setup: (runtime) => {
				b = wire(runtime);
			}
		});
		expect(countOf(b.runtime, b.panel())).toBe(0);
		const done = b.onPanel(load);
		await settle();
		expect(countOf(b.runtime, b.panel())).toBe(1);
		b.releases[0]("again");
		await done;
		expect(countOf(b.runtime, b.panel())).toBe(0);
	});
});
