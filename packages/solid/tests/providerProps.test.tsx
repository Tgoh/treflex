import type { JSX } from "solid-js";
import type { IActionGenerator, IEntity } from "treflex";
import { describe, expect, it } from "vitest";
import { createComponentFeature } from "../src/Context/createComponentFeature";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { useComponentState } from "../src/Hooks/useComponentState";

// The typed provider's compile-time contract, pinned through tsc: a
// `@ts-expect-error` with nothing to expect is itself TS2578, so a pin here
// cannot rot into a no-op. The runtime assertion only keeps the file in the
// suite; the pins are the `@ts-expect-error` lines, and `npm run typecheck`
// is the gate that reads them.

interface ICounter extends IEntity {
	Count: number;
}

function* increment(draft: ICounter): IActionGenerator {
	draft.Count++;
}

const Counter = createEntityFeature<ICounter>("tests/providerProps/Counter")({
	increment
});
const LocalCounter = createComponentFeature<ICounter>("tests/providerProps/LocalCounter")({
	increment
});

const factory = () => ({
	Count: 0
});
type ILabelProps = {
	label: string;
};

// A body that declares one prop of its own beside state.
const Labelled = Counter.provider((props: { state: ICounter; label: string }) => <span>{props.label}</span>);
// A body that declares nothing beyond state.
const Bare = Counter.provider(() => <span />);
// A body typed over `any`, which the provider reads as declaring nothing.
const AnyBody = Counter.provider((_props: any) => <span />);
// The ordinary body shapes the inference has to keep intact.
const Aliased = Counter.provider(
	(
		props: ILabelProps & {
			state: ICounter;
		}
	) => <span>{props.label}</span>
);
const Optional = Counter.provider((props: { state: ICounter; label?: string }) => <span>{props.label}</span>);
const WithChildren = Counter.provider((props: { state: ICounter; children?: JSX.Element }) => <span>{props.children}</span>);
const Generic = Counter.provider(<Q,>(props: { state: ICounter; items: Q[] }) => <span>{props.items.length}</span>);
// A component feature's body with one prop of its own; the provider mints state.
const LocalLabelled = LocalCounter.provider((props: { label: string }) => <span>{props.label}</span>, factory);
const LocalOptional = LocalCounter.provider((props: { label?: string }) => <span>{props.label}</span>, factory);
// The component feature's sibling of the any body.
const LocalAnyBody = LocalCounter.provider((_props: any) => <span />, factory);
// The same ordinary shapes, on the component feature's provider.
const LocalAliased = LocalCounter.provider((props: ILabelProps) => <span>{props.label}</span>, factory);
const LocalWithChildren = LocalCounter.provider((props: { children?: JSX.Element }) => <span>{props.children}</span>, factory);
const LocalGeneric = LocalCounter.provider(<Q,>(props: { items: Q[] }) => <span>{props.items.length}</span>, factory);

const counter: ICounter = {
	$Id: "c",
	Count: 0
};

// Each mount below sits inside a function nothing calls: a Solid component
// runs at element creation and these have no provider or DOM to run under.
// The pin is the element's type, which tsc checks without running anything.
const accepted = () => [
	<Labelled state={counter} label="x" />,
	<Bare state={counter} />,
	<LocalLabelled label="x" />,
	<AnyBody state={counter} />,
	<LocalAnyBody />,
	<Aliased state={counter} label="x" />,
	<Optional state={counter} />,
	<WithChildren state={counter}>
		<b />
	</WithChildren>,
	<Generic
		state={counter}
		items={[
			1
		]}
	/>,
	<LocalOptional />,
	<LocalAliased label="x" />,
	<LocalWithChildren>
		<b />
	</LocalWithChildren>,
	<LocalGeneric
		items={[
			1
		]}
	/>
];

const rejected = () => [
	// @ts-expect-error label is not a prop Bare's body declares
	<Bare state={counter} label="x" />,
	// @ts-expect-error label is required by Labelled's body
	<Labelled state={counter} />,
	// @ts-expect-error state is required
	<Labelled label="x" />,
	// @ts-expect-error LocalLabelled's body declares no state prop, and the provider mints it
	<LocalLabelled label="x" state={counter} />,
	// @ts-expect-error extra is not a prop LocalLabelled's body declares
	<LocalLabelled label="x" extra={1} />,
	// @ts-expect-error an any body still requires state at the mount site
	<AnyBody />,
	// @ts-expect-error an any body declares nothing, so extra is undeclared
	<AnyBody state={counter} extra={1} />,
	// @ts-expect-error a component feature's any body declares nothing, and the provider mints state
	<LocalAnyBody state={counter} />,
	// @ts-expect-error children are a prop like any other, and Bare's body declares none
	<Bare state={counter}>
		<b />
	</Bare>,
	// @ts-expect-error a mount site threads no setter: the provider dispatches on its state
	<Labelled state={counter} label="x" setState={() => {}} />
];

const noSetter = () => {
	const tree = Counter.use();
	const feature = LocalCounter.use();
	const local = useComponentState(factory);
	return [
		tree.state.Count,
		feature.state.Count,
		local.state.Count,
		// @ts-expect-error a tree feature changes through its actions only
		tree.setState,
		// @ts-expect-error a component feature changes through its actions only
		feature.setState,
		// @ts-expect-error component state changes through its actions only
		local.setState
	];
};

describe("typed provider props", () => {
	it("pins the mount-site contract through tsc", () => {
		// The functions are the pins; calling one would need a provider and
		// a DOM. Their presence in the suite is what keeps `npm run typecheck`
		// reading the @ts-expect-error lines above.
		expect(typeof accepted).toBe("function");
		expect(typeof rejected).toBe("function");
		expect(typeof noSetter).toBe("function");
	});
});
