import type { IActionGenerator, IBranchOutcome, IRecord, IRecordExtras } from "../../src/index";
import { describe, expect, it } from "vitest";
import { ask, createTestRuntime, latest, NonPlainDataError, parallel, parallelSettled, settled } from "../../src/index";

type IDeferred = {
	promise: Promise<unknown>;
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
};

function deferred(): IDeferred {
	let resolve!: (v: unknown) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {
		promise,
		resolve,
		reject
	};
}

function harness(onError?: (error: unknown) => void) {
	const log: string[] = [];
	const d: Record<string, IDeferred> = {};
	const get = (key: string): IDeferred => {
		d[key] ??= deferred();
		return d[key];
	};
	const runtime = createTestRuntime(
		{
			$Id: "e1",
			items: [] as string[],
			other: {
				$Id: "e2",
				items: [] as string[]
			}
		},
		{
			wait: (e: any) => get(e.Key).promise
		},
		onError
			? {
					onError,
					allowFailures: true
				}
			: undefined
	);
	const ids = new Map<string, string>();
	const sym = (id: unknown): string => {
		const key = String(id);
		if (!ids.has(key)) {
			ids.set(key, `#${ids.size + 1}`);
		}
		return ids.get(key)!;
	};
	const effectBySeq = new Map<number, string>();
	runtime.on("record", (record: IRecord, _live?: IRecordExtras) => {
		const r = record as any;
		switch (record.Kind) {
			case "effect":
				effectBySeq.set(r.Seq, r.Type);
				log.push(`effect ${r.Type} br=${sym(r.BranchId)}`);
				break;
			case "response":
				log.push(`response ${effectBySeq.get(r.ForSeq) ?? "?"}${"Error" in r ? " ERR" : ""}`);
				break;
			case "step":
				log.push(`step br=${sym(r.BranchId)} n=${r.Changes.length}`);
				break;
			case "branch:start":
				log.push(`branch:start br=${sym(r.BranchId)} parent=${sym(r.ParentBranchId)}`);
				break;
			case "branch:end":
				log.push(`branch:end br=${sym(r.BranchId)} ${r.Status}${r.Error ? ` ${r.Error.Message ?? ""}` : ""}`);
				break;
			case "action:start":
				log.push(`action:start ${sym(r.ActionId)}`);
				break;
			case "action:end":
				log.push(`action:end ${sym(r.ActionId)} ${r.Status}`);
				break;
			default:
				log.push(record.Kind);
		}
	});
	const tick = (): void => {
		void Promise.resolve().then(() => {
			log.push("tick");
		});
	};
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 30; i++) {
			await Promise.resolve();
		}
		await new Promise((r) => setTimeout(r, 0));
	};
	const pinned = (): string[] => log.filter((line) => !line.startsWith("action:end"));
	return {
		log,
		runtime,
		get,
		tick,
		flush,
		pinned
	};
}

function* wait(key: string): IActionGenerator<unknown> {
	return yield {
		Type: "wait",
		Key: key
	};
}

const started = [
	"action:start #1",
	"effect parallel br=#1",
	"branch:start br=#2 parent=#1",
	"effect wait br=#2",
	"branch:start br=#3 parent=#1",
	"effect wait br=#3"
];

