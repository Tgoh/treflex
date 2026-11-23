import type { IActionGenerator, IEntity, ISelectorGenerator } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { createEffect, createRoot, flush } from "solid-js";
import { createRuntime, inFlight, leading, transient } from "treflex";
import { describe, expect, it } from "vitest";
import { createComponentFeature } from "../src/Context/createComponentFeature";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { useComponentState } from "../src/Hooks/useComponentState";
import { mount } from "./mount";
import { minted } from "./treeWrite";

interface IRow extends IEntity {
	Text: string;
}

interface IRoot extends IEntity {
	Note: string;
}

const loading = (owner: IEntity) =>
	transient(owner, "View/Load", {
		Count: 0,
		Rows: [] as IRow[]
	});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function world() {
	const runtime = createRuntime<IRoot>({
		$Id: "root",
		Note: ""
	});
	const releases: (() => void)[] = [];
	runtime.registerImplementation(
		"park",
		() =>
			new Promise<void>((resolve) => {
				releases.push(resolve);
			})
	);
	return {
		runtime,
		releases
	};
}

function* load(draft: IEntity): IActionGenerator {
	const s = yield* loading(draft);
	s.Count++;
	try {
		yield {
			Type: "park"
		};
	} finally {
		s.Count--;
	}
}

function* count(draft: IEntity): ISelectorGenerator<number> {
	return (yield* loading(draft)).Count;
}

function* firstRow(draft: IEntity): ISelectorGenerator<IRow | undefined> {
	return (yield* loading(draft)).Rows[0];
}

describe("a transient on component state", () => {
	it("is written from a component action's draft, as on any entity", async () => {
		const { runtime } = world();
		let dispatch!: ReturnType<typeof useComponentState<IEntity>>["dispatch"];
		const View = () => {
			dispatch = useComponentState<IEntity>(() => ({})).dispatch;
			return null;
		};
		const { dispose } = mount(() => (
			<TreflexProvider value={runtime}>
				<View />
			</TreflexProvider>
		));
		let count = -1;
		await dispatch(function* (draft): IActionGenerator {
			const node = yield* loading(draft);
			node.Count++;
			count = node.Count;
		});
		expect(count).toBe(1);
		dispose();
	});
});

describe("a leading action on component state", () => {
	interface ILocal extends IEntity {
		Log: string[];
	}

	const once = leading(function* noteOnce(draft: ILocal, text: string): IActionGenerator<string> {
		draft.Log.push(`once:${text}`);
		yield {
			Type: "park"
		};
		return text;
	});

	function* busy(draft: ILocal): ISelectorGenerator<boolean> {
		return yield* inFlight(once, draft);
	}

	const Local = createComponentFeature<ILocal>("tests/slots/LocalLeading")(
		{},
		{
			busy
		}
	);

	function mountLocal(runtime: ReturnType<typeof world>["runtime"]) {
		let local!: ReturnType<typeof useComponentState<ILocal>>;
		let feature!: ReturnType<typeof Local.use>;
		const View = () => {
			local = useComponentState<ILocal>(() => ({
				Log: []
			}));
			return null;
		};
		const Body = Local.provider(
			() => {
				feature = Local.use();
				return null;
			},
			() => ({
				Log: []
			})
		);
		const { dispose } = mount(() => (
			<TreflexProvider value={runtime}>
				<View />
				<Body />
			</TreflexProvider>
		));
		return {
			local,
			feature,
			dispose
		};
	}

	it("drops a repeat", async () => {
		const { runtime, releases } = world();
		const { local, dispose } = mountLocal(runtime);
		const first = local.dispatch(once, "a");
		await expect(local.dispatch(once, "b")).resolves.toBeUndefined();
		await settle();
		expect(local.state.Log).toEqual([
			"once:a"
		]);
		for (const release of releases) {
			release();
		}
		await expect(first).resolves.toBe("a");
		dispose();
	});

	it("reads inFlight from processSelector and from a component feature's selector a view calls", async () => {
		const { runtime, releases } = world();
		const { local, feature, dispose } = mountLocal(runtime);
		const seen: boolean[] = [];
		const disposeView = createRoot((disposer) => {
			createEffect(
				() => feature.busy(),
				(busy) => {
					seen.push(busy);
				}
			);
			return disposer;
		});
		flush();
		expect(runtime.processSelector(busy, () => local.state)).toBe(false);
		const first = feature.state.$Id;
		void runtime.dispatch(once, first, "a");
		expect(runtime.processSelector(busy, () => feature.state)).toBe(true);
		expect(runtime.processSelector(busy, () => local.state)).toBe(false);
		await settle();
		expect(seen).toEqual([
			false,
			true
		]);
		for (const release of releases) {
			release();
		}
		await settle();
		expect(seen).toEqual([
			false,
			true,
			false
		]);
		disposeView();
		dispose();
	});
});

