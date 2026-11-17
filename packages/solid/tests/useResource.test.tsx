import type { IActionGenerator, IEntity, IResourceContext, IRuntimeEventOf } from "treflex";
import type { IUseResource } from "../src/Hooks/useResource";
import { createEffect, createRoot, createSignal } from "solid-js";
import { closeResource, createRuntime, openResource } from "treflex";
import { describe, expect, it } from "vitest";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { useResource } from "../src/Hooks/useResource";

// useResource is a view's one door to a resource: a reactive value and
// status, and supply. No DOM: the component returns null.

declare module "treflex" {
	interface IResourceTypeRegistry {
		"view/preview": {
			Value: string;
			Supply: readonly string[];
			SupplyResponse: number;
		};
		"view/owned": {
			Value: string;
			Supply: readonly string[];
			SupplyResponse: string;
		};
	}
	interface IResourceRegistry {
		"View/Preview": {
			Type: "view/preview";
		};
		"View/Owned": {
			Type: "view/owned";
		};
	}
}

type IItem = {
	$Id: string;
};

type IRoot = {
	$Id: string;
	Items: IItem[];
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function* open(draft: IEntity): IActionGenerator {
	yield* openResource(draft, "View/Preview", {
		Type: "view/preview"
	});
}

function* close(draft: IEntity): IActionGenerator {
	yield* closeResource(draft, "View/Preview");
}

function* openOwned(draft: IEntity): IActionGenerator {
	yield* openResource(draft, "View/Owned", {
		Type: "view/owned"
	});
}

// Two items, each able to hold a "View/Owned" resource that exposes and
// answers with its owner's id, and every diag the runtime raises.
function world() {
	const runtime = createRuntime<IRoot>({
		$Id: "root",
		Items: [
			{
				$Id: "a"
			},
			{
				$Id: "b"
			}
		]
	});
	runtime.registerResourceType("view/owned", (_params, r) => {
		r.expose(`blob:${r.ownerId}`);
		r.onSupply((files) => `${r.ownerId}:${files.length}`);
	});
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (d) => diags.push(d));
	return {
		runtime,
		diags,
		a: runtime.state.Items[0]!,
		b: runtime.state.Items[1]!
	};
}

// Mounts a view over `useResource(owner, "View/Owned")`, recording each
// status and value it renders.
function mount(runtime: ReturnType<typeof world>["runtime"], owner: Parameters<typeof useResource>[0]) {
	let bound!: IUseResource<"View/Owned">;
	const seen: string[] = [];
	const dispose = createRoot((disposer) => {
		const View = (): null => {
			bound = useResource(owner, "View/Owned");
			createEffect(() => {
				seen.push(`${bound.status().State}:${bound.value() ?? "-"}`);
			});
			return null;
		};
		void (
			<TreflexProvider value={runtime}>
				<View />
			</TreflexProvider>
		);
		return disposer;
	});
	return {
		bound: () => bound,
		seen,
		dispose
	};
}