describe("wake order inside one action: each wake runs to its end before the next", () => {
	it("two branches answered in the same tick: each branch ends in its own answer, and the parent resumes before a microtask passes", async () => {
		const h = harness();
		function* br(draft: any, key: string): IActionGenerator {
			yield* wait(key);
			draft.items.push(key);
			h.log.push(`body ${key}`);
		}
		function* act(draft: any): IActionGenerator {
			yield* parallel(br(draft, "x"), br(draft, "x"));
			h.log.push("body parent");
			draft.items.push("p");
		}
		const done = h.runtime.dispatch(act, "e1");
		await h.flush();
		h.get("x").resolve(1);
		h.tick();
		await done;
		await h.flush();
		expect(h.pinned()).toEqual([
			...started,
			"response wait",
			"body x",
			"step br=#2 n=2",
			"branch:end br=#2 completed",
			"response wait",
			"body x",
			"step br=#3 n=2",
			"branch:end br=#3 completed",
			"response parallel",
			"body parent",
			"step br=#1 n=2",
			"tick"
		]);
	});

	it("branches answered in different ticks: the last answer resumes the parent in its own tick", async () => {
		const h = harness();
		function* br(_draft: any, key: string): IActionGenerator {
			yield* wait(key);
			h.log.push(`body ${key}`);
		}
		function* act(draft: any): IActionGenerator {
			yield* parallel(br(draft, "x"), br(draft, "y"));
			h.log.push("body parent");
		}
		const done = h.runtime.dispatch(act, "e1");
		await h.flush();
		h.get("y").resolve(1);
		h.tick();
		await h.flush();
		h.get("x").resolve(1);
		h.tick();
		await done;
		await h.flush();
		expect(h.pinned()).toEqual([
			...started,
			"response wait",
			"body y",
			"branch:end br=#3 completed",
			"tick",
			"response wait",
			"body x",
			"branch:end br=#2 completed",
			"response parallel",
			"body parent",
			"tick"
		]);
	});

	it("branches that never yield end as they start, and the parent resumes a microtask later, after dispatch has returned", async () => {
		const h = harness();
		function* sync(draft: any, k: string): IActionGenerator {
			draft.items.push(k);
			h.log.push(`body ${k}`);
		}
		function* act(draft: any): IActionGenerator {
			yield* parallel(sync(draft, "a"), sync(draft, "b"));
			h.log.push("body parent");
		}
		const done = h.runtime.dispatch(act, "e1");
		h.log.push("dispatched");
		h.tick();
		await done;
		await h.flush();
		expect(h.pinned()).toEqual([
			"action:start #1",
			"effect parallel br=#1",
			"branch:start br=#2 parent=#1",
			"body a",
			"step br=#2 n=2",
			"branch:end br=#2 completed",
			"branch:start br=#3 parent=#1",
			"body b",
			"step br=#3 n=2",
			"branch:end br=#3 completed",
			"dispatched",
			"response parallel",
			"body parent",
			"tick"
		]);
	});

	for (const fan of [
		parallel,
		parallelSettled
	]) {
		it(`an empty ${fan.name} resumes its parent a microtask later, after dispatch has returned`, async () => {
			const h = harness();
			function* act(_draft: any): IActionGenerator {
				yield* fan();
				h.log.push("body parent");
			}
			const done = h.runtime.dispatch(act, "e1");
			h.log.push("dispatched");
			h.tick();
			await done;
			await h.flush();
			expect(h.pinned()).toEqual([
				"action:start #1",
				`effect ${fan.name} br=#1`,
				"dispatched",
				`response ${fan.name}`,
				"body parent",
				"tick"
			]);
		});

		it(`${fan.name} whose branches never wait gives up a turn: dispatch returns before the action runs past it`, async () => {
			const log: string[] = [];
			const runtime = createTestRuntime({
				$Id: "e1"
			});
			function* sync(): IActionGenerator<number> {
				return 1;
			}
			function* act(): IActionGenerator {
				yield* fan(sync());
				log.push("action past the fan-out");
			}
			const done = runtime.dispatch(act, "e1");
			log.push("dispatch returned");
			await done;
			expect(log).toEqual([
				"dispatch returned",
				"action past the fan-out"
			]);
		});
	}

	it("a loop of fan-outs whose branches never wait is stopped by a replacement dispatched from a microtask, after two iterations", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "e1",
				other: {
					$Id: "e2"
				}
			},
			{
				ping: () => Promise.resolve(1)
			}
		);
		let iterations = 0;
		function* sync(): IActionGenerator<number> {
			return 1;
		}
		let run = 0;
		const act = latest(function* act(_draft: any): IActionGenerator {
			if (++run > 1) {
				return;
			}
			for (let i = 0; i < 2000; i++) {
				iterations++;
				yield* parallel(sync());
			}
		});
		function* stopper(): IActionGenerator {
			yield {
				Type: "ping"
			};
			void runtime.dispatch(act, "e1");
		}
		const first = runtime.dispatch(act, "e1");
		void runtime.dispatch(stopper, "e2");
		await first;
		expect(iterations).toBe(2);
	});

	it("a nested fan-out's end reaches the outer branch, and that branch's end its parent, inside the inner answer's wake", async () => {
		const h = harness();
		function* leaf(_draft: any, key: string): IActionGenerator {
			yield* wait(key);
			h.log.push(`body leaf ${key}`);
		}
		function* inner(draft: any): IActionGenerator {
			yield* parallel(leaf(draft, "x"));
			h.log.push("body inner");
			draft.items.push("inner");
		}
		function* sibling(draft: any): IActionGenerator {
			yield* wait("y");
			h.log.push("body sibling");
			draft.items.push("sibling");
		}
		function* act(draft: any): IActionGenerator {
			yield* parallel(inner(draft), sibling(draft));
			h.log.push(`body parent ${draft.items.join(",")}`);
		}
		const done = h.runtime.dispatch(act, "e1");
		await h.flush();
		h.get("x").resolve(1);
		void Promise.resolve().then(() => h.get("y").resolve(1));
		h.tick();
		await done;
		await h.flush();
		expect(h.pinned()).toEqual([
			"action:start #1",
			"effect parallel br=#1",
			"branch:start br=#2 parent=#1",
			"effect parallel br=#2",
			"branch:start br=#3 parent=#2",
			"effect wait br=#3",
			"branch:start br=#4 parent=#1",
			"effect wait br=#4",
			"response wait",
			"body leaf x",
			"branch:end br=#3 completed",
			"response parallel",
			"body inner",
			"step br=#2 n=2",
			"branch:end br=#2 completed",
			"tick",
			"response wait",
			"body sibling",
			"step br=#4 n=2",
			"branch:end br=#4 completed",
			"response parallel",
			"body parent inner,sibling"
		]);
	});

	it("a failing branch stops its sibling, which closes a microtask later; the parent catches inside the close's wake", async () => {
		const h = harness();
		function* thrower(_draft: any): IActionGenerator {
			yield* wait("x");
			h.log.push("body thrower throws");
			throw new Error("boom");
		}
		function* waiter(draft: any): IActionGenerator {
			try {
				yield* wait("never");
			} finally {
				h.log.push("body waiter finally");
				draft.items.push("fin");
			}
		}
		function* act(draft: any): IActionGenerator {
			try {
				yield* parallel(thrower(draft), waiter(draft));
			} catch (e) {
				h.log.push(`body parent caught ${(e as Error).message}`);
			}
		}
		const done = h.runtime.dispatch(act, "e1");
		await h.flush();
		h.get("x").resolve(1);
		h.tick();
		await done;
		await h.flush();
		expect(h.pinned()).toEqual([
			...started,
			"response wait",
			"body thrower throws",
			"branch:end br=#2 errored boom",
			"tick",
			"body waiter finally",
			"step br=#3 n=2",
			"branch:end br=#3 cancelled",
			"response parallel ERR",
			"body parent caught boom"
		]);
		expect((h.runtime.state as any).items).toEqual([
			"fin"
		]);
	});

	for (const [name, first, keys] of [
		[
			"answered in the same tick",
			"first",
			[
				"x",
				"x"
			]
		],
		[
			"the second answered first",
			"second",
			[
				"x",
				"y"
			]
		]
	] as const) {
		it(`two branches that throw, ${name}: the first to fail ends errored, and the other, stopped with its answer already delivered, ends cancelled after its response`, async () => {
			const h = harness();
			function* thrower(_draft: any, msg: string, key: string): IActionGenerator {
				yield* wait(key);
				throw new Error(msg);
			}
			function* act(draft: any): IActionGenerator {
				try {
					yield* parallel(thrower(draft, "first", keys[0]), thrower(draft, "second", keys[1]));
				} catch (e) {
					h.log.push(`body parent caught ${(e as Error).message}`);
				}
			}
			const done = h.runtime.dispatch(act, "e1");
			await h.flush();
			h.get(keys[1]).resolve(1);
			h.get(keys[0]).resolve(1);
			h.tick();
			await done;
			await h.flush();
			const [failed, stopped] =
				first === "first"
					? [
							"#2",
							"#3"
						]
					: [
							"#3",
							"#2"
						];
			expect(h.pinned()).toEqual([
				...started,
				"response wait",
				`branch:end br=${failed} errored ${first}`,
				"response wait",
				`branch:end br=${stopped} cancelled`,
				"response parallel ERR",
				`body parent caught ${first}`,
				"tick"
			]);
		});
	}

	it("a branch that throws in its first step: a sibling not yet started ends at its start, one already parked closes a microtask later", async () => {
		const h = harness();
		function* bad(_draft: any): IActionGenerator {
			throw new Error("sync boom");
		}
		function* later(draft: any): IActionGenerator {
			try {
				h.log.push("body later started");
				yield* wait("x");
			} finally {
				h.log.push("body later finally");
				draft.items.push("lfin");
			}
		}
		function* act(draft: any): IActionGenerator {
			try {
				yield* parallel(later(draft), bad(draft), later(draft));
			} catch (e) {
				h.log.push(`body parent caught ${(e as Error).message}`);
			}
		}
		const done = h.runtime.dispatch(act, "e1");
		h.log.push("dispatched");
		h.tick();
		await done;
		await h.flush();
		expect(h.pinned()).toEqual([
			"action:start #1",
			"effect parallel br=#1",
			"branch:start br=#2 parent=#1",
			"body later started",
			"effect wait br=#2",
			"branch:start br=#3 parent=#1",
			"branch:end br=#3 errored sync boom",
			"branch:start br=#4 parent=#1",
			"branch:end br=#4 cancelled",
			"dispatched",
			"body later finally",
			"step br=#2 n=2",
			"branch:end br=#2 cancelled",
			"response parallel ERR",
			"body parent caught sync boom",
			"tick"
		]);
		expect((h.runtime.state as any).items).toEqual([
			"lfin"
		]);
	});

	it("parallelSettled: each branch ends in its own answer's wake, in answer order", async () => {
		const h = harness();
		function* ok(_draft: any, key: string): IActionGenerator<string> {
			yield* wait(key);
			return key;
		}
		function* bad(_draft: any, key: string): IActionGenerator {
			yield* wait(key);
			throw new Error(`bad-${key}`);
		}
		function* syncBad(_draft: any): IActionGenerator {
			throw new Error("sync-bad");
		}
		function* act(draft: any): IActionGenerator {
			const out = yield* parallelSettled(ok(draft, "x"), bad(draft, "y"), syncBad(draft), ok(draft, "z"));
			h.log.push(`body parent ${JSON.stringify(out.map((o: any) => (o.ok ? o.value : o.error.message)))}`);
		}
		const done = h.runtime.dispatch(act, "e1");
		await h.flush();
		h.get("z").resolve(1);
		h.get("y").resolve(1);
		h.get("x").resolve(1);
		h.tick();
		await done;
		await h.flush();
		expect(h.pinned()).toEqual([
			"action:start #1",
			"effect parallelSettled br=#1",
			"branch:start br=#2 parent=#1",
			"effect wait br=#2",
			"branch:start br=#3 parent=#1",
			"effect wait br=#3",
			"branch:start br=#4 parent=#1",
			"branch:end br=#4 errored sync-bad",
			"branch:start br=#5 parent=#1",
			"effect wait br=#5",
			"response wait",
			"branch:end br=#5 completed",
			"response wait",
			"branch:end br=#3 errored bad-y",
			"response wait",
			"branch:end br=#2 completed",
			"response parallelSettled",
			'body parent ["x","bad-y","sync-bad","z"]',
			"tick"
		]);
	});

	it("a parent replaced by latest: each stopped branch's close and its end land together, ahead of the parent's close", async () => {
		const h = harness();
		let run = 0;
		function* br(draft: any, key: string): IActionGenerator {
			try {
				yield* wait(key);
			} finally {
				h.log.push(`body ${key} finally`);
				draft.items.push(`fin-${key}`);
			}
		}
		const act = latest(function* act(draft: any): IActionGenerator {
			const n = ++run;
			try {
				yield* parallel(br(draft, `a${n}`), br(draft, `b${n}`));
			} finally {
				h.log.push(`body parent ${n} finally`);
			}
		});
		const first = h.runtime.dispatch(act, "e1");
		await h.flush();
		h.log.push("second dispatch");
		void h.runtime.dispatch(act, "e1");
		h.tick();
		await first;
		const from = h.log.indexOf("second dispatch");
		expect(h.log.slice(from, h.log.indexOf("tick") + 1)).toEqual([
			"second dispatch",
			"action:start #4",
			"body a1 finally",
			"step br=#2 n=2",
			"branch:end br=#2 cancelled",
			"body b1 finally",
			"step br=#3 n=2",
			"branch:end br=#3 cancelled",
			"body parent 1 finally",
			"tick"
		]);
	});

	it("an independent action answered any number of microtasks after a fan-out's last branch never steps between that branch's end and its parent's resume", async () => {
		const rows: string[] = [];
		for (let delay = 0; delay <= 8; delay++) {
			const h = harness();
			function* br(_draft: any): IActionGenerator {
				yield* wait("x");
			}
			function* act(draft: any): IActionGenerator {
				yield* parallel(br(draft));
				h.log.push("fanout-parent");
			}
			function* other(_draft: any): IActionGenerator {
				yield* wait("y");
				h.log.push("other");
			}
			const d1 = h.runtime.dispatch(act, "e1");
			const d2 = h.runtime.dispatch(other, "e2");
			await h.flush();
			h.get("x").resolve(1);
			let p: Promise<unknown> = Promise.resolve();
			for (let i = 0; i < delay; i++) {
				p = p.then(() => {});
			}
			void p.then(() => h.get("y").resolve(1));
			await d1;
			await d2;
			rows.push(h.log.filter((l) => l === "fanout-parent" || l === "other").join(" < "));
		}
		expect(rows).toEqual(new Array(9).fill("fanout-parent < other"));
	});
});

