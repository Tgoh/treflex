import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it } from "vitest";
import { entity } from "../../src/Effects/entity";
import { EntityReplacedError } from "../../src/Runtime/draftNode";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreTestRuntime } from "../../src/Snapshot/index";
import { createTestRuntime, guids } from "../../src/Testing/createTestRuntime";

interface IRow {
	$Id: string;
	Key: string;
}

interface IInbox {
	$Id: string;
	Rows: IRow[];
}

const seed = (): IInbox => ({
	$Id: "inbox",
	Rows: []
});

function* refresh(draft: IInbox, keys: string[]): IActionGenerator {
	yield* reconcileRows(
		draft.Rows,
		keys.map((Key) => ({
			Key
		})),
		(row) => row.Key,
		{
			update: () => {}
		}
	);
}

describe("reconcileRows when add makes a live row's id", () => {
	it("names the id and says a minted id collided, for a guids() reused on a second runtime", async () => {
		const before = createTestRuntime(seed(), {
			generateGuid: guids("t")
		});
		await before.dispatch(refresh, "inbox", [
			"a"
		]);
		const { runtime: after } = await restoreTestRuntime<ReturnType<typeof seed>>(createSnapshot(before), {
			rootId: "inbox",
			effectStubs: {
				generateGuid: guids("t")
			}
		});

		const refused = await after
			.dispatch(refresh, "inbox", [
				"a",
				"b"
			])
			.catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(EntityReplacedError);
		const { id, message } = refused as EntityReplacedError;
		expect(id).toBe("~t-1");
		expect(message).toContain('reconcileRows(): add made a row carrying the $Id "~t-1"');
		expect(message).toContain("Rows.0");
		expect(message).toContain("A minted id collided with a live row");
		expect(message).toContain("guids()");
		expect(message).not.toContain("refresh a list with reconcileRows");
		expect(after.state.Rows.map((row) => row.Key)).toEqual([
			"a"
		]);
	});

	it("says the same for an add of its own that copies a live row", async () => {
		const runtime = createTestRuntime(seed(), {
			generateGuid: guids("t")
		});
		await runtime.dispatch(refresh, "inbox", [
			"a"
		]);
		function* copies(draft: IInbox): IActionGenerator {
			yield* reconcileRows(
				draft.Rows,
				[
					{
						Key: "b"
					}
				],
				(row) => row.Key,
				{
					add: () => ({
						...draft.Rows[0]!
					}),
					update: () => {}
				}
			);
		}
		await expect(runtime.dispatch(copies, "inbox")).rejects.toThrow(/add made a row carrying the \$Id "~t-1"/);
	});
});

describe("a replacement outside add", () => {
	it("keeps the general message, which recommends reconcileRows", async () => {
		const runtime = createTestRuntime(seed(), {
			generateGuid: () => "same"
		});
		function* pushesTwo(draft: IInbox): IActionGenerator {
			draft.Rows.push(
				yield* entity({
					Key: "a"
				})
			);
			draft.Rows.push(
				yield* entity({
					Key: "b"
				})
			);
		}
		await expect(runtime.dispatch(pushesTwo, "inbox")).rejects.toThrow(/refresh a list with reconcileRows/);
	});
});
