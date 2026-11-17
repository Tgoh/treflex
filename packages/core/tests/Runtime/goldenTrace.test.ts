import type { IActionGenerator } from "../../src/Types/IAction";
import type { IAskId } from "../../src/Types/IAskId";
import type { IReceiver } from "../../src/Types/IReceiver";
import type { IRecord, IRecordExtras } from "../../src/Types/IRecord";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { publish as publishTyped } from "../../src/Effects/publish";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { pendingAsks } from "../../src/Runtime/pendingAsks";
import { receiver as receiverTyped } from "../../src/Runtime/receiver";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { settled } from "../../src/Testing/createTestRuntime";
import { rootSetState } from "../testHelpers";

const publish = publishTyped as unknown as (topic: string) => Generator<any, void, any>;
const receiver = receiverTyped as unknown as <
	_T extends {
		$Id: string;
	}
>(
	id: string
) => (cases: Record<string, any>) => IReceiver<any, never>;

type IChild = {
	$Id: string;
	Value: string;
};
type IRoot = {
	$Id: string;
	Children: IChild[];
};

function fmt(v: unknown): string {
	if (v === undefined) {
		return "undefined";
	}
	if (v === null) {
		return "null";
	}
	if (typeof v === "function") {
		return "[fn]";
	}
	if (typeof v === "object") {
		return Array.isArray(v) ? "[array]" : "[object]";
	}
	return JSON.stringify(v);
}

function createTraceCollector(runtime: { on: (name: any, handler: any) => () => void }) {
	const lines: string[] = [];
	const idMap = new Map<string, string>();
	const sym = (id: unknown): string => {
		const key = String(id);
		let mapped = idMap.get(key);
		if (!mapped) {
			mapped = `#${idMap.size + 1}`;
			idMap.set(key, mapped);
		}
		return mapped;
	};
	const effectBySeq = new Map<number, string>();
	const askIds = new Map<string, string>();
	const askSym = (id: unknown): string => {
		const key = String(id);
		let mapped = askIds.get(key);
		if (!mapped) {
			mapped = `ask-${askIds.size + 1}`;
			askIds.set(key, mapped);
		}
		return mapped;
	};
	const name = (actionName: string | null): string => {
		return actionName ?? "(anonymous)";
	};

	// Exhaustive over the record union: an unknown kind prints raw and fails the
	// lock.
	runtime.on("record", (record: IRecord, live?: IRecordExtras) => {
		switch (record.Kind) {
			case "action:start":
				lines.push(
					`action:start ${name(record.Name ?? record.Label)} action=${sym(record.ActionId)} entity=${record.EntityId} ` +
						`path=${record.Path.join("/")}`
				);
				break;
			case "action:end": {
				const tail =
					record.Status === "completed"
						? ` result=${fmt(live?.result)}`
						: record.Status === "errored"
							? ` error=${fmt((live?.error as Error)?.message)}`
							: "";
				lines.push(`action:end action=${sym(record.ActionId)} status=${record.Status}${tail}`);
				break;
			}
			case "step":
				lines.push(
					`step action=${sym(record.ActionId)} branch=${sym(record.BranchId)} ` +
						record.Changes.map((c) => `${c.Path.join(".")}:${fmt(c.Prev)}->${fmt(c.Value)}`).join(" ")
				);
				break;
			case "effect":
				effectBySeq.set(record.Seq, record.Type);
				lines.push(`effect ${record.Type} action=${sym(record.ActionId)} branch=${sym(record.BranchId)}`);
				break;
			case "response": {
				const type = effectBySeq.get(record.ForSeq) ?? "?";
				const tail = "Error" in record ? ` error=${fmt((live?.error as Error)?.message)}` : ` result=${fmt(live?.result)}`;
				lines.push(`response ${type}${tail}`);
				break;
			}
			case "branch:start":
				lines.push(`branch:start action=${sym(record.ActionId)} branch=${sym(record.BranchId)} parent=${sym(record.ParentBranchId)}`);
				break;
			case "branch:end":
				lines.push(
					`branch:end action=${sym(record.ActionId)} branch=${sym(record.BranchId)} status=${record.Status} ` +
						`duration=${live?.duration !== undefined ? "live" : "none"}`
				);
				break;
			case "table":
				lines.push(
					record.Table === "asks"
						? `table asks ${askSym(record.AskId)} ${record.Value ? "set" : "cleared"}`
						: `table ${record.Table} ${record.Key} owner=${record.OwnerId} ${record.Value ? "set" : "cleared"}`
				);
				break;
			case "message:deliver":
				lines.push(`message:deliver ${record.Topic} publisher=${record.PublisherId} recipients=${record.RecipientIds.join(",")}`);
				break;
			case "receiver:error":
				lines.push(`receiver:error ${record.Topic} recipient=${record.RecipientId} error=${fmt((live?.error as Error)?.message)}`);
				break;
			case "entity:dispose":
				lines.push(`entity:dispose ${record.EntityId} path=${record.Path.join("/")}`);
				break;
			case "ask:answer":
				lines.push(`ask:answer ${askSym(record.AskId)} owner=${record.OwnerId}`);
				break;
			case "ask:abandon":
				lines.push(`ask:abandon ${askSym(record.AskId)} owner=${record.OwnerId} reason=${record.Reason}`);
				break;
			default:
				lines.push((record as IRecord).Kind);
				break;
		}
	});

	return lines;
}