describe("a stopped action lets go of its hold", () => {
	for (const branches of [
		true,
		false
	]) {
		it(`${branches ? "with" : "without"} branches: the replacement's first effect lands a microtask after the stop, ahead of the old action's action:end`, async () => {
			const h = harness();
			let run = 0;
			function* br(key: string): IActionGenerator {
				try {
					yield* wait(key);
				} finally {
					h.log.push(`body ${key} finally`);
				}
			}
			const act = latest(function* act(_draft: any): IActionGenerator {
				const n = ++run;
				if (n > 1) {
					yield* wait(`r${n}`);
					return;
				}
				try {
					if (branches) {
						yield* parallel(br("a1"), br("b1"));
					} else {
						yield* wait("a1");
					}
				} finally {
					h.log.push("body parent finally");
				}
			});
			void h.runtime.dispatch(act, "e1");
			await h.flush();
			h.log.length = 0;
			void h.runtime.dispatch(act, "e1");
			h.tick();
			void Promise.resolve()
				.then(() => {})
				.then(() => h.log.push("second tick"));
			await h.flush();
			expect(h.log.filter((l) => !l.startsWith("step") && !l.startsWith("branch:"))).toEqual([
				`action:start #${branches ? 4 : 2}`,
				...(branches
					? [
							"body a1 finally",
							"body b1 finally"
						]
					: []),
				"body parent finally",
				"tick",
				`effect wait br=#${branches ? 4 : 2}`,
				"action:end #1 cancelled",
				"second tick"
			]);
		});
	}
});

