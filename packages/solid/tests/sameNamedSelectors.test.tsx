import type { Accessor } from "solid-js";
import type { IActionGenerator, IEntity, ISelectorGenerator } from "treflex";
import { createMemo } from "solid-js";
import { createRuntime } from "treflex";
import { describe, expect, it } from "vitest";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { mount } from "./mount";

interface IDoc extends IEntity {
	N: number;
}

function* bump(draft: IDoc): IActionGenerator {
	draft.N++;
}

function featureOverDoc(id: string, prefix: string) {
	return createEntityFeature<IDoc>(id)(
		{
			bump
		},
		{
			*label(state: IDoc): ISelectorGenerator<string> {
				return `${prefix}:${state.N}`;
			}
		}
	);
}

function mountReader(
	runtime: {
		state: IDoc;
	},
	host: unknown,
	feature: ReturnType<typeof featureOverDoc>
) {
	let label!: Accessor<string>;
	let dispatchBump!: () => Promise<unknown>;
	const Inner = (): null => {
		const context = feature.use();
		label = createMemo(() => context.label());
		dispatchBump = () => context.bump();
		label();
		return null;
	};
	const Wrapped = feature.provider(Inner);
	const { dispose } = mount(() => (
		<TreflexProvider value={host as any}>
			<Wrapped state={runtime.state} />
		</TreflexProvider>
	));
	return {
		label: () => label(),
		bump: () => dispatchBump(),
		dispose
	};
}

describe("two contexts on one entity with a same-named selector", () => {
	it("keep separate memos, so neither reader freezes when the other reads", async () => {
		const runtime = createRuntime<IDoc>({
			$Id: "doc",
			N: 0
		});
		const first = mountReader(runtime, runtime, featureOverDoc("test/SameNamed/First", "first"));
		const second = mountReader(runtime, runtime, featureOverDoc("test/SameNamed/Second", "second"));
		expect(first.label()).toBe("first:0");
		expect(second.label()).toBe("second:0");

		await first.bump();

		expect(first.label()).toBe("first:1");
		expect(second.label()).toBe("second:1");

		await second.bump();

		expect(first.label()).toBe("first:2");
		expect(second.label()).toBe("second:2");

		first.dispose();
		second.dispose();
		runtime.dispose();
	});

	it("keep separate memos for anonymous contexts too", async () => {
		const runtime = createRuntime<IDoc>({
			$Id: "doc",
			N: 0
		});
		const anonymous = () =>
			createEntityFeature<IDoc>()(
				{
					bump
				},
				{
					*label(state: IDoc): ISelectorGenerator<string> {
						return `anonymous:${state.N}`;
					}
				}
			);
		const first = mountReader(runtime, runtime, anonymous() as ReturnType<typeof featureOverDoc>);
		const second = mountReader(runtime, runtime, anonymous() as ReturnType<typeof featureOverDoc>);

		await first.bump();

		expect(first.label()).toBe("anonymous:1");
		expect(second.label()).toBe("anonymous:1");

		first.dispose();
		second.dispose();
		runtime.dispose();
	});

	it("a re-evaluated module with the same id keeps its memo slot, and the new selector takes it", async () => {
		const runtime = createRuntime<IDoc>({
			$Id: "doc",
			N: 0
		});
		const id = "test/SameNamed/Reloaded";
		const before = featureOverDoc(id, "before");
		const reader = mountReader(runtime, runtime, before);
		expect(reader.label()).toBe("before:0");

		featureOverDoc(id, "after");
		await reader.bump();

		expect(reader.label()).toBe("after:1");

		reader.dispose();
		runtime.dispose();
	});
});
