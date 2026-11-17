import type { IActionGenerator } from "../../src/Types/IAction";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../src/Effects/ask";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { startTimer } from "../../src/Effects/startTimer";
import { bind } from "../../src/Runtime/bind";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { createTestRuntime, settled } from "../../src/Testing/createTestRuntime";

type IState = {
	$Id: string;
	Log: string[];
	Dialog: {
		$Id: string;
	};
};

const seed = (): IState => ({
	$Id: "root",
	Log: [],
	Dialog: {
		$Id: "dialog"
	}
});

function* wait(): IActionGenerator {
	return yield {
		Type: "wait"
	};
}

function* startedWork(draft: IState): IActionGenerator {
	for (let answered = 0; answered < 100; answered++) {
		yield* wait();
	}
	draft.Log.push("started");
}

function* starts(draft: IState): IActionGenerator {
	yield* start(startedWork, draft);
}

const Heard = receiver<IState>("SettledReceiver")({
	*"Settled/Topic"(draft: IState): IActionGenerator {
		yield* wait();
		draft.Log.push("heard");
	}
} as never);

function* listens(draft: IState): IActionGenerator {
	bind(draft, Heard);
}

function* announces(_draft: IState): IActionGenerator {
	yield* (publish as any)("Settled/Topic", {});
}

function* asksForever(draft: IState) {
	draft.Log.push("asked");
	yield* open(
		ask(draft.Dialog, {
			Path: "Settled"
		})
	);
	draft.Log.push("answered");
}

function* waitsOnAStub(draft: IState): IActionGenerator {
	draft.Log.push("waiting");
	yield* wait();
	draft.Log.push("woke");
}

const answers = () =>
	createTestRuntime(seed(), {
		wait: () => Promise.resolve("ok")
	});

afterEach(() => {
	vi.useRealTimers();
});

describe("settled", () => {
	it("waits for a started action's chain of answered stubs", async () => {
		const runtime = answers();
		await runtime.dispatch(starts, "root");
		expect(runtime.state.Log).toEqual([]);
		await settled();
		expect(runtime.state.Log).toEqual([
			"started"
		]);
	});

	it("waits for a receiver a published event started", async () => {
		const runtime = answers();
		runtime.registerReceiver(Heard);
		await runtime.dispatch(listens, "root");
		await runtime.dispatch(announces, "root");
		await settled();
		expect(runtime.state.Log).toEqual([
			"heard"
		]);
	});

	it("returns with an ask parked", async () => {
		const runtime = answers();
		runtime.dispatch(asksForever, "root");
		await settled();
		expect(runtime.state.Log).toEqual([
			"asked"
		]);
	});

	it("returns with a stub's promise unresolved, and picks up once the test resolves it", async () => {
		let release!: () => void;
		const runtime = createTestRuntime(seed(), {
			wait: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		});
		runtime.dispatch(waitsOnAStub, "root");
		await settled();
		expect(runtime.state.Log).toEqual([
			"waiting"
		]);
		release();
		await settled();
		expect(runtime.state.Log).toEqual([
			"waiting",
			"woke"
		]);
	});

	it("returns with a timer row standing", async () => {
		const runtime = answers();
		function* arms(draft: IState): IActionGenerator {
			yield* (startTimer as any)(draft, "Settled/Tick", Heard, 10);
			draft.Log.push("armed");
		}
		await runtime.dispatch(arms, "root");
		await settled();
		expect(runtime.state.Log).toEqual([
			"armed"
		]);
	});

	it("returns under fake timers, drained as ever", async () => {
		vi.useFakeTimers();
		const runtime = answers();
		await runtime.dispatch(starts, "root");
		await settled();
		expect(runtime.state.Log).toEqual([
			"started"
		]);
	});
});