describe("a branch that stops its own action and then throws", () => {
	it("the parent's catch never runs, the stopped sibling closes, and the failure goes to onError as taken", async () => {
		const reports: string[] = [];
		const h = harness((error) => {
			reports.push(`onError ${(error as Error).message}`);
		});
		h.runtime.on("failure", (f: any) => {
			reports.push(`failure ${f.Error?.message ?? String(f.Error)} status=${f.Status} close=${f.Close} taken=${f.Taken}`);
		});
		h.runtime.on("diag", (d: any) => {
			reports.push(`diag ${d.code}`);
		});
		let run = 0;
		const act = latest(function* act(_draft: any): IActionGenerator {
			const n = ++run;
			if (n > 1) {
				h.log.push("body replacement runs");
				return;
			}
			function* killer(): IActionGenerator {
				yield* wait("x");
				h.log.push("body killer dispatches replacement");
				void h.runtime.dispatch(act, "e1");
				throw new Error("kept");
			}
			function* other(): IActionGenerator {
				try {
					yield* wait("never");
				} finally {
					h.log.push("body other finally");
				}
			}
			try {
				yield* parallel(killer(), other());
			} catch (e) {
				h.log.push(`body parent caught ${(e as Error).message}`);
			}
		});
		const first = h.runtime.dispatch(act, "e1").then(
			(v: unknown) => h.log.push(`first resolved ${String(v)}`),
			(e: Error) => h.log.push(`first rejected ${e.message}`)
		);
		await h.flush();
		h.get("x").resolve(1);
		await first;
		await h.flush();
		expect(h.log).toEqual([
			"action:start #1",
			"effect parallel br=#1",
			"branch:start br=#2 parent=#1",
			"effect wait br=#2",
			"branch:start br=#3 parent=#1",
			"effect wait br=#3",
			"response wait",
			"body killer dispatches replacement",
			"action:start #4",
			"branch:end br=#2 errored kept",
			"body other finally",
			"branch:end br=#3 cancelled",
			"body replacement runs",
			"action:end #1 cancelled",
			"action:end #4 completed",
			"first resolved undefined"
		]);
		expect(reports).toEqual([
			"onError kept",
			"failure kept status=cancelled close=false taken=true"
		]);
	});
});

