import { createTestRuntime, guids, type IEffectStub, settled } from "treflex";
import { expect, it } from "vitest";
import { type ICounter, increment } from "./counter";

const counter = (): ICounter => ({ $Id: "Counter", Count: 0, Notice: "" });

const stubs = (delay: IEffectStub) => ({
	generateGuid: guids("counter"),
	"Counter/Delay": delay,
});

it("drops an increment dispatched while one runs", async () => {
	const runtime = createTestRuntime(
		counter(),
		stubs(() => Promise.resolve()),
	);
	void runtime.dispatch(increment, "Counter");
	void runtime.dispatch(increment, "Counter");
	await settled();
	expect(runtime.state.Count).toBe(1);
});

it("keeps the count when the delay fails", async () => {
	const runtime = createTestRuntime(
		counter(),
		stubs(() => Promise.reject(new Error("offline"))),
		{ allowFailures: [increment] },
	);
	void runtime.dispatch(increment, "Counter");
	await settled();
	expect(runtime.state.Count).toBe(0);
});
