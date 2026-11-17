import type { JSX } from "solid-js";
import type { IActionGenerator, IEntity, IRuntime, ISelectorGenerator } from "treflex";
import { createEffect, createRoot, createSignal, For, Show } from "solid-js";
import { createRuntime, createTestRuntime, entity, inFlight, leading, workTag } from "treflex";
import { describe, expect, it, vi } from "vitest";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { useComponentState } from "../src/Hooks/useComponentState";
import { useInFlight } from "../src/Hooks/useInFlight";
import { unhandledDuring } from "./unhandledDuring";

interface IRow extends IEntity {
	Name: string;
}

interface IRoot extends IEntity {
	Note: string;
	Rows: IRow[];
	Open?: IRow | undefined;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const Busy = workTag("UseInFlight/Busy");

function* park(): IActionGenerator {
	yield {
		Type: "park"
	} as never;
}

function* save(draft: IRoot): IActionGenerator {
	yield* park();
	draft.Note = "saved";
}
leading(save);

function* other(_draft: IRoot): IActionGenerator {
	yield* park();
}
Busy.mark(other);

function* saveRow(draft: IRow): IActionGenerator {
	yield* park();
	draft.Name += "!";
}

function* dropRow(draft: IRoot, id: string): IActionGenerator {
	draft.Rows = draft.Rows.filter((row) => row.$Id !== id);
}

function* addRow(draft: IRoot, name: string): IActionGenerator {
	draft.Rows.push(
		yield* entity({
			Name: name
		})
	);
}

function* putBack(draft: IRoot, row: IRow): IActionGenerator {
	draft.Rows.push(row);
}

function* replaceOpen(draft: IRoot, name: string): IActionGenerator {
	draft.Open = yield* entity({
		Name: name
	});
}

function* saving(draft: IRoot): ISelectorGenerator<boolean> {
	return yield* inFlight(save, draft);
}

const Feature = createEntityFeature<IRoot>()(
	{
		save,
		other,
		addRow,
		dropRow,
		putBack,
		replaceOpen
	},
	{
		saving
	}
);

function world(id = "root") {
	const runtime = createRuntime<IRoot>({
		$Id: id,
		Note: "",
		Rows: [
			{
				$Id: `${id}-r1`,
				Name: "one"
			},
			{
				$Id: `${id}-r2`,
				Name: "two"
			}
		],
		Open: {
			$Id: `${id}-o1`,
			Name: "open"
		}
	});
	const releases: (() => void)[] = [];
	runtime.registerImplementation("park", () => new Promise<void>((resolve) => releases.push(resolve)));
	return {
		runtime,
		releases
	};
}

function mount(runtime: IRuntime<IRoot>, body: () => JSX.Element) {
	return createRoot((dispose) => {
		const View = Feature.provider(body);
		TreflexProvider({
			value: runtime,
			get children() {
				return <View state={runtime.state} />;
			}
		});
		return dispose;
	});
}

describe("useInFlight", () => {
	it("flips in the same flush as a selector reading inFlight, and ignores other work", async () => {
		const { runtime, releases } = world();
		let feature!: ReturnType<typeof Feature.use>;
		const seen: string[] = [];
		const dispose = mount(runtime, () => {
			feature = Feature.use();
			const busy = useInFlight(save, () => feature.state);
			createEffect(() => seen.push(`hook ${busy()}`));
			createEffect(() => seen.push(`selector ${feature.saving()}`));
			return null;
		});
		const running = feature.other();
		await settle();
		const first = feature.save();
		await settle();
		releases[0]!();
		await running;
		await settle();
		releases[1]!();
		await first;
		await settle();
		dispose();
		expect(seen).toEqual([
			"hook false",
			"selector false",
			"hook true",
			"selector true",
			"hook false",
			"selector false"
		]);
	});

	it("turns true a microtask after the dispatch, so a repeat in the same turn is leading's to drop", async () => {
		const { runtime, releases } = world();
		let feature!: ReturnType<typeof Feature.use>;
		let busy!: () => boolean;
		const dispose = mount(runtime, () => {
			feature = Feature.use();
			busy = useInFlight(save, () => feature.state);
			createEffect(() => busy());
			return null;
		});
		const guarded = () => (busy() ? undefined : feature.save());
		const first = guarded();
		const second = guarded();
		expect(busy()).toBe(false);
		await settle();
		expect(busy()).toBe(true);
		expect(releases).toHaveLength(1);
		releases[0]!();
		await Promise.all([
			first,
			second
		]);
		dispose();
	});

	it("reads a work tag and a list", async () => {
		const { runtime, releases } = world();
		let feature!: ReturnType<typeof Feature.use>;
		const tag: boolean[] = [];
		const list: boolean[] = [];
		const dispose = mount(runtime, () => {
			feature = Feature.use();
			const tagged = useInFlight(Busy, () => feature.state);
			const either = useInFlight(
				[
					save,
					Busy
				],
				() => feature.state
			);
			createEffect(() => tag.push(tagged()));
			createEffect(() => list.push(either()));
			return null;
		});
		const running = feature.other();
		await settle();
		releases[0]!();
		await running;
		await settle();
		dispose();
		expect(tag).toEqual([
			false,
			true,
			false
		]);
		expect(list).toEqual([
			false,
			true,
			false
		]);
	});

	it("reads each row under <For> with no row feature", async () => {
		const { runtime, releases } = world();
		const seen: Record<string, boolean[]> = {};
		const dispose = mount(runtime, () => {
			const feature = Feature.use();
			return (
				<For each={feature.state.Rows}>
					{(row) => {
						const busy = useInFlight(saveRow, row);
						seen[row.$Id] = [];
						createEffect(() => seen[row.$Id]!.push(busy()));
						return null;
					}}
				</For>
			);
		});
		const running = runtime.dispatch(saveRow, "root-r2");
		await settle();
		releases[0]!();
		await running;
		await settle();
		dispose();
		expect(seen).toEqual({
			"root-r1": [
				false
			],
			"root-r2": [
				false,
				true,
				false
			]
		});
	});

	it("follows an accessor to a replacement node and to undefined", async () => {
		const { runtime, releases } = world();
		const [open, setOpen] = createSignal(true);
		let feature!: ReturnType<typeof Feature.use>;
		const seen: boolean[] = [];
		const dispose = mount(runtime, () => {
			feature = Feature.use();
			const busy = useInFlight(saveRow, () => (open() ? feature.state.Open : undefined));
			createEffect(() => seen.push(busy()));
			return null;
		});
		const stopped = runtime.dispatch(saveRow, "root-o1").catch(() => undefined);
		await settle();
		await feature.replaceOpen("next");
		await settle();
		const running = runtime.dispatch(saveRow, runtime.state.Open!.$Id);
		await settle();
		setOpen(false);
		await settle();
		releases[1]!();
		await running;
		await stopped;
		dispose();
		expect(seen).toEqual([
			false,
			true,
			false,
			true,
			false
		]);
	});

	it("reads false on a held row once it leaves, and its work again once it is put back", async () => {
		const { runtime, releases } = world();
		let feature!: ReturnType<typeof Feature.use>;
		let row!: IRow;
		const seen: boolean[] = [];
		const [ready, setReady] = createSignal(false);
		function Held() {
			row = feature.state.Rows[2]!;
			const busy = useInFlight(saveRow, row);
			createEffect(() => seen.push(busy()));
			return null;
		}
		const dispose = mount(runtime, () => {
			feature = Feature.use();
			return (
				<Show when={ready()}>
					<Held />
				</Show>
			);
		});
		await feature.addRow("minted");
		setReady(true);
		const id = row.$Id;
		const stopped = runtime.dispatch(saveRow, id).catch(() => undefined);
		await settle();
		await feature.dropRow(id);
		await stopped;
		await settle();
		await feature.putBack(row);
		await settle();
		const running = runtime.dispatch(saveRow, id);
		await settle();
		releases[1]!();
		await running;
		await settle();
		dispose();
		expect(seen).toEqual([
			false,
			true,
			false,
			true,
			false
		]);
	});

	it("reads another runtime's node against that runtime's work", async () => {
		const here = world("here");
		const there = world("there");
		const seen: boolean[] = [];
		const dispose = mount(here.runtime, () => {
			const busy = useInFlight(saveRow, there.runtime.state.Rows[0]);
			createEffect(() => seen.push(busy()));
			return null;
		});
		const running = there.runtime.dispatch(saveRow, "there-r1");
		await settle();
		there.releases[0]!();
		await running;
		await settle();
		dispose();
		expect(seen).toEqual([
			false,
			true,
			false
		]);
	});

	it("reads a component state node", async () => {
		const { runtime, releases } = world();
		let local!: ReturnType<typeof useComponentState<IRow>>;
		const seen: boolean[] = [];
		const dispose = mount(runtime, () => {
			local = useComponentState<IRow>(() => ({
				Name: "local"
			}));
			const busy = useInFlight(saveRow, () => local.state);
			createEffect(() => seen.push(busy()));
			return null;
		});
		const running = local.dispatch(saveRow);
		await settle();
		releases[0]!();
		await running;
		await settle();
		dispose();
		expect(seen).toEqual([
			false,
			true,
			false
		]);
	});

	it("answers the test runtime's inFlight stub", () => {
		const runtime = createTestRuntime<IRoot>(
			{
				$Id: "root",
				Note: "",
				Rows: []
			},
			{},
			{
				inFlight: (ownerId) =>
					ownerId === "root"
						? [
								save
							]
						: undefined
			}
		);
		let busy!: () => boolean;
		const dispose = mount(runtime, () => {
			const feature = Feature.use();
			busy = useInFlight(save, () => feature.state);
			return null;
		});
		expect(busy()).toBe(true);
		dispose();
	});

	it("leaves no memo behind once its component unmounts", async () => {
		const { runtime, releases } = world();
		for (let at = 0; at < 50; at++) {
			createRoot((dispose) => {
				TreflexProvider({
					value: runtime,
					get children() {
						const busy = useInFlight(save, runtime.state);
						createEffect(() => busy());
						return null;
					}
				});
				return dispose;
			})();
		}
		const reads = vi.spyOn(runtime, "processSelector");
		const running = runtime.dispatch(save, "root");
		await settle();
		releases[0]!();
		await running;
		await settle();
		expect(reads).not.toHaveBeenCalled();
	});

	it("refuses a plain copy, naming the hook", async () => {
		const { runtime } = world();
		const heard = await unhandledDuring(() =>
			mount(runtime, () => {
				const copy: IRow = {
					$Id: "root-r1",
					Name: "copy"
				};
				useInFlight(saveRow, copy);
				return null;
			})
		);
		expect(heard).toHaveLength(1);
		expect(String(heard[0])).toContain("useInFlight(): the owner is a plain object");
	});

	it("needs a TreflexProvider", () => {
		const { runtime } = world();
		expect(() => createRoot(() => useInFlight(save, runtime.state))).toThrow("[treflex] useInFlight called outside a TreflexProvider.");
	});
});