describe("a stop dispatched any number of microtasks after a fan-out's last answer", () => {
	for (const kind of [
		"parallel",
		"parallelSettled",
		"parallel-fail"
	] as const) {
		it(`${kind}: finds the parent already resumed past the fan-out`, async () => {
			const rows: string[] = [];
			for (let delay = 0; delay <= 7; delay++) {
				let release!: (v: unknown) => void;
				const gate = new Promise((r) => {
					release = r;
				});
				const runtime = createTestRuntime(
					{
						$Id: "e1",
						items: [] as string[]
					},
					{
						wait: (e: any) => (e.Key === "x" ? gate : new Promise(() => {}))
					}
				);
				let run = 0;
				function* br(): IActionGenerator {
					yield {
						Type: "wait",
						Key: "x"
					};
					if (kind === "parallel-fail") {
						throw new Error("f");
					}
				}
				const act = latest(function* act(draft: any): IActionGenerator {
					const n = ++run;
					if (n > 1) {
						return;
					}
					try {
						if (kind === "parallelSettled") {
							yield* parallelSettled(br());
						} else {
							yield* parallel(br());
						}
					} catch {
						draft.items.push("caught");
					}
					draft.items.push("after");
					yield {
						Type: "wait",
						Key: "never"
					};
				});
				const first = runtime.dispatch(act, "e1").catch(() => {});
				for (let i = 0; i < 20; i++) {
					await Promise.resolve();
				}
				release(1);
				let p: Promise<unknown> = Promise.resolve();
				for (let i = 0; i < delay; i++) {
					p = p.then(() => {});
				}
				await p.then(() => runtime.dispatch(act, "e1"));
				await first;
				rows.push((runtime.state as any).items.includes("after") ? "after-ran" : "stopped-first");
			}
			expect(rows).toEqual(new Array(8).fill("after-ran"));
		});
	}
});

function world(state: object, allowDiags?: readonly string[]) {
	const log: string[] = [];
	const d: Record<string, IDeferred> = {};
	const get = (key: string): IDeferred => {
		d[key] ??= deferred();
		return d[key];
	};
	const runtime = createTestRuntime(
		state,
		{
			wait: (e: any) => get(e.Key).promise
		},
		{
			onError: (error: any) => log.push(`onError ${error?.Error?.Message ?? error?.message ?? String(error)}`),
			allowFailures: true,
			allowDiags
		}
	);
	runtime.on("diag", (diag: any) => log.push(`diag ${diag.code}`));
	runtime.on("failure", (f: any) => log.push(`failure ${f.Error?.message} ${f.Status} taken=${f.Taken}`));
	const flush = async (): Promise<void> => {
		await settled();
		await settled();
	};
	const outcome = (p: Promise<unknown>): Promise<string> =>
		p.then(
			(v) => String(v),
			(e: Error) => `rejected ${e.message}`
		);
	return {
		log,
		runtime: runtime as any,
		get,
		flush,
		outcome
	};
}

