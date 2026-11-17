import type { ILocation } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord as IRuntimeRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it } from "vitest";
import { entity } from "../../src/Effects/entity";
import { start } from "../../src/Effects/start";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { transient } from "../../src/Runtime/transient";
import { rawOf, view } from "../../src/Runtime/viewProxy";
import { copyFrozen } from "../../src/Utility/valueCodec";
import { mountComponent, rawWrite } from "../testHelpers";

interface IContact {
	Name: string;
	Phones: {
		Number: string;
	}[];
}

interface IRecord extends IEntity {
	Contact: IContact;
	Value: number;
}

interface IRoot extends IEntity {
	Records: IRecord[];
	Archive: IRecord[];
}

const seed = (): IRoot => ({
	$Id: "root",
	Records: [
		{
			$Id: "rec",
			Contact: {
				Name: "Ada",
				Phones: [
					{
						Number: "1"
					},
					{
						Number: "2"
					}
				]
			},
			Value: 0
		}
	],
	Archive: []
});

function build() {
	const runtime = createRuntime<IRoot>(seed()) as IRuntimeInternal<IRoot>;
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	const records: IRuntimeRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	return {
		runtime,
		diags,
		records,
		codes: () =>
			diags.map((d) => [
				d.code,
				(
					d.data as {
						cause?: string;
					}
				).cause
			]),
		changes: () => records.flatMap((r) => (r.Kind === "step" ? r.Changes.map((c) => c.Path.join(".")) : []))
	};
}

function* bump(draft: IRecord): IActionGenerator {
	draft.Value++;
}

function* setAt(draft: any, at: ILocation, field: string | number, value: unknown): IActionGenerator {
	let node = at.TransientName === undefined ? draft : yield* transient(draft, at.TransientName, {});
	for (const key of at.Path) {
		node = node?.[key];
	}
	if (node === null || typeof node !== "object") {
		return;
	}
	node[field] = value;
}

const SLOT = "Tests/DispatchTarget/Slot";

function* openSlot(draft: IRecord): IActionGenerator {
	const slot = yield* transient(draft, SLOT, {
		Inner: {
			N: 0
		},
		Rows: [] as IEntity[]
	});
	slot.Inner.N = 1;
	slot.Rows.push(yield* entity({}));
}

function readSlot(runtime: IRuntimeInternal<IRoot>, record: IRecord) {
	return runtime.runSelector(
		function* (owner: IRecord) {
			return yield* transient(owner, SLOT, {
				Inner: {
					N: 0
				},
				Rows: [] as IEntity[]
			});
		},
		() => record
	);
}

