import { afterEach, vi } from "vitest";
import { describeSeededWrites } from "./stateAliasShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

afterEach(() => {
	vi.restoreAllMocks();
});

describeSeededWrites();
