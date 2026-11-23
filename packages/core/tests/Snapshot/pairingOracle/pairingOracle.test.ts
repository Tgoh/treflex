import type { ISurvey } from "./check";
import { beforeAll, describe, expect, it } from "vitest";
import { survey } from "./check";
import { oracleMapping } from "./oracle";

const host = (
	globalThis as {
		process?: {
			env?: Record<string, string | undefined>;
		};
	}
).process;

const SEEDS = Number(host?.env?.TREFLEX_PAIRING_SEEDS ?? 15000);

const ids = (...xs: string[]): Set<string> => new Set(xs);

describe("differentialRestore's tree comparison against a brute-force oracle", () => {
	let s: ISurvey;

	beforeAll(() => {
		s = survey(SEEDS);
	}, 600_000);

	it("has an oracle that finds a mapping only when one exists", () => {
		expect(
			oracleMapping(
				{
					l: [
						"~a",
						"~b"
					]
				},
				{
					l: [
						"~d",
						"~c"
					]
				},
				ids("a", "b"),
				ids("c", "d")
			)
		).toEqual(
			new Map([
				[
					"a",
					"d"
				],
				[
					"b",
					"c"
				]
			])
		);
		expect(
			oracleMapping(
				{
					l: [
						"~a",
						"~b"
					],
					m: {
						"~a": "~b"
					}
				},
				{
					l: [
						"~c",
						"~d"
					],
					m: {
						"~d": "~c"
					}
				},
				ids("a", "b"),
				ids("c", "d")
			)
		).toBeUndefined();
		expect(
			oracleMapping(
				{
					l: [
						"~a"
					]
				},
				{
					l: [
						"c"
					]
				},
				ids("a"),
				ids("c")
			)
		).toBeUndefined();
		expect(
			oracleMapping(
				{
					l: [
						"~setup-1"
					]
				},
				{
					l: [
						"~c"
					]
				},
				ids(),
				ids("c")
			)
		).toBeUndefined();
	});

	it("generates unchanged pairs the oracle calls equal, changed pairs of both kinds, and no object keyed by one id written both with and without its ~", () => {
		expect(s.keyedBothWays).toEqual([]);
		expect(s.unchangedOracleUnequal).toEqual([]);
		expect(s.unchanged).toBeGreaterThan(SEEDS / 4);
		expect(s.mutatedOracleEqual).toBeGreaterThan(0);
		expect(s.mutatedOracleUnequal).toBeGreaterThan(SEEDS / 8);
	});

	it("reports no difference only when the oracle finds a mapping", () => {
		expect(s.toolSame).toBeGreaterThan(SEEDS / 4);
		expect(s.unsound).toEqual([]);
	});

	it("reports each difference at a path whose values are those in the two trees", () => {
		expect(s.entries).toBeGreaterThan(SEEDS / 2);
		expect(s.untruthful).toEqual([]);
	});

	it("gives the same verdict whatever the order of the uninterrupted tree's keys, outside the stated limit", () => {
		expect(s.reorderFlipsOutsideLimit).toEqual([]);
	});

	it("reports a difference the oracle can map away only within the stated limit on id-keyed objects", () => {
		expect(s.missesOutsideLimit).toEqual([]);
	});
});