function* fails(name = "boom"): IActionGenerator {
	throw new Error(name);
}

describe("a stop, removal or dispose between a fan-out's end and the parent's resume from it", () => {
	it("a latest replacement: the parent's catch never runs, its finally does, the failure is reported once, and the replacement takes the hold", async () => {
		const h = world({
			$Id: "e1",
			items: [] as string[]
		});
		let runs = 0;
		function* ok(draft: any): IActionGenerator {
			draft.items.push("ok");
		}
		const act = latest(function* act(draft: any): IActionGenerator {
			if (++runs > 1) {
				h.log.push("second run");
				return;
			}
			try {
				yield* parallel(ok(draft), fails());
				h.log.push("after parallel");
			} catch (e) {
				h.log.push(`caught ${(e as Error).message}`);
			} finally {
				h.log.push("finally");
			}
		});
		const a = h.runtime.dispatch(act, "e1");
		const b = h.runtime.dispatch(act, "e1");
		h.log.push(`a=${await h.outcome(a)}`);
		await b;
		await h.flush();
		h.log.push(`items=${JSON.stringify(h.runtime.state.items)}`);
		expect(h.log).toEqual([
			"finally",
			"second run",
			"onError boom",
			"failure boom cancelled taken=true",
			"a=undefined",
			'items=["ok"]'
		]);
	});

	it("the entity removed: the parent's catch never runs, its finally does, and the failure is reported once", async () => {
		const h = world({
			$Id: "root",
			child: {
				$Id: "c"
			}
		});
		function* act(): IActionGenerator {
			try {
				yield* parallel(fails());
				h.log.push("after parallel");
			} catch (e) {
				h.log.push(`caught ${(e as Error).message}`);
			} finally {
				h.log.push("finally");
			}
		}
		function* remove(draft: any): IActionGenerator {
			draft.child = null;
		}
		const a = h.runtime.dispatch(act, "c");
		await h.runtime.dispatch(remove, "root");
		h.log.push(`a=${await h.outcome(a)}`);
		await h.flush();
		expect(h.log).toEqual([
			"finally",
			"diag action/unrouted-throw",
			"failure boom cancelled taken=false",
			"a=undefined"
		]);
	});

	it("parallelSettled, the entity removed: the parent's code after it never runs", async () => {
		const h = world({
			$Id: "root",
			child: {
				$Id: "c"
			}
		});
		function* act(): IActionGenerator {
			yield* parallelSettled(fails());
			h.log.push("after parallelSettled");
		}
		function* remove(draft: any): IActionGenerator {
			draft.child = null;
		}
		const a = h.runtime.dispatch(act, "c");
		await h.runtime.dispatch(remove, "root");
		h.log.push(`a=${await h.outcome(a)}`);
		await h.flush();
		expect(h.log).toEqual([
			"a=undefined"
		]);
	});

	it("a failing branch with a waiting sibling, the entity removed: the sibling closes, the parent's catch never runs, and the failure is reported once", async () => {
		const h = world({
			$Id: "root",
			child: {
				$Id: "c"
			}
		});
		function* waiter(): IActionGenerator {
			try {
				yield* wait("x");
			} finally {
				h.log.push("waiter finally");
			}
		}
		function* act(): IActionGenerator {
			try {
				yield* parallel(waiter(), fails());
			} catch (e) {
				h.log.push(`caught ${(e as Error).message}`);
			}
		}
		function* remove(draft: any): IActionGenerator {
			draft.child = null;
		}
		const a = h.runtime.dispatch(act, "c");
		await h.runtime.dispatch(remove, "root");
		h.log.push(`a=${await h.outcome(a)}`);
		await h.flush();
		expect(h.log).toEqual([
			"waiter finally",
			"diag action/unrouted-throw",
			"failure boom cancelled taken=false",
			"a=undefined"
		]);
	});

	it("dispose: the parent's code after the fan-out never runs, and its finally does", async () => {
		const h = world({
			$Id: "e1",
			items: [] as string[]
		});
		function* sync(draft: any): IActionGenerator {
			draft.items.push("a");
		}
		function* act(draft: any): IActionGenerator {
			try {
				yield* parallel(sync(draft));
				h.log.push("after parallel");
				draft.items.push("p");
			} finally {
				h.log.push("finally");
			}
		}
		const a = h.runtime.dispatch(act, "e1");
		h.runtime.dispose();
		h.log.push("disposed");
		h.log.push(`a=${await h.outcome(a)}`);
		await h.flush();
		h.log.push(`items=${JSON.stringify(h.runtime.state.items)}`);
		expect(h.log).toEqual([
			"disposed",
			"finally",
			"a=undefined",
			'items=["a"]'
		]);
	});
});

