import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const registered = vi.hoisted(() => [] as string[]);

vi.mock("../../src/Utility/errorClasses", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/Utility/errorClasses")>();
	return {
		...original,
		errorClass: (name: string, errorClass: Function) => {
			registered.push(errorClass.name);
			original.errorClass(name, errorClass as never);
		}
	};
});

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, {
		withFileTypes: true
	}).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return sourceFiles(path);
		}
		return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
			? [
					path
				]
			: [];
	});
}

function errorClassesInSource(): string[] {
	const extendsOf = new Map<string, string>();
	for (const file of sourceFiles(SRC)) {
		for (const match of readFileSync(file, "utf8").matchAll(/\bclass\s+(\w+)\s+extends\s+(\w+)/g)) {
			extendsOf.set(match[1]!, match[2]!);
		}
	}
	const errors = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const [name, base] of extendsOf) {
			if (!errors.has(name) && (base === "Error" || errors.has(base))) {
				errors.add(name);
				grew = true;
			}
		}
	}
	return [
		...errors
	].sort();
}

it("registers every class in packages/core/src that extends Error", async () => {
	// One at a time: loaded together, the modules register with the real errorClass, not the mock.
	for (const load of Object.values(
		import.meta.glob([
			"../../src/**/*.ts",
			"!../../src/**/*.d.ts"
		])
	)) {
		await load();
	}
	const expected = errorClassesInSource();
	expect(expected.length).toBeGreaterThan(20);
	expect(
		[
			...new Set(registered)
		].sort()
	).toEqual(expected);
});
