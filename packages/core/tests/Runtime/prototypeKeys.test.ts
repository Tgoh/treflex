import type { IActionGenerator } from "../../src/Types/IAction";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publish } from "../../src/Effects/publish";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { startTimer } from "../../src/Effects/startTimer";
import { getDataGlobal } from "../../src/Reads/getData";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import * as reactive from "../reactive";
import { intrinsicChanges, minted, printIntrinsics, rawReceiver, treeWrite } from "../testHelpers";

const POISON = [
	"constructor",
	"toString",
	"__proto__",
	"hasOwnProperty",
	"valueOf"
];

let intrinsics = printIntrinsics();

beforeEach(() => {
	intrinsics = printIntrinsics();
});

afterEach(() => {
	expect(intrinsicChanges(intrinsics, printIntrinsics())).toStrictEqual([]);
});

const publishAny = publish as unknown as (topic: string) => Generator<any, void, any>;
const registerDataSourceAny = registerDataSource as unknown as (
	owner: {
		$Id: string;
	},
	key: string,
	data: {
		$Id: string;
	}
) => Generator<any, void, any>;
const getDataAny = getDataGlobal as unknown as (key: string) => Generator<any, any, any>;
const startTimerAny = startTimer as unknown as (
	entity: {
		$Id: string;
	},
	key: string,
	r: {
		Id: string;
	},
	intervalMs: number
) => Generator<any, void, any>;

interface IWorld {
	$Id: string;
	Seen: number;
	Sub: {
		$Id: string;
		Seen: number;
	};
	Data?: {
		$Id: string;
		Value: string;
	};
}

async function withRuntime(name: string, body: (runtime: ReturnType<typeof createRuntime<IWorld>>) => Promise<void>): Promise<void> {
	await reactive.root(async (dispose) => {
		const runtime = createRuntime<IWorld>(
			{
				$Id: "Root",
				Seen: 0,
				Sub: {
					$Id: name,
					Seen: 0
				}
			},
			{}
		);
		try {
			await body(runtime);
		} finally {
			runtime.dispose();
			dispose();
		}
	});
}

describe("tables keyed by application strings tolerate prototype member names", () => {
	it("an entity whose $Id is one is indexed, addressable, and receives a publish", async () => {
		for (const name of POISON) {
			await withRuntime(name, async (runtime) => {
				const Counter = rawReceiver(
					"Counter",
					[
						"Ping"
					],
					function* Counter(draft: any) {
						draft.Seen++;
					}
				);
				runtime.registerReceiver(Counter);
				function* setup(draft: IWorld): IActionGenerator {
					bind(draft.Sub, Counter);
				}
				function* send(_draft: IWorld): IActionGenerator {
					yield* publishAny("Ping");
				}
				await runtime.dispatch(setup, "Root");
				await runtime.dispatch(send, "Root");
				await new Promise((r) => setTimeout(r, 0));

				expect(runtime.state.Sub.Seen, name).toBe(1);
			});
		}
	});

	it("a topic named one delivers", async () => {
		for (const name of POISON) {
			await withRuntime("Sub", async (runtime) => {
				const Counter = rawReceiver(
					"Counter",
					[
						name
					],
					function* Counter(draft: any) {
						draft.Seen++;
					}
				);
				runtime.registerReceiver(Counter);
				function* setup(draft: IWorld): IActionGenerator {
					bind(draft.Sub, Counter);
				}
				function* send(_draft: IWorld): IActionGenerator {
					yield* publishAny(name);
				}
				await runtime.dispatch(setup, "Root");
				await runtime.dispatch(send, "Root");
				await new Promise((r) => setTimeout(r, 0));

				expect(runtime.state.Sub.Seen, name).toBe(1);
			});
		}
	});

	it("a data-source key named one resolves to its owner", async () => {
		for (const name of POISON) {
			await withRuntime("Sub", async (runtime) => {
				treeWrite(runtime, (s) => {
					s.Data = minted("TheData", {
						Value: "found"
					});
				});
				function* register(draft: IWorld): IActionGenerator {
					yield* registerDataSourceAny(draft, name, draft.Data!);
				}
				function* read(_draft: IWorld): IActionGenerator {
					const found = yield* getDataAny(name);
					return found?.Value;
				}
				await runtime.dispatch(register, "Root");

				expect(await runtime.dispatch(read, "Root"), name).toBe("found");
				// resolve() alone cannot pin this: un-hardened it reads back
				// through the very inherited member the write landed on, so it
				// answers "found" while the table itself holds nothing. The
				// listing is where that lie shows.
				const rows = (runtime as any).get("runtime/dataSources").entries();
				expect(
					rows.map((row: any) => [
						row.Key,
						row.OwnerId,
						row.DataId
					]),
					name
				).toStrictEqual([
					[
						name,
						"Root",
						"~TheData"
					]
				]);
			});
		}
	});

	it("a timer key named one registers a row the table can find and retract", async () => {
		for (const name of POISON) {
			await withRuntime("Sub", async (runtime) => {
				runtime.registerReceiver(rawReceiver("Ticker", [], function* Ticker() {}));
				function* arm(draft: IWorld): IActionGenerator {
					yield* startTimerAny(
						draft.Sub,
						name,
						{
							Id: "Ticker"
						},
						10_000
					);
				}
				await runtime.dispatch(arm, "Root");

				const rows = (runtime as any).get("runtime/timers").entries();
				expect(
					rows.map((row: any) => [
						row.Key,
						row.OwnerId
					]),
					name
				).toStrictEqual([
					[
						name,
						"Sub"
					]
				]);
			});
		}
	});

	it("an effect type named one dispatches to its registered implementation", async () => {
		for (const name of POISON) {
			await withRuntime("Sub", async (runtime) => {
				runtime.registerImplementation(name, () => "ran");
				function* act(_draft: IWorld): IActionGenerator {
					return yield {
						Type: name
					};
				}

				expect(await runtime.dispatch(act, "Root"), name).toBe("ran");
			});
		}
	});

	// Registering the type shadows the inherited member, so the case above
	// cannot fail either way. The real failure mode is the other one: an
	// UNregistered type must read as unregistered rather than resolving to
	// whatever `Object.prototype` happens to carry under that name.
	it("an unregistered effect type named one reads as unregistered", async () => {
		for (const name of POISON) {
			await withRuntime("Sub", async (runtime) => {
				function* act(_draft: IWorld): IActionGenerator {
					return yield {
						Type: name
					};
				}

				// The message matters, not just the rejection: un-hardened the
				// lookup finds the inherited member, sails past the
				// "no implementation" guard, and dies calling `entry.impl`
				// (undefined) with a TypeError that names nothing useful.
				await expect(runtime.dispatch(act, "Root"), name).rejects.toThrow(`No implementation registered for effect type: "${name}"`);
			});
		}
	});
});
