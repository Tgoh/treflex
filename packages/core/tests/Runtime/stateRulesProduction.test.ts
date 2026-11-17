import { vi } from "vitest";
import { stateRules } from "./stateRulesShared";

// DEV is a module constant, so this file mocks it off for the whole file.
vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

stateRules("in production");
