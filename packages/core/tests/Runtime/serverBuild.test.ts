import { describe, expect, it, vi } from "vitest";
import { createRuntime, SolidServerBuildError } from "../../src/index";

// @ts-expect-error solid-js publishes no types for its dist files.
vi.mock("solid-js", () => import("solid-js/dist/server.js"));

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

interface ICounter {
	$Id: string;
	N: number;
}

describe("solid-js's server build, in a production build", () => {
	it("is refused at construction with SolidServerBuildError, naming the conditions", () => {
		let refusal: unknown;
		try {
			createRuntime<ICounter>({
				$Id: "counter",
				N: 0
			});
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(SolidServerBuildError);
		const message = (refusal as Error).message;
		expect(message).toContain('resolve.conditions: ["solid", "browser"]');
		expect(message).toContain("node --conditions=browser");
		expect(message).toContain('so a "worker" condition picks the server build');
	});
});
