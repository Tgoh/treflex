import { vi } from "vitest";
import { askRules } from "./pendingAsksShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

askRules("in production");
