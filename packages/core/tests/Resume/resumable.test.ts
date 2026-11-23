import type { IActionGenerator, IEntity } from "../../src/index";
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as core from "../../src/index";
import * as internal from "../../src/internal";
import { isResumable, resumable } from "../../src/Resume/resumable";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { named } from "../../src/Runtime/named";
import { workTag } from "../../src/Runtime/workTag";
import * as snapshot from "../../src/Snapshot/index";

interface IThing extends IEntity {
	Count: number;
}

describe("resumable", () => {
	it("marks a named action and returns it", () => {
		function* flow(draft: IThing): IActionGenerator {
			draft.Count++;
		}
		named(flow, "Resumable/Marks");
		expect(resumable(flow)).toBe(flow);
		expect(isResumable(flow)).toBe(true);
	});

	it("throws when marked twice", () => {
		function* flow(draft: IThing): IActionGenerator {
			draft.Count++;
		}
		named(flow, "Resumable/Twice");
		resumable(flow);
		expect(() => resumable(flow)).toThrow(/already marked resumable/);
	});

	it("throws at the mark when the function has no durable name yet, whatever requireNames is", () => {
		function* flow(draft: IThing): IActionGenerator {
			draft.Count++;
		}
		expect(() => resumable(flow)).toThrow(/has no durable name/);
		expect(isResumable(flow)).toBe(false);
		named(flow, "Resumable/NamedAfter");
		expect(() => resumable(flow)).not.toThrow();
	});

	it("throws for a value that isn't a function", () => {
		expect(() => resumable(undefined as never)).toThrow(TypeError);
	});

	it("sits beside leading, latest and work tags, in either order", () => {
		const tag = workTag("Resumable/Tag");
		function* first(draft: IThing): IActionGenerator {
			draft.Count++;
		}
		function* second(draft: IThing): IActionGenerator {
			draft.Count++;
		}
		named(first, "Resumable/First");
		named(second, "Resumable/Second");
		resumable(first);
		leading(first);
		latest(second);
		resumable(second);
		tag.mark(first, second);
		expect(isResumable(first) && isResumable(second)).toBe(true);
	});

	it("takes only an action whose draft is an entity", () => {
		function* onEntity(draft: IThing): IActionGenerator {
			draft.Count++;
		}
		function* onPlain(draft: { Count: number }): IActionGenerator {
			draft.Count++;
		}
		named(onEntity, "Resumable/OnEntity");
		expectTypeOf(resumable(onEntity)).toEqualTypeOf(onEntity);
		const typesOnly = () => {
			// @ts-expect-error the draft isn't an entity
			resumable(onPlain);
		};
		expect(typeof typesOnly).toBe("function");
	});

	it("is public as the mark, its error and the restore's report: no entry point exports the keeper, a history or the engine", async () => {
		const named = /resum(?:e|able|ing)|keeper|histor/i;
		const vitestEntry = await import("../../src/Testing/vitest");
		expect(
			Object.keys(core)
				.filter((name) => named.test(name))
				.sort()
		).toEqual([
			"UnreleasedResumeError",
			"resumable"
		]);
		for (const entry of [
			snapshot,
			internal,
			vitestEntry
		]) {
			expect(Object.keys(entry).filter((name) => named.test(name))).toEqual([]);
		}
		const typeNames = [
			"index.ts",
			"Snapshot/index.ts",
			"internal.ts",
			"Testing/vitest.ts"
		].flatMap((file) =>
			[
				...readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8").matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)
			].flatMap((match) => match[1]!.split(",").map((name) => name.trim().replace(/^type\s+/, "")))
		);
		expect(typeNames.filter((name) => named.test(name)).sort()).toEqual([
			"IRestoreResumed",
			"IResumeFieldOf",
			"UnreleasedResumeError",
			"resumable"
		]);
	});
});
