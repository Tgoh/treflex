/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The plugin runs under biome over a fixture outside the repo, because a
// fixture inside it would fail this repo's own lint.
const plugin = resolve(import.meta.dirname, "../packages/core/biome/require-yield-star.grit").replace(/\\/g, "/");
const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const dir = mkdtempSync(join(tmpdir(), "treflex-yield-star-"));

writeFileSync(
	join(dir, "biome.json"),
	JSON.stringify({
		plugins: [
			plugin
		],
		linter: {
			rules: {
				recommended: false
			}
		}
	})
);

afterAll(() => {
	rmSync(dir, {
		recursive: true,
		force: true
	});
});

function diagnosedLines(source: string, extension = "ts"): number[] {
	const file = join(dir, `case.${extension}`);
	writeFileSync(file, source);
	const run = spawnSync(
		process.execPath,
		[
			biome,
			"lint",
			"--reporter=github",
			`--config-path=${dir}`,
			file
		],
		{
			encoding: "utf8"
		}
	);
	return [
		...run.stdout.matchAll(/^::error title=plugin,.*?,line=(\d+),/gm)
	]
		.map((match) => Number(match[1]))
		.sort((a, b) => a - b);
}

describe("require-yield-star", () => {
	it("reports a generator built and discarded in statement position", () => {
		const lines = diagnosedLines(
			[
				"export function* load(draft: any, body: any): Generator<any, void, any> {",
				"\tparallel(body);",
				'\tstartTimer(draft, "K", body);',
				'\tgetData(draft, "K");',
				"\tyield* parallel(body);",
				'\tyield* startTimer(draft, "K", body);',
				'\tyield* getData(draft, "K");',
				'\tpublish("K");',
				'\ttransient(draft, "K", {});',
				'\tyield* transient(draft, "K", {});',
				"}",
				""
			].join("\n")
		);
		expect(lines).toEqual([
			2,
			3,
			4,
			8,
			9
		]);
	}, 30_000);

	it("reports an ask's calls built and discarded, and passes them delegated", () => {
		const lines = diagnosedLines(
			[
				"export function* asking(draft: any, id: any): Generator<any, void, any> {",
				'\task(draft, { Path: "Confirm" });',
				'\tanswer(id, "yes");',
				'\tyield* ask(draft, { Path: "Confirm" });',
				'\tyield* answer(id, "yes");',
				"}",
				""
			].join("\n")
		);
		expect(lines).toEqual([
			2,
			3
		]);
	}, 30_000);

	it("reports inFlight and pendingAsks built and discarded or read as a condition, and passes them delegated", () => {
		const lines = diagnosedLines(
			[
				"export function* reads(draft: any, save: any): Generator<any, boolean, any> {",
				"\tinFlight(save, draft);",
				"\tpendingAsks(draft);",
				"\tif (inFlight(save, draft)) return true;",
				"\tif (draft.Served || inFlight(save, draft)) return true;",
				"\tconst idle = !inFlight(save, draft);",
				"\tconst label = inFlight(save, draft) ? 1 : 0;",
				"\twhile (pendingAsks(draft)) {}",
				"\tif (yield* inFlight(save, draft)) return true;",
				"\tconst busy = (yield* inFlight([save], draft)) && idle;",
				"\treturn (yield* pendingAsks(draft)).length > label && busy;",
				"}",
				""
			].join("\n")
		);
		expect(lines).toEqual([
			2,
			3,
			4,
			5,
			6,
			7,
			8
		]);
	}, 30_000);

	it("reports a creator inside a delegated call's condition, and passes a logical right side", () => {
		const lines = diagnosedLines(
			[
				"export function* reads(draft: any, save: any, answer: any): Generator<any, number, any> {",
				"\tconst n = yield* select(draft, inFlight(save, draft) ? 1 : 2);",
				"\tconst ok = draft.Ok && answer(null);",
				"\tconst answered = (yield* open(ask(draft, { Path: 'Confirm' }))) ?? null;",
				"\treturn ok && answered ? n : 0;",
				"}",
				""
			].join("\n")
		);
		expect(lines).toEqual([
			2
		]);
	}, 30_000);

	it("reports a creator in a JSX when attribute, and passes one read through a selector", () => {
		const lines = diagnosedLines(
			[
				"export function View(props: any) {",
				"\treturn (",
				"\t\t<div>",
				"\t\t\t<Show when={inFlight(props.save, props.state)}>busy</Show>",
				"\t\t\t<Show when={props.feature.saving()}>busy</Show>",
				"\t\t</div>",
				"\t);",
				"}",
				""
			].join("\n"),
			"tsx"
		);
		expect(lines).toEqual([
			4
		]);
	}, 30_000);

	it("reads only the value reads as conditions, so a local helper sharing another creator's name passes", () => {
		const lines = diagnosedLines(
			[
				"export function View(props: any, runtime: any, selector: any, select: any, publish: any) {",
				"\tif (select(runtime, selector)) return null;",
				"\tif (pendingAsks(props.state)) return null;",
				'\tconst field = publish("email") ? 1 : 0;',
				"\tconst busy = inFlight(props.save, props.state) ? 1 : 0;",
				"\treturn (",
				"\t\t<div>",
				'\t\t\t<Show when={publish("email")}>{field}</Show>',
				"\t\t\t<Show when={pendingAsks(props.state)}>{busy}</Show>",
				"\t\t</div>",
				"\t);",
				"}",
				""
			].join("\n"),
			"tsx"
		);
		expect(lines).toEqual([
			3,
			5,
			9
		]);
	}, 30_000);

	it("reports start built and discarded inside a generator function, and passes a start elsewhere", () => {
		const lines = diagnosedLines(
			[
				"export function* action(draft: any, save: any): Generator<any, void, any> {",
				"\tstart(save, draft);",
				"\tyield* start(save, draft);",
				"}",
				"export function view(timer: any, start: any): void {",
				"\tstart(timer);",
				"\ttimer.start();",
				"}",
				"export const feature = {",
				"\t*load(save: any) {",
				'\t\tstart(save, "row");',
				"\t}",
				"};",
				"export class Station {",
				"\tstatic *load(save: any) {",
				'\t\tstart(save, "row");',
				"\t}",
				"}",
				"export const run = async function* (save: any) {",
				'\tstart(save, "row");',
				"};",
				""
			].join("\n")
		);
		expect(lines).toEqual([
			2,
			11,
			16,
			20
		]);
	}, 30_000);

	it("reports mapGen, filterGen and someGen built and discarded, and someGen read as a condition rather than the read in its callback", () => {
		const lines = diagnosedLines(
			[
				"export function* rows(draft: any, save: any, busy: any): Generator<any, boolean, any> {",
				"\tmapGen(draft.Rows, (row: any) => start(save, row));",
				"\tfilterGen(draft.Rows, busy);",
				"\tsomeGen(draft.Rows, busy);",
				"\tif (someGen(draft.Rows, (row: any) =>",
				"\t\tinFlight(save, row))) return true;",
				"\tconst idle = !someGen(draft.Rows, busy);",
				"\tif (yield* someGen(draft.Rows, (row: any) => inFlight(save, row))) return idle;",
				"\tif (draft.Rows.some((row: any) => inFlight(save, row))) return idle;",
				"\tyield* mapGen(draft.Rows, (row: any) => start(save, row));",
				"\tconst kept = yield* filterGen(draft.Rows, function* (row: any) {",
				"\t\treturn !(yield* inFlight(save, row));",
				"\t});",
				"\treturn kept.length > 0 && (yield* someGen(draft.Rows, busy));",
				"}",
				""
			].join("\n")
		);
		expect(lines).toEqual([
			2,
			3,
			4,
			5,
			7,
			9
		]);
	}, 30_000);

	it("reports open and parallelSettled built and discarded, and passes them delegated", () => {
		const lines = diagnosedLines(
			[
				"export function* loads(body: any): Generator<any, void, any> {",
				"\topen(body);",
				"\tparallelSettled(body);",
				"\tyield* open(body);",
				"\tyield* parallelSettled(body);",
				"}",
				""
			].join("\n")
		);
		expect(lines).toEqual([
			2,
			3
		]);
	}, 30_000);
});