describe("a nested fan-out's failure and a sibling's failure answered in the same tick", () => {
	it("the nested failure wins: the parent catches it, and the sibling is stopped before its answer's wake runs", async () => {
		const h = world({
			$Id: "e1"
		});
		function* thrower(k: string): IActionGenerator {
			yield* wait(k);
			h.log.push(`resumed ${k}`);
			throw new Error(`boom ${k}`);
		}
		function* nested(): IActionGenerator {
			yield* parallel(thrower("x"));
		}
		function* act(): IActionGenerator {
			try {
				yield* parallel(nested(), thrower("y"));
			} catch (e) {
				h.log.push(`caught ${(e as Error).message}`);
			}
		}
		const a = h.runtime.dispatch(act, "e1");
		await h.flush();
		h.get("x").resolve(1);
		h.get("y").resolve(1);
		await a;
		await h.flush();
		expect(h.log).toEqual([
			"resumed x",
			"caught boom x"
		]);
	});
});

describe("a caught value whose symbol reads throw reaches the code that catches it", () => {
	function exotic(): Error {
		return new Proxy(new Error("exotic"), {
			get(target, key, receiver) {
				if (typeof key === "symbol" && key !== Symbol.toPrimitive && key !== Symbol.toStringTag) {
					throw new Error("symbol read");
				}
				return Reflect.get(target, key, receiver);
			}
		});
	}

	for (const [name, badFirst, waits] of [
		[
			"after a wait, the bad branch first",
			true,
			true
		],
		[
			"after a wait, the bad branch last",
			false,
			true
		],
		[
			"in its first slice",
			true,
			false
		]
	] as const) {
		it(`parallelSettled, thrown ${name}: the parent resumes with the value as that branch's outcome, and a later dispatch runs`, async () => {
			const h = world({
				$Id: "e1"
			});
			const thrown = exotic();
			function* bad(): IActionGenerator {
				if (waits) {
					yield* wait("x");
				}
				throw thrown;
			}
			function* good(): IActionGenerator<string> {
				yield* wait("y");
				return "y";
			}
			function* act(): IActionGenerator {
				const outcomes: IBranchOutcome<unknown>[] = badFirst
					? yield* parallelSettled(bad(), good())
					: yield* parallelSettled(good(), bad());
				const failed = outcomes.find((outcome) => !outcome.ok);
				h.log.push(`resumed ${outcomes.map((outcome) => outcome.ok).join(",")}`);
				h.log.push(`the outcome holds the thrown value: ${failed !== undefined && !failed.ok && failed.error === thrown}`);
			}
			function* after(): IActionGenerator {
				h.log.push("after ran");
			}
			const a = h.outcome(h.runtime.dispatch(act, "e1"));
			await h.flush();
			h.get("x").resolve(1);
			await h.flush();
			h.get("y").resolve(2);
			await h.flush();
			const b = h.outcome(h.runtime.dispatch(after, "e1"));
			await h.flush();
			h.log.push(`act ${await a}`, `after ${await b}`);
			expect(h.log).toEqual([
				`resumed ${badFirst ? "false,true" : "true,false"}`,
				"the outcome holds the thrown value: true",
				"after ran",
				"act undefined",
				"after undefined"
			]);
		});
	}

	for (const where of [
		"thrown by a parallel branch after a wait",
		"rejected by an effect in an action with no branches"
	] as const) {
		it(`${where}: the catch gets the value, and a later dispatch runs`, async () => {
			const h = world({
				$Id: "e1"
			});
			const thrown = exotic();
			function* bad(): IActionGenerator {
				yield* wait("x");
				throw thrown;
			}
			function* act(): IActionGenerator {
				try {
					if (where === "thrown by a parallel branch after a wait") {
						yield* parallel(bad(), wait("y"));
					} else {
						yield* wait("x");
					}
				} catch (error) {
					h.log.push(
						where === "thrown by a parallel branch after a wait"
							? `caught the thrown value: ${error === thrown}`
							: `caught a copy: ${error !== thrown && (error as Error).message === "exotic"}`
					);
				}
			}
			function* after(): IActionGenerator {
				h.log.push("after ran");
			}
			const a = h.outcome(h.runtime.dispatch(act, "e1"));
			await h.flush();
			if (where === "thrown by a parallel branch after a wait") {
				h.get("x").resolve(1);
			} else {
				h.get("x").reject(thrown);
			}
			await h.flush();
			const b = h.outcome(h.runtime.dispatch(after, "e1"));
			await h.flush();
			h.log.push(`act ${await a}`, `after ${await b}`);
			expect(h.log).toEqual([
				where === "thrown by a parallel branch after a wait" ? "caught the thrown value: true" : "caught a copy: true",
				"after ran",
				"act undefined",
				"after undefined"
			]);
		});
	}
});

