import { vi } from "vitest";
import { leadingRules } from "./leadingShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

leadingRules("in production");
