import type { IRuntimeInternal } from "../../src/Runtime/internals";
import { describe, expect, it } from "vitest";
import { createJournal } from "../../src/Runtime/createJournal";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createWriteGateway } from "../../src/Runtime/createWriteGateway";
import { createTreeState, rootSetState } from "../testHelpers";

function buildWorld<T extends object>(initial: T) {
	const journal = createJournal();
	const gateway = createWriteGateway({
		journal,
		emitDiag: () => {}
	});
	const { raw, state, setState } = createTreeState<T>(initial, gateway);
	gateway.connect(raw, setState);
	const write = (fn: (s: T) => void) => gateway.exemptFrame(() => setState(fn));
	return {
		state,
		write,
		gateway,
		journal
	};
}

describe("write gateway: dispose ordering", () => {
	it("emits entity:dispose after every onDispose callback has run", () => {
		const world = buildWorld<{
			$Id: string;
			Leaf: {
				$Id: string;
			} | null;
		}>({
			$Id: "Root",
			Leaf: {
				$Id: "Leaf"
			}
		});

		const sequence: string[] = [];
		world.gateway.onDispose((id) => sequence.push(`cleanup-a:${id}`), "tables");
		world.gateway.onDispose((id) => sequence.push(`cleanup-b:${id}`), "caches");
		world.journal.tap((record) => {
			if (record.Kind === "entity:dispose") {
				sequence.push(`emit:${record.EntityId}`);
			}
		});

		world.write((s) => {
			s.Leaf = null;
		});

		expect(sequence).toEqual([
			"cleanup-a:Leaf",
			"cleanup-b:Leaf",
			"emit:Leaf"
		]);
	});

	it("emits entity:dispose leaves-first across a subtree, with cleanups before each emit", () => {
		const world = buildWorld({
			$Id: "Root",
			child: {
				$Id: "Child",
				grandchild: {
					$Id: "Grandchild"
				}
			}
		});

		const sequence: string[] = [];
		world.gateway.onDispose((id) => sequence.push(`cleanup:${id}`), "tables");
		world.journal.tap((record) => {
			if (record.Kind === "entity:dispose") {
				sequence.push(`emit:${record.EntityId}`);
			}
		});

		world.gateway.dispose();

		expect(sequence).toEqual([
			"cleanup:Grandchild",
			"emit:Grandchild",
			"cleanup:Child",
			"emit:Child",
			"cleanup:Root",
			"emit:Root"
		]);
	});

	it("the dispose record carries the entity's path snapshotted before the cascade", () => {
		const world = buildWorld({
			$Id: "Root",
			Branch: {
				$Id: "Branch",
				Leaf: {
					$Id: "Leaf"
				} as {
					$Id: string;
				} | null
			}
		});

		let captured:
			| {
					id: string;
					path: readonly string[];
			  }
			| undefined;
		world.journal.tap((record) => {
			if (record.Kind === "entity:dispose") {
				captured = {
					id: record.EntityId,
					path: record.Path
				};
			}
		});

		world.write((s) => {
			s.Branch.Leaf = null;
		});

		expect(captured?.id).toBe("Leaf");
		expect(captured?.path).toEqual([
			"Root",
			"Branch",
			"Leaf"
		]);
	});

	it("a dispose callback reading a selector sees the step's writes, not the pre-write value", async () => {
		// The tree bumps land at the traps, so a memo read mid-drain — from a
		// cascade callback, here — recomputes against the written tree
		// instead of serving the value it held when the frame opened.
		interface IWorld {
			$Id: string;
			Count: number;
			Child: {
				$Id: string;
			} | null;
		}
		const runtime = createRuntime<IWorld>({
			$Id: "Root",
			Count: 0,
			Child: {
				$Id: "Child"
			}
		}) as IRuntimeInternal<IWorld>;
		function* count(state: IWorld): Generator<never, number, never> {
			return state.Count;
		}
		const read = () => runtime.runSelector(count, () => runtime.state);
		expect(read()).toBe(0);

		const seen: number[] = [];
		runtime.get("runtime/writeGateway").onDispose((id) => {
			if (id === "Child") {
				seen.push(read());
			}
		}, "resources");

		function* dropChild(draft: IWorld): Generator<never, void, never> {
			draft.Count = 5;
			draft.Child = null;
		}
		await runtime.processAction(
			dropChild,
			() => runtime.state,
			rootSetState(runtime),
			() => "Root"
		);

		expect(seen).toEqual([
			5
		]);
		runtime.dispose();
	});
});