describe("a leading action in a Solid view", () => {
	it("drops a second press through the feature, and a read of it gates the button", async () => {
		const { runtime, releases } = world();
		const saveNote = leading(function* writeNote(draft: IRoot, note: string): IActionGenerator<string> {
			draft.Note = note;
			yield {
				Type: "park"
			};
			return note;
		});
		function* saving(draft: IRoot): ISelectorGenerator<boolean> {
			return yield* inFlight(saveNote, draft);
		}
		const Feature = createEntityFeature<IRoot>()(
			{
				saveNote
			},
			{
				saving
			}
		);
		let feature!: ReturnType<typeof Feature.use>;
		const seen: boolean[] = [];
		const View = Feature.provider(() => {
			feature = Feature.use();
			createEffect(
				() => feature.saving(),
				(saving) => {
					seen.push(saving);
				}
			);
			return null;
		});
		const { dispose } = mount(() => (
			<TreflexProvider value={runtime}>
				<View state={runtime.state} />
			</TreflexProvider>
		));
		await settle();
		const first = feature.saveNote("one");
		await expect(feature.saveNote("two")).resolves.toBeUndefined();
		expect(runtime.state.Note).toBe("one");
		releases[0]();
		await expect(first).resolves.toBe("one");
		await settle();
		dispose();
		expect(seen).toEqual([
			false,
			true,
			false
		]);
	});
});

describe("a transient in a Solid view", () => {
	it("reacts to a selector, up from the unborn default and back down", async () => {
		const { runtime, releases } = world();
		const Feature = createEntityFeature<IRoot>()(
			{
				load
			},
			{
				count
			}
		);
		const seen: number[] = [];
		const View = Feature.provider(() => {
			const feature = Feature.use();
			createEffect(
				() => feature.count(),
				(n) => {
					seen.push(n);
				}
			);
			return null;
		});
		const { dispose } = mount(() => (
			<TreflexProvider value={runtime}>
				<View state={runtime.state} />
			</TreflexProvider>
		));
		await settle();
		const done = runtime.dispatch(load, "root");
		await settle();
		releases[0]();
		await done;
		await settle();
		dispose();
		expect(seen).toEqual([
			0,
			1,
			0
		]);
	});

	it("reads the whole transient through a selector, and the view it gets reacts once born", async () => {
		const { runtime, releases } = world();
		function* whole(draft: IRoot): ISelectorGenerator<{
			Count: number;
		}> {
			return yield* loading(draft);
		}
		const Feature = createEntityFeature<IRoot>()(
			{},
			{
				whole
			}
		);
		const seen: number[] = [];
		const View = Feature.provider(() => {
			const feature = Feature.use();
			createEffect(
				() => feature.whole().Count,
				(n) => {
					seen.push(n);
				}
			);
			return null;
		});
		const { dispose } = mount(() => (
			<TreflexProvider value={runtime}>
				<View state={runtime.state} />
			</TreflexProvider>
		));
		await settle();
		const done = runtime.dispatch(load, "root");
		await settle();
		releases[0]();
		await done;
		await settle();
		dispose();
		expect(seen).toEqual([
			0,
			1,
			0
		]);
	});

	it("reads by id with no entity feature, through a selector over the entity's view, and an owner that goes reads as unwritten", async () => {
		const runtime = createRuntime<
			IEntity & {
				Kids: IEntity[];
			}
		>({
			$Id: "root",
			Kids: [
				{
					$Id: "kid"
				}
			]
		}) as IRuntimeInternal<
			IEntity & {
				Kids: IEntity[];
			}
		>;
		await runtime.dispatch(function* (draft: IEntity): IActionGenerator {
			(yield* loading(draft)).Count = 3;
		}, "kid");
		const lookup = runtime.get("runtime/stateIdLookup");
		const seen: number[] = [];
		const dispose = createRoot((disposer) => {
			createEffect(
				() => {
					const owner = lookup().kid?.state as IEntity | undefined;
					return owner ? runtime.processSelector(count, () => owner) : 0;
				},
				(n) => {
					seen.push(n);
				}
			);
			return disposer;
		});
		await settle();
		await runtime.dispatch(function* (draft: { Kids: IEntity[] }): IActionGenerator {
			draft.Kids = [];
		}, "root");
		await settle();
		dispose();
		expect(seen).toEqual([
			3,
			0
		]);
	});

	it("mounts a transient entity through a feature provider, whose actions write it and resolve its setter", async () => {
		const { runtime } = world();
		await runtime.dispatch(function* (draft: IRoot): IActionGenerator {
			(yield* loading(draft)).Rows.push(
				minted("in-transient", {
					Text: "first"
				})
			);
		}, "root");
		function* rename(draft: IRow, text: string): IActionGenerator {
			draft.Text = text;
		}
		const Row = createEntityFeature<IRow>()({
			rename
		});
		let feature!: ReturnType<typeof Row.use>;
		const seen: string[] = [];
		const View = Row.provider(() => {
			feature = Row.use();
			createEffect(
				() => feature.state.Text,
				(text) => {
					seen.push(text);
				}
			);
			return null;
		});
		const { dispose } = mount(() => (
			<TreflexProvider value={runtime}>
				<View state={runtime.processSelector(firstRow, () => runtime.state) as IRow} />
			</TreflexProvider>
		));
		await settle();
		await feature.rename("second");
		await settle();
		dispose();
		expect(seen).toEqual([
			"first",
			"second"
		]);
		expect(runtime.processSelector(firstRow, () => runtime.state)?.Text).toBe("second");
	});
});
