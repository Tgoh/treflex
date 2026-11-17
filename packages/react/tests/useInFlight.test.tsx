import type { ReactNode } from "react";
import type { IActionGenerator, IEntity, IRuntime, ISelectorGenerator } from "treflex";
import type { IEntityRef } from "../src";
import { act, cleanup, render } from "@testing-library/react";
import { memo, StrictMode, useReducer } from "react";
import { createRuntime, inFlight, leading, workTag } from "treflex";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityFeature, TreflexProvider, useComponentState, useInFlight, useRoot } from "../src";

interface IRow extends IEntity {
	Name: string;
}

interface IRoot extends IEntity {
	Rows: IRow[];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const Busy = workTag("UseInFlightReact/Busy");

function* park(): IActionGenerator {
	yield {
		Type: "park"
	} as never;
}

function* save(_draft: IRoot): IActionGenerator {
	yield* park();
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

function* saving(draft: IRoot): ISelectorGenerator<boolean> {
	return yield* inFlight(save, draft);
}

const Feature = createEntityFeature<IRoot>()(
	{
		save,
		other,
		dropRow
	},
	{
		saving
	}
);

function world() {
	const runtime = createRuntime<IRoot>({
		$Id: "root",
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
	});
	const releases: (() => void)[] = [];
	runtime.registerImplementation("park", () => new Promise<void>((resolve) => releases.push(resolve)));
	return {
		runtime,
		releases
	};
}

function mount(node: ReactNode, runtime: IRuntime<any>) {
	return render(
		<StrictMode>
			<TreflexProvider value={runtime}>{node}</TreflexProvider>
		</StrictMode>
	);
}

async function during(work: () => Promise<unknown>, release: () => void) {
	let running!: Promise<unknown>;
	await act(async () => {
		running = work();
		await settle();
	});
	await act(async () => {
		release();
		await running;
		await settle();
	});
}

function changes<T>(log: T[]): T[] {
	return log.filter((line, at) => line !== log[at - 1]);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("useInFlight in React", () => {
	it("flips with a selector reading inFlight, per row by ref, and re-renders nothing for other work", async () => {
		const { runtime, releases } = world();
		const log: string[] = [];
		const Row = memo(function Row(props: { row: IEntityRef<IRow> }) {
			log.push(`${props.row.$Id} ${useInFlight(saveRow, props.row)}`);
			return null;
		});
		let feature!: ReturnType<typeof Feature.use>;
		const Body = Feature.provider(() => {
			feature = Feature.use();
			const busy = useInFlight(save, feature.state);
			log.push(`root ${busy} ${feature.saving()}`);
			return (
				<>
					{feature.state.Rows.map((row) => (
						<Row key={row.$Id} row={row} />
					))}
				</>
			);
		});
		function App() {
			return <Body state={useRoot<IRoot>()} />;
		}
		mount(<App />, runtime);
		await act(settle);
		log.length = 0;
		await during(
			() => feature.save(),
			() => releases[0]!()
		);
		await during(
			() => runtime.dispatch(saveRow, "r2"),
			() => releases[1]!()
		);
		const beforeOther = log.length;
		await during(
			() => feature.other(),
			() => releases[2]!()
		);
		expect(changes(log.slice(0, beforeOther))).toEqual([
			"root true true",
			"root false false",
			"r2 true",
			"r2 false"
		]);
		expect(log.length).toBe(beforeOther);
	});

	it("reads a work tag, a list literal, an id and a hand-written ref, and undefined as false", async () => {
		const { runtime, releases } = world();
		const log: string[] = [];
		let feature!: ReturnType<typeof Feature.use>;
		const Body = Feature.provider(() => {
			feature = Feature.use();
			const tag = useInFlight(Busy, "root");
			const list = useInFlight(
				[
					save,
					Busy
				],
				{
					$Id: "root"
				}
			);
			const none = useInFlight(Busy, undefined);
			log.push(`${tag} ${list} ${none}`);
			return null;
		});
		function App() {
			return <Body state={useRoot<IRoot>()} />;
		}
		mount(<App />, runtime);
		await during(
			() => feature.other(),
			() => releases[0]!()
		);
		expect(changes(log)).toEqual([
			"false false false",
			"true true false",
			"false false false"
		]);
	});

	it("keeps its watch across renders that pass a new list with the same items", async () => {
		const { runtime } = world();
		const held = [
			save,
			Busy
		] as const;
		const reads = vi.spyOn(runtime, "processSelector");
		let rerender!: () => void;
		function Literal() {
			[, rerender] = useReducer((n: number) => n + 1, 0);
			useInFlight(
				[
					save,
					Busy
				],
				"root"
			);
			return null;
		}
		function Held() {
			[, rerender] = useReducer((n: number) => n + 1, 0);
			useInFlight(held, "root");
			return null;
		}
		const count = async (Component: () => null) => {
			const view = mount(<Component />, runtime);
			reads.mockClear();
			for (let at = 0; at < 5; at++) {
				await act(async () => rerender());
			}
			view.unmount();
			return reads.mock.calls.length;
		};
		expect(await count(Literal)).toBe(await count(Held));
	});

	it("reads component state from its first render, before it is seated", async () => {
		const { runtime, releases } = world();
		const log: string[] = [];
		let local!: ReturnType<typeof useComponentState<IRow>>;
		function Local() {
			local = useComponentState<IRow>(() => ({
				Name: "local"
			}));
			log.push(`local ${useInFlight(saveRow, local.state)}`);
			return null;
		}
		mount(<Local />, runtime);
		await during(
			() => local.dispatch(saveRow),
			() => releases[0]!()
		);
		expect(changes(log)).toEqual([
			"local false",
			"local true",
			"local false"
		]);
	});

	it("reads false once a row leaves, without reading it", async () => {
		const { runtime, releases } = world();
		const log: boolean[] = [];
		let feature!: ReturnType<typeof Feature.use>;
		const Body = Feature.provider(() => {
			feature = Feature.use();
			log.push(useInFlight(saveRow, "r1"));
			return null;
		});
		function App() {
			return <Body state={useRoot<IRoot>()} />;
		}
		mount(<App />, runtime);
		const stopped = runtime.dispatch(saveRow, "r1").catch(() => undefined);
		await act(settle);
		const reads = vi.spyOn(runtime, "processSelector");
		await act(async () => {
			await feature.dropRow("r1");
			await stopped;
			await settle();
		});
		releases[0]!();
		expect(reads).not.toHaveBeenCalled();
		expect(changes(log)).toEqual([
			false,
			true,
			false
		]);
	});

	it("needs a TreflexProvider", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		function Orphan() {
			useInFlight(save, "root");
			return null;
		}
		expect(() => render(<Orphan />)).toThrow("[treflex-react] useInFlight called outside a TreflexProvider.");
	});
});
