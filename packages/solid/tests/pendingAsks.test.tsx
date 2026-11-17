import type { IActionGenerator, IAskEntry, IAskId, IEntity, ISelectorGenerator } from "treflex";
import { createEffect, createRoot, For } from "solid-js";
import { answer, ask, createRuntime, open, pendingAsks } from "treflex";
import { describe, expect, it } from "vitest";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { useComponentState } from "../src/Hooks/useComponentState";
import { pendingAsksOf } from "./treeWrite";

type IAnswer = "yes" | "no" | undefined;

interface IRow extends IEntity {
	Name: string;
}

interface IRoot extends IEntity {
	Result: string | null;
	Rows: IRow[];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function seed(): IRoot {
	return {
		$Id: "root",
		Result: null,
		Rows: [
			{
				$Id: "row",
				Name: "first"
			}
		]
	};
}

function* asksOnRow(draft: IRoot, path: string) {
	const answered = yield* open(
		ask<IAnswer>(draft.Rows[0]!, {
			Path: path
		})
	);
	draft.Result = String(answered);
}

function* answers(_owner: IEntity, id: IAskId<IAnswer>, value: IAnswer): IActionGenerator {
	yield* answer(id, value);
}

function* openAsks(draft: IRoot): ISelectorGenerator<readonly IAskEntry[]> {
	return yield* pendingAsks(draft);
}

describe("a Solid view rendering pendingAsks(...)", () => {
	it("reads asks through a feature's selector, keeps one entry object per ask under <For>, and its answer resumes the asker", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const Feature = createEntityFeature<IRoot>()(
			{},
			{
				openAsks
			}
		);
		const seen: (readonly string[])[] = [];
		const mounted: IAskEntry[] = [];
		let feature!: ReturnType<typeof Feature.use>;
		const dispose = createRoot((disposer) => {
			const View = Feature.provider(() => {
				feature = Feature.use();
				createEffect(() => {
					seen.push(
						feature.openAsks().map(
							(entry) =>
								(
									entry.Request as {
										Path: string;
									}
								).Path
						)
					);
				});
				return (
					<For each={feature.openAsks()}>
						{(entry) => {
							mounted.push(entry);
							return null;
						}}
					</For>
				);
			});
			TreflexProvider({
				value: runtime,
				get children() {
					return <View state={runtime.state} />;
				}
			});
			return disposer;
		});
		await settle();
		const first = runtime.dispatch(asksOnRow, "root", "Demo/A");
		await settle();
		const second = runtime.dispatch(asksOnRow, "root", "Demo/B");
		await settle();
		function* renames(draft: IRoot): IActionGenerator {
			draft.Rows[0]!.Name = "renamed";
		}
		await runtime.dispatch(renames, "root");
		await settle();

		const [a, b] = feature.openAsks();
		expect(mounted).toEqual([
			a,
			b
		]);
		await runtime.dispatch(answers, b!.OwnerId, b!.Id as IAskId<IAnswer>, "yes");
		await second;
		await settle();
		expect(mounted).toEqual([
			a,
			b
		]);
		await runtime.dispatch(answers, a!.OwnerId, a!.Id as IAskId<IAnswer>, "no");
		await first;
		await settle();
		dispose();

		expect(runtime.state.Result).toBe("no");
		expect(seen).toEqual([
			[],
			[
				"Demo/A"
			],
			[
				"Demo/A",
				"Demo/B"
			],
			[
				"Demo/A"
			],
			[]
		]);
	});

	it("answers from a provider mounted on the ask's owner", async () => {
		const runtime = createRuntime<IRoot>(seed());
		function* answersOnRow(_draft: IRow, id: IAskId<IAnswer>, value: IAnswer): IActionGenerator {
			yield* answer(id, value);
		}
		const Row = createEntityFeature<IRow>()({
			answersOnRow
		});
		const asking = runtime.dispatch(asksOnRow, "root", "Demo/Row");
		await settle();
		const [entry] = pendingAsksOf(runtime, runtime.state);
		let feature!: ReturnType<typeof Row.use>;
		const dispose = createRoot((disposer) => {
			const View = Row.provider(() => {
				feature = Row.use();
				return null;
			});
			TreflexProvider({
				value: runtime,
				get children() {
					return <View state={runtime.state.Rows.find((row) => row.$Id === entry!.OwnerId)!} />;
				}
			});
			return disposer;
		});
		await settle();

		await feature.answersOnRow(entry!.Id as IAskId<IAnswer>, "no");
		await asking;
		await settle();
		dispose();

		expect(runtime.state.Result).toBe("no");
		expect(pendingAsksOf(runtime, runtime.state)).toEqual([]);
	});
});

describe("an ask from component state", () => {
	function mountLocal(runtime: ReturnType<typeof createRuntime<IRoot>>) {
		let local!: ReturnType<typeof useComponentState<IEntity>>;
		const dispose = createRoot((disposer) => {
			const View = () => {
				local = useComponentState<IEntity>(() => ({}));
				return null;
			};
			TreflexProvider({
				value: runtime,
				get children() {
					return <View />;
				}
			});
			return disposer;
		});
		return {
			local: () => local,
			dispose
		};
	}

	it("holds, so a bare ask is refused, and one inside open(...) is listed under the entity it mounts under", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const { local, dispose } = mountLocal(runtime);
		await settle();
		await expect(
			local().dispatch(function* (draft): IActionGenerator<IAnswer> {
				return yield* ask<IAnswer>(draft, {
					Path: "Local"
				});
			})
		).rejects.toMatchObject({
			name: "AskRefusedError"
		});
		const asking = local().dispatch(function* (draft) {
			return yield* open(
				ask<IAnswer>(draft, {
					Path: "Local"
				})
			);
		});
		await settle();
		expect(pendingAsksOf(runtime, runtime.state).map((entry) => entry.OwnerId)).toEqual([
			local().id
		]);
		dispose();
		await expect(asking).resolves.toBeUndefined();
	});

	it("asks about a tree entity inside open(...), and takes the answer there", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const { local, dispose } = mountLocal(runtime);
		await settle();
		const asking = local().dispatch(function* () {
			return yield* open(
				ask<IAnswer>("row", {
					Path: "Local"
				})
			);
		});
		await settle();
		const [entry] = pendingAsksOf(runtime, runtime.state);
		await runtime.dispatch(answers, entry!.OwnerId, entry!.Id as IAskId<IAnswer>, "yes");
		await expect(asking).resolves.toBe("yes");
		dispose();
	});
});
