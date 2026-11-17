import { vi } from "vitest";
import { transientRules } from "./transientShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

transientRules("in production");
