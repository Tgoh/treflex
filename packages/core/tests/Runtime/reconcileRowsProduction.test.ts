import { vi } from "vitest";
import { reconcileRowsRules } from "./reconcileRowsShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

reconcileRowsRules("in production");
