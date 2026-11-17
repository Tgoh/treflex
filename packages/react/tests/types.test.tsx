import type { IActionGenerator, IEntity, ISelectorGenerator } from "treflex";
import type { IEntityRef, IEntityView } from "../src";
import { describe, expect, it } from "vitest";
import { createComponentFeature, createEntityFeature, useComponentState, useEntity } from "../src";

// Compile-time pins: `npm run typecheck` reads the @ts-expect-error lines.

interface IChild extends IEntity {
	Name: string;
}

interface IOther extends IEntity {
	Size: number;
}

interface IParent extends IEntity {
	Title: string;
	Children: IChild[];
	Favourite?: IChild;
	Meta: {
		Tags: string[];
		Owner: IChild;
	};
}

function* rename(draft: IChild, name: string): IActionGenerator {
	draft.Name = name;
}

function* firstChild(draft: IParent): ISelectorGenerator<IChild | undefined> {
	return draft.Children[0];
}

const Parent = createEntityFeature<IParent>()(
	{},
	{
		firstChild
	}
);
const Child = createEntityFeature<IChild>()({
	rename
});
const Other = createEntityFeature<IOther>()({});

const ChildView = Child.provider(() => null);
const OtherView = Other.provider(() => null);
const Labelled = Child.provider((props: { state: IEntityRef<IChild>; label: string }) => props.label);

function usePins(parent: IEntityView<IParent>) {
	const ref = parent.Children[0];
	// @ts-expect-error a ref holds the $Id and nothing else
	ref.Name;
	// @ts-expect-error a ref holds the $Id and nothing else
	parent.Favourite?.Name;
	// @ts-expect-error a ref nested in a plain object is a ref too
	parent.Meta.Owner.Name;
	parent.Meta.Tags.length;
	// @ts-expect-error views are read-only
	parent.Title = "x";

	const mounts = [
		<ChildView key="1" state={ref} />,
		// @ts-expect-error one entity type's ref does not mount another's provider
		<OtherView key="2" state={ref} />,
		<Labelled key="3" state={ref} label="ok" />,
		// @ts-expect-error a declared prop is required
		<Labelled key="4" state={ref} />,
		// @ts-expect-error an undeclared prop is refused
		<ChildView key="5" state={ref} extra={1} />
	];

	const child = useEntity<IChild>(ref.$Id);
	child?.Name.length;

	const first = Parent.use().firstChild();
	first?.Name.length;

	const views = child &&
		first && [
			<ChildView key="6" state={child} />,
			<ChildView key="7" state={first} />,
			// @ts-expect-error one entity type's view does not mount another's provider
			<OtherView key="8" state={child} />,
			// @ts-expect-error a selector's entity view does not mount another's provider
			<OtherView key="9" state={first} />,
			<OtherView
				key="10"
				state={{
					$Id: "unbranded"
				}}
			/>
		];

	const renamed: Promise<void> = Child.use().rename("y");
	// @ts-expect-error actions keep their parameter types
	Child.use().rename(1);

	return [
		mounts,
		views,
		renamed
	];
}

interface IPanel extends IEntity {
	Open: boolean;
	Owner?: IChild;
}

const Panel = createComponentFeature<IPanel>()({});
const PanelView = Panel.provider(
	(props: { label: string }) => props.label,
	() => ({
		Open: false
	})
);

function useFactoryPins() {
	const local = useComponentState(() => ({
		N: 0
	}));
	const id: string = local.state.$Id;
	const n: number = local.state.N;
	// @ts-expect-error the framework stamps a string
	const idAsNumber: number = local.state.$Id;
	// @ts-expect-error N keeps the factory's number
	const nAsString: string = local.state.N;
	// @ts-expect-error a factory takes no argument
	useComponentState((stamped: string) => ({
		$Id: stamped
	}));
	// @ts-expect-error component state changes through its actions only
	local.setState;
	return [
		id,
		n,
		idAsNumber,
		nAsString
	];
}

function useComponentPins() {
	const panel = Panel.use();
	panel.state.Owner?.$Id.length;
	// @ts-expect-error an entity nested in component state is a ref in its view
	panel.state.Owner?.Name;
	// @ts-expect-error component state views are read-only
	panel.state.Open = true;
	// @ts-expect-error a component feature changes through its actions only
	panel.setState;
	const ref: IEntityRef<IPanel> = {
		$Id: "x"
	};
	return [
		<PanelView key="1" label="ok" />,
		// @ts-expect-error a component feature's provider mints its own state
		<PanelView key="2" label="ok" state={ref} />
	];
}

describe("types", () => {
	it("are pinned at compile time", () => {
		expect(typeof usePins).toBe("function");
		expect(typeof useFactoryPins).toBe("function");
		expect(typeof useComponentPins).toBe("function");
	});
});
