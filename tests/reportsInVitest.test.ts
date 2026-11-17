/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const fixture = resolve(import.meta.dirname, "fixtures/reports");
const vitest = join(createRequire(import.meta.url).resolve("vitest/package.json"), "../vitest.mjs");

interface IJsonReport {
	testResults: {
		name: string;
		status: string;
		message: string;
		assertionResults: {
			title: string;
			status: string;
		}[];
	}[];
}

it("fails the test that caused a report and passes its clean neighbours, in node, jsdom and under fake timers, and fails the file on a report from its afterAll", {
	timeout: 60_000
}, () => {
	const out = mkdtempSync(join(tmpdir(), "treflex-reports-"));
	try {
		const outputFile = join(out, "report.json");
		const result = spawnSync(
			process.execPath,
			[
				vitest,
				"run",
				"--root",
				fixture,
				"--config",
				join(fixture, "vitest.config.ts"),
				"--maxWorkers=2",
				"--reporter=json",
				`--outputFile=${outputFile}`
			],
			{
				encoding: "utf8",
				timeout: 50_000,
				env: {
					...process.env,
					VITEST: undefined,
					VITEST_POOL_ID: undefined,
					VITEST_WORKER_ID: undefined
				}
			}
		);
		if (!existsSync(outputFile)) {
			throw new Error(
				`the fixture run wrote no report (status ${result.status}, error ${String(result.error)})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
			);
		}
		const report = JSON.parse(readFileSync(outputFile, "utf8")) as IJsonReport;
		const statuses = Object.fromEntries(
			report.testResults.flatMap((file) =>
				file.assertionResults.map((test) => [
					test.title,
					test.status
				])
			)
		);
		expect(statuses).toEqual({
			"node: fails on a failure nothing awaits": "failed",
			"node: passes beside it": "passed",
			"node: fails on a failure that lands as the test ends": "failed",
			"node: passes after it, allowing the failure it awaits": "passed",
			"node: fails on a failure under fake timers": "failed",
			"node: passes last": "passed",
			"jsdom: fails on a failure nothing awaits": "failed",
			"jsdom: passes beside it": "passed",
			"afterAll: passes itself": "passed"
		});
		const afterAllFile = report.testResults.find((file) => file.name.endsWith("afterAll.fixture.ts"));
		expect(afterAllFile?.status).toBe("failed");
		expect(afterAllFile?.message).toContain('[treflex] createTestRuntime: action "fails" on "Root" failed.');
	} finally {
		rmSync(out, {
			recursive: true,
			force: true
		});
	}
});
