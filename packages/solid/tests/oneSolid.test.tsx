import { createRoot } from "solid-js";
import { createRuntime } from "treflex";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TreflexProvider } from "../src/Context/TreflexContext";

const core = vi.hoisted(() => ({
	secondCopy: false
}));

vi.mock("treflex/internal", async (importOriginal) => {
	const actual = await importOriginal<typeof import("treflex/internal")>();
	const otherTrack = Symbol("solid-track");
	return {
		...actual,
		get solidTrack() {
			return core.secondCopy ? otherTrack : actual.solidTrack;
		}
	};
});

function mountProvider(): void {
	const runtime = createRuntime({
		$Id: "Root"
	});
	createRoot((dispose) => {
		try {
			void (<TreflexProvider value={runtime} />);
		} finally {
			dispose();
		}
	});
}

describe("TreflexProvider's one-copy check", () => {
	afterEach(() => {
		core.secondCopy = false;
	});

	it("mounts when treflex and the app share one solid-js", () => {
		expect(mountProvider).not.toThrow();
	});

	it("throws, naming the range and the fix, when treflex runs on another copy of solid-js", () => {
		core.secondCopy = true;
		expect(mountProvider).toThrow(/Two copies of solid-js are loaded.*treflex needs solid-js \^1\.9\.7.*overrides/);
	});
});
