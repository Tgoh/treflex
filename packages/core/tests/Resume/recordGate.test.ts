import type { IActionJournal } from "../../src/Runtime/createJournal";
import { describe, expect, it } from "vitest";
import { holdRecords } from "../../src/Resume/prefix";

type IAppended = Parameters<IActionJournal["append"]>[0];

function journal(): {
	inner: IActionJournal;
	heard: IAppended[];
} {
	const heard: IAppended[] = [];
	return {
		heard,
		inner: {
			asking: false,
			append(record) {
				heard.push(record);
				return heard.length;
			}
		}
	};
}

const effect = (n: number) =>
	({
		T: n,
		Kind: "effect",
		ActionId: "a",
		Descriptor: null
	}) as unknown as IAppended;

const response = (forSeq: number) =>
	({
		T: 0,
		Kind: "response",
		ActionId: "a",
		ForSeq: forSeq
	}) as unknown as IAppended;

describe("a record gate", () => {
	it("holds every record until deliver, puts the first given ahead of them, then passes records straight through", () => {
		const { inner, heard } = journal();
		const gate = holdRecords();
		const wrapped = gate.wrap(inner);
		wrapped.append(effect(1));
		expect(heard).toEqual([]);
		gate.deliver(effect(0));
		expect(heard.map((record) => record.T)).toEqual([
			0,
			1
		]);
		wrapped.append(effect(2));
		expect(heard.map((record) => record.T)).toEqual([
			0,
			1,
			2
		]);
	});

	it("gives a response held or made later the Seq its held effect was delivered under", () => {
		const { inner, heard } = journal();
		const gate = holdRecords();
		const wrapped = gate.wrap(inner);
		const provisional = wrapped.append(effect(1));
		wrapped.append(response(provisional));
		gate.deliver(effect(0));
		wrapped.append(response(provisional));
		expect(
			heard.map(
				(record) =>
					(
						record as {
							ForSeq?: number;
						}
					).ForSeq
			)
		).toEqual([
			undefined,
			undefined,
			2,
			2
		]);
	});

	it("puts a record appended while it delivers behind the ones still held", () => {
		const heard: IAppended[] = [];
		const gate = holdRecords();
		let wrapped: IActionJournal | undefined;
		const inner: IActionJournal = {
			asking: false,
			append(record) {
				heard.push(record);
				if (record.T === 0) {
					wrapped!.append(effect(3));
				}
				return heard.length;
			}
		};
		wrapped = gate.wrap(inner);
		wrapped.append(effect(1));
		wrapped.append(effect(2));
		gate.deliver(effect(0));
		wrapped.append(effect(4));
		expect(heard.map((record) => record.T)).toEqual([
			0,
			1,
			2,
			3,
			4
		]);
	});

	it("delivers once", () => {
		const { inner, heard } = journal();
		const gate = holdRecords();
		gate.wrap(inner).append(effect(1));
		gate.deliver(effect(0));
		gate.deliver(effect(0));
		expect(heard).toHaveLength(2);
	});
});
