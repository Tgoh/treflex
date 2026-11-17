import { vi } from "vitest";
import { handWrittenIdRules } from "./handWrittenIdShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

handWrittenIdRules("in production");
