import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IResourceContext } from "../../src/Types/IResource";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../src/Effects/ask";
import { openResource } from "../../src/Effects/openResource";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { startTimer } from "../../src/Effects/startTimer";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import { isEnded } from "../../src/Types/IResource";
import { mountComponent } from "../testHelpers";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"Local/Ping": {
			Text: string;
		};
	}
}
declare module "../../src/Registries/ITimerRegistry" {
	interface ITimerRegistry {
		"Local/Tick": {};
	}
}
declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"local/feed": {
			Message: {
				Text: string;
			};
		};
	}
	interface IResourceRegistry {
		"Local/Feed": {
			Type: "local/feed";
		};
	}
}

type ILocal = {
	$Id: string;
	Log: string[];
};
type IRoot = {
	$Id: string;
};

const LocalReceiver = receiver<ILocal>("LocalOwnerReceiver")({
	*"Local/Ping"(draft, e) {
		draft.Log.push(`ping:${e.Text}`);
	},
	*"Local/Tick"(draft) {
		draft.Log.push("tick");
	},
	*"Local/Feed"(draft, e) {
		draft.Log.push(isEnded(e) ? "ended" : `feed:${e.Text}`);
	}
});

function build() {
	const runtime = createRuntime<IRoot>(
		{
			$Id: "root"
		},
		{}
	);
	const internal = runtime as IRuntimeInternal<IRoot>;
	runtime.registerReceiver(LocalReceiver);
	const id = mountComponent(runtime, undefined, {
		Log: []
	});
	const dispatchLocal = <A extends any[]>(action: (draft: ILocal, ...args: A) => IActionGenerator, ...args: A) =>
		runtime.dispatch(action, id, ...args);
	return {
		runtime,
		internal,
		id,
		local: () => internal.resolveCell(id)?.state as ILocal,
		dispatchLocal
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("ComponentState owners", () => {
	it("take a start from the tree", async () => {
		const world = build();
		function* note(draft: ILocal): IActionGenerator {
			draft.Log.push("started");
		}
		function* starts(_draft: IRoot): IActionGenerator {
			yield* start(note, world.id);
		}
		await world.runtime.dispatch(starts, "root");
		await settle();
		expect(world.local().Log).toEqual([
			"started"
		]);
		world.runtime.dispose();
	});

	it("take a publish on their own binding", async () => {
		const world = build();
		function* listen(draft: ILocal): IActionGenerator {
			bind(draft, LocalReceiver);
		}
		await world.dispatchLocal(listen);
		function* ping(_draft: IRoot): IActionGenerator {
			yield* publish("Local/Ping", {
				Text: "hi"
			});
		}
		await world.runtime.dispatch(ping, "root");
		await settle();
		expect(world.local().Log).toEqual([
			"ping:hi"
		]);
		world.runtime.dispose();
	});

	it("tick on their own timer", async () => {
		vi.useFakeTimers();
		const world = build();
		function* arm(draft: ILocal): IActionGenerator {
			yield* startTimer(draft, "Local/Tick", LocalReceiver, 100);
		}
		await world.dispatchLocal(arm);
		await vi.advanceTimersByTimeAsync(150);
		expect(world.local().Log).toEqual([
			"tick"
		]);
		world.runtime.dispose();
	});

	it("own resources: deliveries reach their state, and unmount retires them", async () => {
		const world = build();
		let ctx!: IResourceContext<"local/feed">;
		world.runtime.registerResourceType("local/feed", (_params, r) => {
			ctx = r;
		});
		function* open(draft: ILocal): IActionGenerator {
			yield* openResource(draft, "Local/Feed", LocalReceiver, {
				Type: "local/feed"
			});
		}
		await world.dispatchLocal(open);
		await ctx.emit({
			Text: "x"
		});
		await settle();
		expect(world.local().Log).toEqual([
			"feed:x"
		]);
		world.internal.unmountComponent(world.id);
		await settle();
		expect(ctx.signal.aborted).toBe(true);
		expect(ctx.signal.reason).toMatchObject({
			name: "AbortError",
			message: "disposed"
		});
		expect(world.runtime.resources()).toEqual([]);
		world.runtime.dispose();
	});

	it("refuse an ask an r.run on their resource opens, as any owner's run does", async () => {
		const world = build();
		let ctx!: IResourceContext<"local/feed">;
		world.runtime.registerResourceType("local/feed", (_params, r) => {
			ctx = r;
		});
		await world.dispatchLocal(function* open(draft: ILocal): IActionGenerator {
			yield* openResource(draft, "Local/Feed", LocalReceiver, {
				Type: "local/feed"
			});
		});
		function* asksOn(ownerId: string): Generator<any, unknown, any> {
			return yield* ask<string>(ownerId, {
				Path: "Local"
			});
		}
		await expect(ctx.run(asksOn(world.id))).rejects.toMatchObject({
			name: "AskRefusedError",
			reason: "in-run"
		});
		await expect(ctx.run(asksOn("root"))).rejects.toMatchObject({
			name: "AskRefusedError",
			reason: "in-run"
		});
		world.runtime.dispose();
	});

	it("hold, so a bare ask from their own action is refused", async () => {
		const world = build();
		const asking = world.dispatchLocal(function* asksBare(): IActionGenerator {
			yield* ask<string>(world.id, {
				Path: "Local"
			});
		});
		await expect(asking).rejects.toMatchObject({
			name: "AskRefusedError",
			reason: "outside-open"
		});
		world.runtime.dispose();
	});
});