const GOLDEN = [
	"action:start mutateAndEcho action=#1 entity=child-1 path=root/child-1",
	'step action=#1 branch=#1 Value:""->"start"',
	"effect echo action=#1 branch=#1",
	'response echo result="ok"',
	'step action=#1 branch=#1 Value:"start"->"ok"',
	"action:end action=#1 status=completed result=undefined",
	"action:start splitParallel action=#2 entity=child-1 path=root/child-1",
	"effect parallel action=#2 branch=#2",
	"branch:start action=#2 branch=#3 parent=#2",
	"effect echo action=#2 branch=#3",
	"branch:start action=#2 branch=#4 parent=#2",
	"effect echo action=#2 branch=#4",
	'response echo result="a"',
	"branch:end action=#2 branch=#3 status=completed duration=live",
	'response echo result="b"',
	"branch:end action=#2 branch=#4 status=completed duration=live",
	"response parallel result=[array]",
	'step action=#2 branch=#2 Value:"ok"->"a+b"',
	"action:end action=#2 status=completed result=undefined",
	"action:start settleBoth action=#5 entity=child-1 path=root/child-1",
	"effect parallelSettled action=#5 branch=#5",
	"branch:start action=#5 branch=#6 parent=#5",
	"effect echo action=#5 branch=#6",
	"branch:start action=#5 branch=#7 parent=#5",
	"branch:end action=#5 branch=#7 status=errored duration=live",
	'response echo result="w"',
	"branch:end action=#5 branch=#6 status=completed duration=live",
	"response parallelSettled result=[array]",
	'step action=#5 branch=#5 Value:"a+b"->"w"',
	"action:end action=#5 status=completed result=undefined",
	"action:start setup action=#8 entity=root path=root",
	'step action=#8 branch=#8 $Receiver:undefined->"GoldenReceiver"',
	"action:end action=#8 status=completed result=undefined",
	"action:start firePing action=#9 entity=child-1 path=root/child-1",
	"effect publish action=#9 branch=#9",
	"message:deliver golden/Ping publisher=child-1 recipients=root",
	"action:start GoldenReceiver action=#10 entity=root path=root",
	"response publish result=undefined",
	"effect echo action=#10 branch=#10",
	"action:end action=#9 status=completed result=undefined",
	'response echo result="pong"',
	"action:end action=#10 status=completed result=undefined",
	"action:start waitForever action=#11 entity=child-2 path=root/child-2",
	"effect wait action=#11 branch=#11",
	"action:start removeChild2 action=#12 entity=root path=root",
	"entity:dispose child-2 path=root/child-2",
	"step action=#12 branch=#12 Children:[array]->[array]",
	"action:end action=#12 status=completed result=undefined",
	"action:end action=#11 status=cancelled",
	"action:start boom action=#13 entity=root path=root",
	"step action=#13 branch=#13 Boomed:undefined->true",
	'action:end action=#13 status=errored error="boom"',
	"action:start openGolden action=#14 entity=root path=root",
	"effect ask action=#14 branch=#14",
	"table asks ask-1 set",
	"action:start answerGolden action=#15 entity=child-1 path=root/child-1",
	"effect answer action=#15 branch=#15",
	"table asks ask-1 cleared",
	"ask:answer ask-1 owner=child-1",
	"response answer result=undefined",
	'response ask result="done"',
	'step action=#14 branch=#14 Answered:undefined->"done"',
	"action:end action=#15 status=completed result=undefined",
	"action:end action=#14 status=completed result=undefined",
	"action:start latestAsker action=#16 entity=root path=root",
	"effect ask action=#16 branch=#16",
	"table asks ask-2 set",
	"action:start latestAsker action=#17 entity=root path=root",
	"table asks ask-2 cleared",
	"ask:abandon ask-2 owner=child-1 reason=cancelled",
	"action:end action=#17 status=completed result=undefined",
	"action:end action=#16 status=cancelled",
	"action:start stopsSibling action=#18 entity=child-1 path=root/child-1",
	"effect parallel action=#18 branch=#18",
	"branch:start action=#18 branch=#19 parent=#18",
	"effect wait action=#18 branch=#19",
	"branch:start action=#18 branch=#20 parent=#18",
	"effect echo action=#18 branch=#20",
	'response echo result="f"',
	"branch:end action=#18 branch=#20 status=errored duration=live",
	"branch:end action=#18 branch=#19 status=cancelled duration=live",
	'response parallel error="branch boom"',
	"action:end action=#18 status=completed result=undefined"
];