describe("useResource", () => {
	it("tracks the exposed value and the status, and supplies through the drain", async () => {
		const runtime = createRuntime<IRoot>({
			$Id: "root",
			Items: []
		});
		let ctx!: IResourceContext<"view/preview">;
		runtime.registerResourceType("view/preview", (_params, r) => {
			ctx = r;
			r.onSupply((files) => files.length);
		});
		let bound!: IUseResource<"View/Preview">;
		const seen: string[] = [];
		const dispose = createRoot((disposer) => {
			const View = (): null => {
				bound = useResource(runtime.state, "View/Preview");
				createEffect(() => {
					seen.push(`${bound.status().State}:${bound.value() ?? "-"}`);
				});
				return null;
			};
			void (
				<TreflexProvider value={runtime}>
					<View />
				</TreflexProvider>
			);
			return disposer;
		});
		await settle();
		await runtime.dispatch(open, "root");
		ctx.expose("blob:1");
		await settle();
		expect(
			await bound.supply([
				"a",
				"b"
			])
		).toBe(2);
		await runtime.dispatch(close, "root");
		await settle();
		expect(seen[0]).toBe("none:-");
		expect(seen).toContain("live:blob:1");
		expect(seen.at(-1)).toBe("none:-");
		dispose();
		runtime.dispose();
	});

	it("reads a plain entity's $Id once", async () => {
		const { runtime } = world();
		const owner = {
			$Id: "a"
		};
		const view = mount(runtime, owner);
		owner.$Id = "b";
		await runtime.dispatch(openOwned, "a");
		await settle();
		expect(view.seen.at(-1)).toBe("live:blob:a");
		expect(
			await view.bound().supply([
				"x"
			])
		).toBe("a:1");
		view.dispose();
		runtime.dispose();
	});

	it("takes an id string", async () => {
		const { runtime } = world();
		const view = mount(runtime, "b");
		await runtime.dispatch(openOwned, "b");
		await settle();
		expect(view.seen[0]).toBe("none:-");
		expect(view.seen.at(-1)).toBe("live:blob:b");
		expect(
			await view.bound().supply([
				"x",
				"y"
			])
		).toBe("b:2");
		view.dispose();
		runtime.dispose();
	});

	it("reads none while an accessor returns undefined, then follows the owner it returns", async () => {
		const { runtime, diags, a } = world();
		await runtime.dispatch(openOwned, "a");
		const [owner, setOwner] = createSignal<IEntity | undefined>();
		const view = mount(runtime, owner);
		await settle();
		expect(view.seen).toEqual([
			"none:-"
		]);
		expect(
			await view.bound().supply([
				"x"
			])
		).toBeUndefined();
		expect(diags.filter((d) => d.code === "resource/supply-dropped").map((d) => d.data?.reason)).toEqual([
			"no owner"
		]);
		setOwner(a);
		expect(view.seen.at(-1)).toBe("live:blob:a");
		view.dispose();
		runtime.dispose();
	});

	it("follows an owner switch with value and status", async () => {
		const { runtime, a, b } = world();
		await runtime.dispatch(openOwned, "a");
		const [owner, setOwner] = createSignal<IEntity | string | undefined>(a);
		const view = mount(runtime, owner);
		await settle();
		expect(view.seen.at(-1)).toBe("live:blob:a");
		setOwner(b);
		expect(view.seen.at(-1)).toBe("none:-");
		await runtime.dispatch(openOwned, "b");
		await settle();
		expect(view.seen.at(-1)).toBe("live:blob:b");
		setOwner(undefined);
		expect(view.seen.at(-1)).toBe("none:-");
		setOwner("a");
		expect(view.seen.at(-1)).toBe("live:blob:a");
		view.dispose();
		runtime.dispose();
	});

	it("supplies to the owner the accessor returns at the call", async () => {
		const { runtime, a, b } = world();
		await runtime.dispatch(openOwned, "a");
		await runtime.dispatch(openOwned, "b");
		const [owner, setOwner] = createSignal<IEntity>(a);
		const view = mount(runtime, owner);
		await settle();
		const first = view.bound().supply([
			"x"
		]);
		setOwner(b);
		expect(await first).toBe("a:1");
		expect(
			await view.bound().supply([
				"x",
				"y"
			])
		).toBe("b:2");
		view.dispose();
		runtime.dispose();
	});

	it("does not subscribe an effect that supplies to the owner accessor", async () => {
		const { runtime, a, b } = world();
		await runtime.dispatch(openOwned, "a");
		await runtime.dispatch(openOwned, "b");
		const [owner, setOwner] = createSignal<IEntity>(a);
		const view = mount(runtime, owner);
		let runs = 0;
		const disposeEffect = createRoot((disposer) => {
			createEffect(() => {
				runs++;
				void view.bound().supply([
					"x"
				]);
			});
			return disposer;
		});
		await settle();
		setOwner(b);
		await settle();
		expect(runs).toBe(1);
		disposeEffect();
		view.dispose();
		runtime.dispose();
	});

	it("types the owner as an entity, an id, or an accessor of either or undefined", () => {
		// Never called: the calls below are compile-time checks.
		const typeOnly = (
			entity: IItem,
			maybe: () => IItem | undefined,
			unnamed: {
				Name: string;
			}
		) => {
			useResource(entity, "View/Owned");
			useResource("a", "View/Owned");
			useResource(maybe, "View/Owned");
			useResource(() => "a", "View/Owned");
			useResource(() => undefined, "View/Owned");
			// @ts-expect-error a number is not an owner
			useResource(1, "View/Owned");
			// @ts-expect-error an object without $Id is not an owner
			useResource(unnamed, "View/Owned");
			// @ts-expect-error an accessor must return an entity, an id or undefined
			useResource(() => 1, "View/Owned");
			// @ts-expect-error an owner may be undefined only through an accessor
			useResource(undefined, "View/Owned");
		};
		expect(typeof typeOnly).toBe("function");
	});
});
