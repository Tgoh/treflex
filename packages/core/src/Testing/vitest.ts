import { afterAll, afterEach } from "vitest";
import { combineReports, drainReports, holdReports } from "./reports";

holdReports();

const throwHeld = (): void => {
	const error = combineReports(drainReports());
	if (error) {
		throw error;
	}
};

afterEach(throwHeld);

afterAll(() => {
	const error = combineReports(drainReports());
	holdReports(false);
	if (error) {
		throw error;
	}
});
