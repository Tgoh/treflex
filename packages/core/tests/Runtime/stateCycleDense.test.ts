import type { IRuntimeInternal } from "../../src/Runtime/internals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rawOf } from "../../src/Runtime/viewProxy";
import { treeWrite } from "../testHelpers";

const READ_LIMIT = 100000;

function counter(): () => void {
	let reads = 0;
	return () => {
		if (++reads > READ_LIMIT) {
			throw new Error("a walk is enumerating every path through a dense loop");
		}
	};
}

// A walk over the index reads no cell, so only its WeakMap can count it.
const INDEX_READ_LIMIT = 1000000;

function boundIndexReads(): void {
	const read = WeakMap.prototype.get;
	let reads = 0;
	vi.spyOn(WeakMap.prototype, "get").mockImplementation(function (this: WeakMap<object, unknown>, key: object) {
		// Once only: vitest reads WeakMaps too, and restoring this spy is one of those reads.
		if (++reads === INDEX_READ_LIMIT) {
			throw new Error("a walk is enumerating every path through a ladder");
		}
		return read.call(this, key);
	});
}

// A target behind a counting proxy, which reports the target's frozenness and prototype as
// they are, so a walk treats it as the plain node it stands for.
function counted(
	count: () => void,
	fields: object = {}
): {
	target: any;
	cell: any;
} {
	const target: any = {
		...fields
	};
	const cell = new Proxy(target, {
		get(t, key) {
			count();
			return t[key];
		}
	});
	return {
		target,
		cell
	};
}

function linked(
	frozen: boolean,
	size: number,
	link: (targets: any[], at: (i: number) => any) => void,
	fields?: (i: number) => object
): any {
	const count = counter();
	const made = Array.from(
		{
			length: size
		},
		(_, i) => counted(count, fields?.(i))
	);
	link(
		made.map((node) => node.target),
		(i) => made[i].cell
	);
	for (const node of made) {
		node.target.Leaf = counted(count).cell;
	}
	if (frozen) {
		for (const node of made) {
			Object.freeze(node.target);
		}
	}
	return made[0].cell;
}

const grid8 = (frozen: boolean) => () =>
	linked(frozen, 64, (targets, at) => {
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 8; x++) {
				const target = targets[y * 8 + x];
				if (x < 7) {
					target.R = at(y * 8 + x + 1);
				}
				if (x > 0) {
					target.L = at(y * 8 + x - 1);
				}
				if (y < 7) {
					target.D = at((y + 1) * 8 + x);
				}
				if (y > 0) {
					target.U = at((y - 1) * 8 + x);
				}
			}
		}
	});

const ladder20 = () =>
	linked(false, 20, (targets, at) => {
		for (let i = 0; i < 19; i++) {
			targets[i].L = at(i + 1);
			targets[i].R = at(i + 1);
		}
		targets[19].Back = at(0);
	});

const shapes: {
	shape: string;
	make: () => any;
	ladder?: true;
}[] = [
	{
		shape: "an 8x8 grid",
		make: grid8(false)
	},
	{
		shape: "a frozen 8x8 grid",
		make: grid8(true)
	},
	{
		shape: "a ladder with one back edge",
		make: ladder20,
		ladder: true
	}
];

function buildWorld(journal: boolean, verifyIndex: boolean) {
	const deferred: (() => void)[] = [];
	vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
		deferred.push(callback);
	});
	const runtime = createRuntime<any>(
		{
			$Id: "root",
			Plain: {}
		},
		{
			verifyIndex
		}
	) as IRuntimeInternal<any>;
	if (journal) {
		runtime.on("record", () => {});
	}
	return {
		runtime,
		surface(): unknown[] {
			const surfaced: unknown[] = [];
			for (const callback of deferred.splice(0)) {
				try {
					callback();
				} catch (error) {
					surfaced.push(error);
				}
			}
			return surfaced;
		}
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(shapes)("$shape", ({ make, ladder }) => {
	it("is refused at the first closing edge, as a seed and a write", () => {
		expect(() =>
			createRuntime<any>({
				$Id: "root",
				G: make()
			})
		).toThrow(/not plain: cycle at/);
		const world = buildWorld(true, true);
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.G = make();
			})
		).toThrow(/not plain: cycle at/);
	});

	describe.each([
		{
			journal: true,
			verifyIndex: true
		},
		{
			journal: false,
			verifyIndex: false
		}
	])("seated by a raw write, journal $journal, verify $verifyIndex", ({ journal, verifyIndex }) => {
		it("fails the write or the resync that meets it, loudly, without walking every path", () => {
			if (ladder) {
				boundIndexReads();
			}
			const world = buildWorld(journal, verifyIndex);
			rawOf(world.runtime.state).G = make();
			expect(() => {
				treeWrite(world.runtime, (s) => {
					s.Plain.Tick = 1;
				});
				world.runtime.get("runtime/writeGateway").resync();
			}).toThrow(/a rebuild met|the tree holds a node twice/);
			expect(world.surface()).toEqual([]);
		});
	});
});
