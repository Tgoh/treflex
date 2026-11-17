/// <reference types="node" />
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rawOf } from "../../src/Runtime/viewProxy";
import { settled } from "../../src/Testing/createTestRuntime";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

// A WeakRef keeps its target alive until the job that made or dereferenced it ends, so each
// collection runs in a later task than any deref.
async function collect(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await settled();
		gc();
	}
	await settled();
}

it("collects a plain object, so the probe below can be trusted", async () => {
	const ref = new WeakRef({
		N: 0
	});
	await collect();
	expect(ref.deref()).toBeUndefined();
});

it("collects a runtime nobody disposed once it has started hearing name collisions", async () => {
	const ref = new WeakRef(
		rawOf(
			createRuntime({
				$Id: "root",
				N: 0
			}).state
		) as object
	);
	await collect();
	expect(ref.deref()).toBeUndefined();
});
