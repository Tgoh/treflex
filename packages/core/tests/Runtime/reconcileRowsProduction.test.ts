import { vi } from "vitest";
import { reconcileRowsRecordRules } from "./reconcileRowsRecordsShared";
import { reconcileRowsRules } from "./reconcileRowsShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

reconcileRowsRules("in production");
reconcileRowsRecordRules("in production");