describe("dispatch(action, target)", () => {
	it("takes an id, a view of the entity's node and the raw node", async () => {
		const { runtime, diags } = build();
		await runtime.dispatch(bump, "rec");
		await runtime.dispatch(bump, runtime.state.Records[0]!);
		await runtime.dispatch(bump, rawOf(runtime.state.Records[0]!));
		expect(runtime.state.Records[0]!.Value).toBe(3);
		expect(diags).toEqual([]);
	});

	it("follows a node that moved within the tree", async () => {
		const { runtime } = build();
		const held = runtime.state.Records[0]!;
		await runtime.dispatch(function* (draft: IRoot): IActionGenerator {
			draft.Archive.push(draft.Records.shift()!);
		}, "root");
		await runtime.dispatch(bump, held);
		expect(runtime.state.Archive[0]!.Value).toBe(1);
	});

	it("refuses a plain value carrying the $Id as foreign: a copy, a literal and an action's returned value", async () => {
		const { runtime, codes } = build();
		const made = (await runtime.dispatch(function* (draft: IRoot): IActionGenerator<IRecord> {
			const record = yield* entity({
				Contact: {
					Name: "Bo",
					Phones: []
				},
				Value: 0
			});
			draft.Records.push(record);
			return record;
		}, "root"))!;
		await expect(
			runtime.dispatch(bump, {
				...runtime.state.Records[0]!
			})
		).rejects.toThrow(/a copy or other plain value carrying the \$Id/);
		await expect(
			runtime.dispatch(bump, {
				$Id: "rec"
			} as IRecord)
		).rejects.toThrow(/not a node of this runtime's tree/);
		await expect(runtime.dispatch(bump, made)).rejects.toThrow(/not a node of this runtime's tree/);
		expect(codes()).toEqual([
			[
				"dispatch/node-mismatch",
				"foreign"
			],
			[
				"dispatch/node-mismatch",
				"foreign"
			],
			[
				"dispatch/node-mismatch",
				"foreign"
			]
		]);
		expect(runtime.state.Records.map((r) => r.Value)).toEqual([
			0,
			0
		]);
		await runtime.dispatch(bump, made.$Id);
		expect(runtime.state.Records[1]!.Value).toBe(1);
	});

	it("refuses a superseded node, naming the cause once, while the id still dispatches", async () => {
		const { runtime, codes } = build();
		const held = runtime.state.Records[0]!;
		rawWrite(runtime, (raw) => {
			raw.Records[0] = {
				...seed().Records[0]!,
				Value: 10
			};
		});
		await expect(runtime.dispatch(bump, held)).rejects.toThrow(/superseded node/);
		await expect(runtime.dispatch(bump, held)).rejects.toThrow(/superseded node/);
		expect(codes()).toEqual([
			[
				"dispatch/node-mismatch",
				"superseded"
			]
		]);
		await runtime.dispatch(bump, "rec");
		expect(runtime.state.Records[0]!.Value).toBe(11);
	});

	it("refuses a node of another runtime, as its view and its raw node, and a view over a value", async () => {
		const { runtime, codes } = build();
		const other = createRuntime<IRoot>(seed());
		await expect(runtime.dispatch(bump, other.state.Records[0]!)).rejects.toThrow(/not a node of this runtime's tree/);
		await expect(runtime.dispatch(bump, rawOf(other.state.Records[0]!))).rejects.toThrow(/not a node of this runtime's tree/);
		await expect(
			runtime.dispatch(
				bump,
				view({
					...seed().Records[0]!
				})
			)
		).rejects.toThrow(/not a node of this runtime's tree/);
		expect(codes()).toEqual([
			[
				"dispatch/node-mismatch",
				"foreign"
			],
			[
				"dispatch/node-mismatch",
				"foreign"
			]
		]);
		expect(runtime.state.Records[0]!.Value).toBe(0);
		expect(other.state.Records[0]!.Value).toBe(0);
		other.dispose();
	});

	it("diags once per refused node and cause, however many good dispatches on the $Id come between", async () => {
		const { runtime, codes } = build();
		const held = runtime.state.Records[0]!;
		const copy = {
			...held
		};
		rawWrite(runtime, (raw) => {
			raw.Records[0] = {
				...seed().Records[0]!
			};
		});
		for (let round = 0; round < 3; round++) {
			await expect(runtime.dispatch(bump, held)).rejects.toThrow(/superseded node/);
			await runtime.dispatch(bump, "rec");
			await expect(runtime.dispatch(bump, copy)).rejects.toThrow(/a copy or other plain value/);
			await runtime.dispatch(bump, runtime.state.Records[0]!);
		}
		expect(codes()).toEqual([
			[
				"dispatch/node-mismatch",
				"superseded"
			],
			[
				"dispatch/node-mismatch",
				"foreign"
			]
		]);
		expect(runtime.state.Records[0]!.Value).toBe(6);
	});

	it("reports a node again once a dispatch through it has succeeded in between", async () => {
		const { runtime, codes } = build();
		const held = runtime.state.Records[0]!;
		const replace = () =>
			rawWrite(runtime, (raw) => {
				raw.Records[0] = {
					...seed().Records[0]!
				};
			});
		replace();
		await expect(runtime.dispatch(bump, held)).rejects.toThrow(/superseded node/);
		rawWrite(runtime, (raw) => {
			raw.Records[0] = rawOf(held);
		});
		await runtime.dispatch(bump, held);
		replace();
		await expect(runtime.dispatch(bump, held)).rejects.toThrow(/superseded node/);
		expect(codes()).toEqual([
			[
				"dispatch/node-mismatch",
				"superseded"
			],
			[
				"dispatch/node-mismatch",
				"superseded"
			]
		]);
	});

	it("names another runtime's node in the refusal when its $Id is in no cell here", async () => {
		const { runtime, codes } = build();
		const other = createRuntime({
			$Id: "elsewhere",
			Item: {
				$Id: "only-there",
				Value: 0
			}
		});
		await expect(runtime.dispatch(bump as any, other.state.Item)).rejects.toThrow(/no entity "only-there".*or another runtime's node/);
		await expect(runtime.dispatch(bump, "only-there")).rejects.toThrow(/a state root with no \$Id\. /);
		expect(codes()).toEqual([
			[
				"dispatch/unresolved-entity",
				"unresolved"
			]
		]);
		other.dispose();
	});

	it("refuses a node that is no entity, pointing at locate, and a target that is neither an id nor a node", async () => {
		const { runtime, diags } = build();
		await expect(runtime.dispatch(bump as any, runtime.state.Records[0]!.Contact as any)).rejects.toThrow(/locate/);
		await expect(runtime.dispatch(bump, null as unknown as string)).rejects.toThrow(TypeError);
		await expect(runtime.dispatch(bump, 7 as unknown as string)).rejects.toThrow(/not number/);
		expect(diags).toEqual([]);
	});

	it("diags dispatch/unresolved-entity for a node whose entity left, as for its id", async () => {
		const { runtime, codes } = build();
		const held = runtime.state.Records[0]!;
		await runtime.dispatch(function* (draft: IRoot): IActionGenerator {
			draft.Records.length = 0;
		}, "root");
		await expect(runtime.dispatch(bump, held)).rejects.toThrow(/no entity "rec"/);
		expect(codes()).toEqual([
			[
				"dispatch/unresolved-entity",
				"unresolved"
			]
		]);
	});
});

describe("start(action, target)", () => {
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

	it("refuses a copy as the target at the start's yield, with the dispatch refusal's diag", async () => {
		const { runtime, codes } = build();
		let refusal: unknown;
		await runtime.dispatch(function* (draft: IRoot): IActionGenerator {
			try {
				yield* start(bump, {
					...draft.Records[0]!
				});
			} catch (error) {
				refusal = error;
			}
		}, "root");
		await settle();
		expect(String(refusal)).toMatch(/start: the node given for "rec" is not a node of this runtime's tree/);
		expect(codes()).toEqual([
			[
				"dispatch/node-mismatch",
				"foreign"
			]
		]);
		expect(runtime.state.Records[0]!.Value).toBe(0);
	});

	it("takes an id, a node of the tree, and the row entity() made in the step it was written", async () => {
		const { runtime, diags } = build();
		await runtime.dispatch(function* (draft: IRoot): IActionGenerator {
			yield* start(bump, "rec");
			yield* start(bump, draft.Records[0]!);
			const row = yield* entity({
				Contact: {
					Name: "Bo",
					Phones: []
				},
				Value: 0
			});
			draft.Records.push(row);
			yield* start(bump, row);
		}, "root");
		await settle();
		expect(runtime.state.Records.map((r) => r.Value)).toEqual([
			2,
			1
		]);
		expect(diags).toEqual([]);
	});
});

describe("locate(node)", () => {
	it("answers the nearest entity in AppState and the key path down from it", () => {
		const { runtime } = build();
		const record = runtime.state.Records[0]!;
		expect(runtime.locate(record)).toEqual({
			EntityId: "rec",
			Path: []
		});
		expect(runtime.locate(record.Contact)).toEqual({
			EntityId: "rec",
			Path: [
				"Contact"
			]
		});
		expect(runtime.locate(rawOf(record.Contact.Phones[1]))).toEqual({
			EntityId: "rec",
			Path: [
				"Contact",
				"Phones",
				"1"
			]
		});
		expect(runtime.locate(runtime.state.Records)).toEqual({
			EntityId: "root",
			Path: [
				"Records"
			]
		});
		expect(Object.isFrozen(runtime.locate(record.Contact))).toBe(true);
		expect(Object.isFrozen(runtime.locate(record.Contact)!.Path)).toBe(true);
	});

	it("answers a node in a transient as its owner and the transient's name, and an entity in the transient by its own $Id", async () => {
		const { runtime } = build();
		await runtime.dispatch(openSlot, "rec");
		const slot = readSlot(runtime, runtime.state.Records[0]!);
		expect(runtime.locate(slot)).toEqual({
			EntityId: "rec",
			TransientName: SLOT,
			Path: []
		});
		expect(runtime.locate(slot.Inner)).toEqual({
			EntityId: "rec",
			TransientName: SLOT,
			Path: [
				"Inner"
			]
		});
		expect(runtime.locate(slot.Rows[0])).toEqual({
			EntityId: slot.Rows[0]!.$Id,
			Path: []
		});
	});

	it("answers a component's own entity for a node in ComponentState", () => {
		const { runtime } = build();
		const id = mountComponent(runtime, "rec", {
			Draft: {
				Name: ""
			}
		});
		const component = runtime.resolveCell(id)!.state as {
			Draft: object;
		};
		expect(runtime.locate(view(component).Draft)).toEqual({
			EntityId: id,
			Path: [
				"Draft"
			]
		});
	});

	it("answers undefined for nothing and for a node that has left, in AppState and in a slot", async () => {
		const { runtime } = build();
		await runtime.dispatch(openSlot, "rec");
		const contact = runtime.state.Records[0]!.Contact;
		const inner = readSlot(runtime, runtime.state.Records[0]!).Inner;
		expect(runtime.locate(undefined)).toBeUndefined();
		expect(runtime.locate(null)).toBeUndefined();
		await runtime.dispatch(function* (draft: IRecord): IActionGenerator {
			draft.Contact = {
				Name: "Bea",
				Phones: []
			};
		}, "rec");
		expect(runtime.locate(contact)).toBeUndefined();
		expect(runtime.locate(runtime.state.Records[0]!.Contact)).toEqual({
			EntityId: "rec",
			Path: [
				"Contact"
			]
		});
		await runtime.dispatch(function* (draft: IRoot): IActionGenerator {
			draft.Records.length = 0;
		}, "root");
		expect(runtime.locate(inner)).toBeUndefined();
	});

	it("throws for what no dispatch can address: a copy, another runtime's node, a primitive, a rootless tree", () => {
		const { runtime } = build();
		const other = createRuntime<IRoot>(seed());
		expect(() =>
			runtime.locate({
				...runtime.state.Records[0]!.Contact
			})
		).toThrow(/not a node of this runtime's tree/);
		expect(() => runtime.locate(other.state.Records[0]!.Contact)).toThrow(/not a node of this runtime's tree/);
		expect(() => runtime.locate("rec")).toThrow(/a string is not a node/);
		const rootless = createRuntime({
			Form: {
				Name: ""
			}
		});
		expect(() => rootless.locate(rootless.state.Form)).toThrow(/no entity is above the node/);
		other.dispose();
		rootless.dispose();
	});

	it("throws for the default a read of an unwritten slot answered, naming the slot, and still once it's written", async () => {
		const { runtime } = build();
		const slot = readSlot(runtime, runtime.state.Records[0]!);
		const answered = /the default a read of transient "Tests\/DispatchTarget\/Slot" answered/;
		expect(() => runtime.locate(slot)).toThrow(answered);
		expect(() => runtime.locate(slot.Inner)).toThrow(/Write the transient in an action first/);
		await runtime.dispatch(openSlot, "rec");
		expect(() => runtime.locate(slot.Inner)).toThrow(answered);
		expect(runtime.locate(readSlot(runtime, runtime.state.Records[0]!).Inner)).toEqual({
			EntityId: "rec",
			TransientName: SLOT,
			Path: [
				"Inner"
			]
		});
	});

	it("leaves a frozen copy the default shares unmarked, so it isn't named as the slot's", () => {
		const { runtime } = build();
		const copy = copyFrozen({
			N: 1
		});
		if (!copy.ok) {
			throw new Error("unreachable");
		}
		const shared = copy.value as {
			N: number;
		};
		const slot = runtime.runSelector(
			function* (owner: IRecord) {
				return yield* transient(owner, "Tests/DispatchTarget/Shared", {
					Inner: shared
				});
			},
			() => runtime.state.Records[0]!
		);
		expect(slot.Inner).toBe(shared);
		expect(() => runtime.locate(slot)).toThrow(/transient "Tests\/DispatchTarget\/Shared"/);
		expect(() => runtime.locate(shared)).toThrow(/not a node of this runtime's tree/);
	});
});

describe("a write at a located place", () => {
	it("records the full path from the entity", async () => {
		const { runtime, records, changes } = build();
		const at = runtime.locate(runtime.state.Records[0]!.Contact.Phones[1])!;
		await runtime.dispatch(setAt, at.EntityId, at, "Number", "two");

		expect(records.find((r) => r.Kind === "action:start")).toMatchObject({
			Name: "setAt",
			EntityId: "rec",
			Path: [
				"root",
				"rec"
			]
		});
		expect(changes()).toEqual([
			"Contact.Phones.1.Number"
		]);
		expect(runtime.state.Records[0]!.Contact.Phones[1]!.Number).toBe("two");
	});

	it("reaches a node in a transient through transient() on its owner", async () => {
		const { runtime, changes } = build();
		await runtime.dispatch(openSlot, "rec");
		const at = runtime.locate(readSlot(runtime, runtime.state.Records[0]!).Inner)!;
		await runtime.dispatch(setAt, at.EntityId, at, "N", 5);
		expect(readSlot(runtime, runtime.state.Records[0]!).Inner.N).toBe(5);
		expect(changes().at(-1)).toBe(`TransientState.rec.${SLOT}.Inner.N`);
	});

	it("takes a path into plain rows at the dispatch, so a write queued behind a shift lands on the row now there", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const releases: (() => void)[] = [];
		runtime.registerImplementation(
			"tests/wait",
			() =>
				new Promise<void>((resolve) => {
					releases.push(resolve);
				})
		);
		const holding = runtime.dispatch(function* (draft: IRecord): IActionGenerator {
			yield {
				Type: "tests/wait"
			};
			draft.Contact.Phones.shift();
		}, "rec");
		const at = runtime.locate(runtime.state.Records[0]!.Contact.Phones[0])!;
		const writing = runtime.dispatch(setAt, at.EntityId, at, "Number", "one");
		await Promise.resolve();
		expect(runtime.state.Records[0]!.Contact.Phones[0]!.Number).toBe("1");
		releases[0]!();
		await holding;
		await writing;
		expect(runtime.state.Records[0]!.Contact.Phones.map((p) => p.Number)).toEqual([
			"one"
		]);
	});

	it("addresses an entity row by its $Id, so a shift of its array doesn't move the write", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const made = (await runtime.dispatch(function* (draft: IRoot): IActionGenerator<IRecord> {
			const second = yield* entity({
				Contact: {
					Name: "Bo",
					Phones: []
				},
				Value: 0
			});
			draft.Records.push(second);
			return second;
		}, "root"))!;
		const at = runtime.locate(runtime.state.Records[1]!.Contact)!;
		expect(at.EntityId).toBe(made.$Id);
		await runtime.dispatch(function* (draft: IRoot): IActionGenerator {
			draft.Records.shift();
		}, "root");
		await runtime.dispatch(setAt, at.EntityId, at, "Name", "Bob");
		expect(runtime.state.Records.map((r) => r.Contact.Name)).toEqual([
			"Bob"
		]);
	});
});