describe("an action that returns a promise or a thenable fails with NonPlainDataError", () => {
	const fix = "is not plain: a promise or thenable at []. An action returns plain data and does its async work through effects";
	const returned: [
		string,
		() => unknown
	][] = [
		[
			"a resolved promise",
			() => Promise.resolve(5)
		],
		[
			"a rejected promise",
			() => Promise.reject(new Error("rejected"))
		],
		[
			"a thenable",
			() => ({
				// biome-ignore lint/suspicious/noThenProperty: the case under test
				then(resolve: (value: number) => void) {
					resolve(7);
				}
			})
		],
		[
			"a value whose then getter throws",
			() =>
				// biome-ignore lint/suspicious/noThenProperty: the case under test
				Object.defineProperty({}, "then", {
					get() {
						throw new Error("then read");
					}
				})
		]
	];

	async function watchingUnhandled(run: () => Promise<void>): Promise<string[]> {
		const node = (globalThis as any).process;
		const runnerListeners = node.listeners("unhandledRejection");
		const unhandled: string[] = [];
		const hear = (reason: unknown): void => {
			unhandled.push(String((reason as Error)?.message ?? reason));
		};
		node.removeAllListeners("unhandledRejection");
		node.on("unhandledRejection", hear);
		try {
			await run();
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			node.off("unhandledRejection", hear);
			for (const listener of runnerListeners) {
				node.on("unhandledRejection", listener);
			}
		}
		return unhandled;
	}

	for (const [name, make] of returned) {
		for (const where of [
			"in its first step",
			"after a yield"
		] as const) {
			it(`a root returning ${name} ${where}: the dispatch rejects, and onError and the failure event hear it`, async () => {
				const h = world({
					$Id: "e1"
				});
				let rejection: unknown;
				const unhandled = await watchingUnhandled(async () => {
					function* save(): IActionGenerator<unknown> {
						if (where === "after a yield") {
							yield* parallel();
						}
						return make();
					}
					await h.runtime.dispatch(save, "e1").catch((error: unknown) => {
						rejection = error;
					});
					await h.flush();
				});
				expect(rejection).toBeInstanceOf(NonPlainDataError);
				const message = `[treflex] action "save": the return value ${fix}`;
				expect((rejection as Error).message.startsWith(message)).toBe(true);
				expect(h.log.map((line) => line.replace(message, "<message>").replace(/: declare.*? it\./, ""))).toEqual([
					"onError <message>",
					"failure <message> errored taken=true"
				]);
				expect(unhandled).toEqual([]);
			});
		}

		it(`a parallel branch returning ${name}: the parent's catch sees it, and the branch ends errored`, async () => {
			const h = world({
				$Id: "e1"
			});
			const records: string[] = [];
			h.runtime.on("record", (record: any) => {
				if (record.Kind === "branch:end") {
					records.push(`branch:end ${record.Status} ${record.Error?.Name}`);
				}
			});
			const unhandled = await watchingUnhandled(async () => {
				function* returns(): IActionGenerator<unknown> {
					return make();
				}
				function* act(): IActionGenerator {
					try {
						yield* parallel(returns());
					} catch (error) {
						h.log.push(
							`caught ${(error as Error).name}: ${(error as Error).message.startsWith(`[treflex] a branch of action "act": the return value ${fix}`)}`
						);
					}
				}
				await h.runtime.dispatch(act, "e1");
				await h.flush();
			});
			expect(h.log).toEqual([
				"caught NonPlainDataError: true"
			]);
			expect(records).toEqual([
				"branch:end errored NonPlainDataError"
			]);
			expect(unhandled).toEqual([]);
		});

		it(`a parallelSettled branch returning ${name}: its outcome is { ok: false, error }`, async () => {
			const h = world({
				$Id: "e1"
			});
			const unhandled = await watchingUnhandled(async () => {
				function* returns(): IActionGenerator<unknown> {
					return make();
				}
				function* act(): IActionGenerator {
					const [outcome] = yield* parallelSettled(returns());
					h.log.push(`ok ${outcome!.ok}, ${outcome!.ok ? "" : (outcome!.error as Error).name}`);
				}
				await h.runtime.dispatch(act, "e1");
				await h.flush();
			});
			expect(h.log).toEqual([
				"ok false, NonPlainDataError"
			]);
			expect(unhandled).toEqual([]);
		});
	}
});

describe("parallelSettled hands back a branch refused before it waits, and the action is replaced in the same tick", () => {
	it("the refusal is registered at the branch's end, ahead of the stop, so action/refusal-swallowed is reported", async () => {
		const h = world(
			{
				$Id: "e1"
			},
			[
				"action/refusal-swallowed"
			]
		);
		let run = 0;
		function* br(draft: any): IActionGenerator {
			yield* ask(draft, {
				Path: "X"
			});
		}
		const act = latest(function* act(draft: any): IActionGenerator {
			if (++run > 1) {
				return;
			}
			const [outcome] = yield* parallelSettled(br(draft));
			h.log.push(`resumed ${outcome!.ok}`);
		});
		const a = h.runtime.dispatch(act, "e1");
		const b = h.runtime.dispatch(act, "e1");
		await a;
		await b;
		await h.flush();
		expect(h.log).toEqual([
			"diag action/refusal-swallowed"
		]);
	});
});
