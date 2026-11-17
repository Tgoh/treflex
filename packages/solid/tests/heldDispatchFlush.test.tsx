import type { IActionGenerator, IEntity } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { createEffect, createRoot } from "solid-js";
import { createRuntime, StateAliasError } from "treflex";
import { describe, expect, it } from "vitest";

interface IRow extends IEntity {
	Name: string;
	Self?: unknown;
}

interface IWorld extends IEntity {
	Note: string;
	Rows: IRow[];
	Sel?: IRow;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A view effect on Note re-runs in the flush of the batch a slice writing Note ran in, and
// whatever it opens there is a frame the slice's held dispatches must not be handed to.
function world(inFlush: (runtime: IRuntimeInternal<IWorld>) => void) {
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Note: "x",
			Rows: [
				{
					$Id: "r1",
					Name: "one"
				},
				{
					$Id: "r2",
					Name: "two"
				}
			]
		},
		{
			onError: () => {}
		}
	) as IRuntimeInternal<IWorld>;
	const order: string[] = [];
	runtime.on("record", (record) => {
		if (record.Kind === "action:start") {
			order.push(`start ${record.Name}`);
		} else if (record.Kind === "step") {
			order.push(`step ${record.Changes.map((change) => change.Path.join(".")).join(",")}`);
		}
	});
	let armed = false;
	const dispose = createRoot((done) => {
		createEffect(() => {
			void runtime.state.Note;
			if (armed) {
				inFlush(runtime);
			}
		});
		return done;
	});
	armed = true;
	return {
		runtime,
		order,
		dispose: () => {
			dispose();
			runtime.dispose();
		}
	};
}

function* child(draft: IRow): IActionGenerator {
	draft.Name = "by child";
}

function* echo(draft: IRow): IActionGenerator {
	draft.Name = `${draft.Name}!`;
}

describe("a dispatch a slice holds, while the slice's batch flushes", () => {
	it("is dropped when the slice is refused, though the flush starts other work", async () => {
		const w = world((runtime) => {
			void runtime.dispatch(echo, "r1");
		});
		await expect(
			w.runtime.dispatch(function* parent(d: IWorld): IActionGenerator {
				d.Note = "y";
				void w.runtime.dispatch(child, "r2");
				d.Sel = d.Rows[0];
			}, "root")
		).rejects.toBeInstanceOf(StateAliasError);
		await tick();
		expect(w.order).not.toContain("start child");
		expect(w.runtime.state.Rows[1]!.Name).toBe("two");
		w.dispose();
	});

	it("starts after the passing slice's step, though the flush starts other work first", async () => {
		const w = world((runtime) => {
			void runtime.dispatch(echo, "r1");
		});
		await w.runtime.dispatch(function* parent(d: IWorld): IActionGenerator {
			d.Note = "y";
			void w.runtime.dispatch(child, "r2");
		}, "root");
		await tick();
		expect(w.order.indexOf("step Note")).toBeGreaterThan(-1);
		expect(w.order.indexOf("start child")).toBeGreaterThan(w.order.indexOf("step Note"));
		expect(w.runtime.state.Rows[1]!.Name).toBe("by child");
		w.dispose();
	});

	it("starts for a passing slice though a refused framework write is first in the flush", async () => {
		const w = world((runtime) => {
			try {
				runtime.get("runtime/writeGateway").exemptFrame(() => {
					runtime.resolveCell("r1")!.setState((row: IRow) => {
						row.Self = row;
					});
				});
			} catch {}
		});
		await w.runtime.dispatch(function* parent(d: IWorld): IActionGenerator {
			d.Note = "y";
			void w.runtime.dispatch(child, "r2");
		}, "root");
		await tick();
		expect(w.runtime.state.Rows[1]!.Name).toBe("by child");
		expect(w.runtime.state.Rows[0]!.Self).toBeUndefined();
		w.dispose();
	});
});