describe("golden trace: the record stream is locked", () => {
	it("appends the exact ordered record sequence for the scripted scenario", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRoot>(
					{
						$Id: "root",
						Children: [
							{
								$Id: "child-1",
								Value: ""
							},
							{
								$Id: "child-2",
								Value: ""
							}
						]
					},
					{
						onError: () => {}
					}
				);

				runtime.registerImplementation("echo", (e: any) => e.Payload);

				let waitStarted!: () => void;
				const waiting = new Promise<void>((r) => {
					waitStarted = r;
				});
				runtime.registerImplementation("wait", (_e: any, action: any) => {
					waitStarted();
					return new Promise((_resolve, reject) => {
						action?.signal.addEventListener("abort", () => {
							reject(new DOMException("aborted", "AbortError"));
						});
					});
				});

				const GoldenReceiver = receiver<IRoot>("GoldenReceiver")({
					"golden/Ping": function* (): IActionGenerator {
						yield {
							Type: "echo",
							Payload: "pong"
						};
					}
				});
				runtime.registerReceiver(GoldenReceiver);

				const lines = createTraceCollector(runtime);

				function* mutateAndEcho(draft: IChild): IActionGenerator {
					draft.Value = "start";
					const r: string = yield {
						Type: "echo",
						Payload: "ok"
					};
					draft.Value = r;
				}

				function* leg(payload: string): IActionGenerator<string> {
					yield {
						Type: "echo",
						Payload: payload
					};
					return payload;
				}
				function* splitParallel(draft: IChild): IActionGenerator {
					const results: string[] = yield* parallel(leg("a"), leg("b"));
					draft.Value = results.join("+");
				}

				function* worker(): IActionGenerator<string> {
					const r: string = yield {
						Type: "echo",
						Payload: "w"
					};
					return r;
				}
				function* refuse(): IActionGenerator<string> {
					throw new Error("refused");
				}
				function* settleBoth(draft: IChild): IActionGenerator {
					const [done, refused] = yield* parallelSettled(worker(), refuse());
					draft.Value = done.ok && !refused.ok ? done.value : "";
				}

				function* setup(draft: IRoot): IActionGenerator {
					bind(draft, GoldenReceiver);
				}
				function* firePing(_draft: IChild): IActionGenerator {
					yield* publish("golden/Ping");
				}

				function* waitForever(_draft: IChild): IActionGenerator {
					yield {
						Type: "wait"
					};
				}

				function* boom(draft: IRoot): IActionGenerator {
					(
						draft as unknown as {
							Boomed: boolean;
						}
					).Boomed = true;
					throw new Error("boom");
				}

				function* openGolden(draft: IRoot) {
					const choice = yield* open(
						ask<string>(draft.Children[0]!, {
							Path: "Golden"
						})
					);
					(
						draft as unknown as {
							Answered: string | undefined;
						}
					).Answered = choice;
				}

				function* answerGolden(draft: IChild): IActionGenerator {
					yield* answer((yield* pendingAsks(draft))[0]!.Id as IAskId<string>, "done");
				}

				const askLatest = latest(function* latestAsker(_draft: IRoot, asks: boolean) {
					if (asks) {
						yield* open(
							ask<string>("child-1", {
								Path: "Golden/Cancelled"
							})
						);
					}
				});

				function* failsAfterEcho(): IActionGenerator {
					yield {
						Type: "echo",
						Payload: "f"
					};
					throw new Error("branch boom");
				}
				function* waitsForever(): IActionGenerator {
					yield {
						Type: "wait"
					};
				}
				function* stopsSibling(_draft: IChild): IActionGenerator {
					try {
						yield* parallel(waitsForever(), failsAfterEcho());
					} catch {}
				}

				const child1SetState = sliceSetState(rootSetState(runtime), (x: IRoot) => x.Children[0]);
				const child2SetState = sliceSetState(rootSetState(runtime), (x: IRoot) => x.Children[1]);

				await runtime.processAction(
					mutateAndEcho,
					() => runtime.state as any,
					child1SetState,
					() => "child-1"
				);
				await runtime.processAction(
					splitParallel,
					() => runtime.state as any,
					child1SetState,
					() => "child-1"
				);
				await runtime.processAction(
					settleBoth,
					() => runtime.state as any,
					child1SetState,
					() => "child-1"
				);
				await runtime.processAction(
					setup,
					() => runtime.state as any,
					rootSetState(runtime),
					() => "root"
				);
				await runtime.processAction(
					firePing,
					() => runtime.state as any,
					child1SetState,
					() => "child-1"
				);
				await settled();

				const waitPromise = runtime.processAction(
					waitForever,
					() => runtime.state as any,
					child2SetState,
					() => "child-2"
				);
				await waiting;
				await runtime.processAction(
					function* removeChild2(draft: IRoot): IActionGenerator {
						draft.Children = draft.Children.filter((c) => c.$Id !== "child-2");
					},
					() => runtime.state as any,
					rootSetState(runtime),
					() => "root"
				);
				await waitPromise;

				await expect(
					runtime.processAction(
						boom,
						() => runtime.state as any,
						rootSetState(runtime),
						() => "root"
					)
				).rejects.toThrow("boom");

				const askingPromise = runtime.processAction(
					openGolden,
					() => runtime.state as any,
					rootSetState(runtime),
					() => "root"
				);
				await settled();
				await runtime.processAction(
					answerGolden,
					() => runtime.state as any,
					child1SetState,
					() => "child-1"
				);
				await askingPromise;

				const stoppedAsker = runtime.processAction(
					askLatest,
					() => runtime.state as any,
					rootSetState(runtime),
					() => "root",
					true
				);
				await settled();
				await runtime.processAction(
					askLatest,
					() => runtime.state as any,
					rootSetState(runtime),
					() => "root",
					false
				);
				await stoppedAsker;
				await settled();

				await runtime.processAction(
					stopsSibling,
					() => runtime.state as any,
					child1SetState,
					() => "child-1"
				);
				await settled();

				expect(lines).toEqual(GOLDEN);
			} finally {
				dispose();
			}
		});
	});
});
