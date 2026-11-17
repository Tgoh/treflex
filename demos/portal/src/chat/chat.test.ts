import type { IActionGenerator, IRuntime } from "treflex";
import type { IChatWait, IChatWaitFor } from "../backend/fakeBackend";
import type { IPortal } from "../portal/Portal";
import type { ITour } from "../tour/Tour";
import type { IConversation } from "./Conversation";
import { createRuntime, settled } from "treflex";
import { createSnapshot, restoreRuntime } from "treflex/snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFakeBackend, replyLetters, replyText, sendFails } from "../backend/fakeBackend";
import { followToast, getDefaultState, openApp, ROOT_ID, toast } from "../portal/Portal";
import { restoreBanner } from "../portal/restoreBanner";
import { announceDropped, registerReceivers } from "../portal/session";
import { tourHint } from "../portal/tourHints";
import { currentStep } from "../tour/Tour";
import { ChatReceiver, init, openConversation, rows, summary } from "./Chat";
import { ConversationReceiver, queueReply, send, typing } from "./Conversation";
import { retry, sendStatus } from "./Message";

const LINE = "cue:1";
const TEXT = replyText(LINE);
const LETTERS = replyLetters(LINE);

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function chatGate() {
	const open = new Set<IChatWaitFor["Kind"]>();
	const pending: {
		what: IChatWaitFor;
		resolve: () => void;
	}[] = [];
	const wait: IChatWait = (_ms, signal, what) => {
		if (open.has(what.Kind)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			pending.push({
				what,
				resolve
			});
			signal?.addEventListener("abort", () => reject(signal.reason), {
				once: true
			});
		});
	};
	const release = async (kind: IChatWaitFor["Kind"], count = 1): Promise<void> => {
		for (let i = 0; i < count; i++) {
			const index = pending.findIndex((p) => p.what.Kind === kind);
			if (index === -1) break;
			pending.splice(index, 1)[0].resolve();
			await flush();
		}
	};
	const allow = async (kind: IChatWaitFor["Kind"]): Promise<void> => {
		open.add(kind);
		for (const p of pending.filter((x) => x.what.Kind === kind)) {
			pending.splice(pending.indexOf(p), 1);
			p.resolve();
		}
		await flush();
	};
	return {
		wait,
		pending,
		release,
		allow
	};
}

const runtimes: IRuntime<IPortal>[] = [];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

const setup = (wait: IChatWait) => (runtime: IRuntime<IPortal>) => {
	registerReceivers(runtime);
	registerFakeBackend(runtime, {
		chatWait: wait
	});
};

async function chat(wait: IChatWait): Promise<IRuntime<IPortal>> {
	const runtime = createRuntime<IPortal>(getDefaultState(), {
		pauseTimers: true
	});
	setup(wait)(runtime);
	runtimes.push(runtime);
	await runtime.dispatch(init, "Chat");
	await flush();
	return runtime;
}

async function reload(before: IRuntime<IPortal>, wait: IChatWait): Promise<IRuntime<IPortal>> {
	const json = createSnapshot(before);
	before.dispose();
	const { runtime } = await restoreRuntime<IPortal>(json, {
		rootId: ROOT_ID,
		options: {
			pauseTimers: true
		},
		setup: setup(wait),
		repair: announceDropped
	});
	runtimes.push(runtime);
	await flush();
	return runtime;
}

const conversation = (runtime: IRuntime<IPortal>, key: string): IConversation =>
	runtime.state.Chat.Conversations.find((c) => c.Key === key)!;
const lastOf = (runtime: IRuntime<IPortal>, key: string) => conversation(runtime, key).Messages.at(-1)!;
const typingIn = (runtime: IRuntime<IPortal>, key: string) => runtime.processSelector(typing, () => conversation(runtime, key));
const statusOf = (runtime: IRuntime<IPortal>, key: string) => runtime.processSelector(sendStatus, () => lastOf(runtime, key));

async function cue(runtime: IRuntime<IPortal>, key: string, from = "priya", line = LINE): Promise<void> {
	await runtime.dispatch(queueReply, conversation(runtime, key).$Id, {
		From: from,
		Line: line
	});
	await flush();
}

describe("a teammate's reply", () => {
	it("shows them typing, then streams in letter by letter through the conversation's stream resource", async () => {
		const gate = chatGate();
		const runtime = await chat(gate.wait);
		const before = conversation(runtime, "launch").Messages.length;
		await cue(runtime, "launch");

		const row = runtime.resources(conversation(runtime, "launch").$Id).find((r) => r.Key === "Chat/Reply");
		expect(row?.ResumeFrom).toBe("Applied");
		expect(typingIn(runtime, "launch")).toBe("Priya is typing");
		expect(conversation(runtime, "launch").Messages).toHaveLength(before);

		await gate.release("typing");
		await gate.release("letter", 3);
		expect(typingIn(runtime, "launch")).toBe("");
		expect(lastOf(runtime, "launch")).toMatchObject({
			From: "priya",
			Text: "Pri",
			Streaming: true
		});
		expect(conversation(runtime, "launch").Applied).toBe(3);

		await gate.allow("letter");
		expect(lastOf(runtime, "launch")).toMatchObject({
			Text: TEXT,
			Streaming: false
		});
		expect(conversation(runtime, "launch").Reply).toBeNull();
		expect(runtime.resources(conversation(runtime, "launch").$Id)).toHaveLength(0);
	});

	it("carries on after a restore from the letter it had reached, into the same message", async () => {
		const gate = chatGate();
		const before = await chat(gate.wait);
		await cue(before, "launch");
		await gate.release("typing");
		await gate.release("letter", 10);
		expect(lastOf(before, "launch").Text).toBe("Pricing lo");
		const messageId = lastOf(before, "launch").$Id;
		const count = conversation(before, "launch").Messages.length;

		const after = chatGate();
		const runtime = await reload(before, after.wait);
		expect(after.pending.map((p) => p.what)).toEqual([
			{
				Kind: "letter",
				Conversation: "launch",
				Index: 10
			}
		]);
		expect(runtime.state.Chat.Restore?.Streams).toEqual([
			{
				Who: "Priya",
				Where: "#launch",
				Letters: 10
			}
		]);
		expect(restoreBanner(runtime.state)?.Back).toContain(
			"Priya's message in #launch, part-way through, and its stream reopened from the letter it had reached"
		);

		await after.release("letter");
		expect(lastOf(runtime, "launch").Text).toBe("Pricing loo");
		await after.allow("letter");
		expect(conversation(runtime, "launch").Messages).toHaveLength(count);
		expect(lastOf(runtime, "launch")).toMatchObject({
			$Id: messageId,
			Text: TEXT,
			Streaming: false
		});
	});

	it("starts over with typing when the restore caught them before the first letter", async () => {
		const before = await chat(chatGate().wait);
		await cue(before, "design");
		const after = chatGate();
		const runtime = await reload(before, after.wait);
		expect(after.pending.map((p) => p.what.Kind)).toEqual([
			"typing"
		]);
		expect(restoreBanner(runtime.state)?.Back).toContain("Priya was typing in #design, and the message's stream reopened from its row");
	});

	it("counts as unread where you aren't looking, and not where you are", async () => {
		const gate = chatGate();
		const runtime = await chat(gate.wait);
		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await flush();
		expect(runtime.state.Chat.OpenId).toBe(conversation(runtime, "launch").$Id);

		await gate.allow("typing");
		await gate.allow("letter");
		await cue(runtime, "launch");
		await cue(runtime, "design");
		expect(conversation(runtime, "launch").Unread).toBe(0);
		expect(conversation(runtime, "design").Unread).toBe(1);
		expect(runtime.processSelector(summary, () => runtime.state.Chat).Unread).toBe(1);

		await runtime.dispatch(openConversation, "Chat", conversation(runtime, "design").$Id);
		expect(conversation(runtime, "design").Unread).toBe(0);

		await runtime.dispatch(openApp, ROOT_ID, "trips");
		await flush();
		await cue(runtime, "design", "ana", "cue:5");
		expect(conversation(runtime, "design").Unread).toBe(1);

		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await flush();
		expect(runtime.state.Chat.OpenId).toBe(conversation(runtime, "design").$Id);
		expect(conversation(runtime, "design").Unread).toBe(0);
	});

	it("skips letters a chunk repeats from before the cursor", async () => {
		const gate = chatGate();
		const runtime = await chat(gate.wait);
		await cue(runtime, "launch");
		await gate.release("typing");
		await gate.release("letter", 3);
		const launch = conversation(runtime, "launch");
		expect(launch.Applied).toBe(3);
		await runtime.dispatch(
			ConversationReceiver.handle,
			launch.$Id,
			{
				Type: "Chat/Reply",
				Index: 1,
				Letters: LETTERS.slice(1, 4)
			},
			{
				publisher: {
					Id: launch.$Id
				}
			}
		);
		expect(lastOf(runtime, "launch").Text).toBe("Pric");
		expect(conversation(runtime, "launch").Applied).toBe(4);
	});

	it("shows typing… in place of the unread count on a conversation's row", async () => {
		const gate = chatGate();
		const runtime = await chat(gate.wait);
		await gate.allow("typing");
		await gate.allow("letter");
		await cue(runtime, "design", "priya", "cue:0");
		const row = () => runtime.processSelector(rows, () => runtime.state.Chat).Channels.find((r) => r.Name === "design")!;
		expect(row()).toMatchObject({
			Note: "",
			Badge: 1,
			Bold: true
		});

		const slow = chatGate();
		const typingRuntime = await chat(slow.wait);
		await slow.allow("letter");
		await cue(typingRuntime, "design", "priya", "cue:0");
		await slow.release("typing");
		await cue(typingRuntime, "design", "ana", "cue:5");
		await flush();
		const typingRow = typingRuntime.processSelector(rows, () => typingRuntime.state.Chat).Channels.find((r) => r.Name === "design")!;
		expect(typingRow).toMatchObject({
			Note: "typing…",
			Badge: 0,
			Bold: true
		});
	});

	it("waits behind the one streaming, and both finish in order across a restore", async () => {
		const gate = chatGate();
		const before = await chat(gate.wait);
		await cue(before, "launch", "priya", "cue:1");
		await cue(before, "launch", "marcus", "cue:7");
		await gate.release("typing");
		await gate.release("letter", 2);
		expect(conversation(before, "launch").Queue).toHaveLength(1);
		const count = conversation(before, "launch").Messages.length;

		const after = chatGate();
		const runtime = await reload(before, after.wait);
		await after.allow("typing");
		await after.allow("letter");
		const messages = conversation(runtime, "launch").Messages;
		expect(messages).toHaveLength(count + 1);
		expect(messages.at(-2)).toMatchObject({
			From: "priya",
			Text: replyText("cue:1")
		});
		expect(messages.at(-1)).toMatchObject({
			From: "marcus",
			Text: replyText("cue:7"),
			Streaming: false
		});
		expect(conversation(runtime, "launch").Reply).toBeNull();
		expect(conversation(runtime, "launch").Queue).toHaveLength(0);
	});
});

function* answerAndLeave(draft: ITour): IActionGenerator {
	draft.Started = true;
	draft.Answered = true;
	draft.CameBack = true;
}

describe("the tour's reload step", () => {
	it("names a streaming reply to watch, and ticks on the reload", async () => {
		const gate = chatGate();
		const before = await chat(gate.wait);
		await before.dispatch(answerAndLeave, "Tour");
		expect(before.processSelector(currentStep, () => before.state.Tour)).toBe(4);
		expect(before.processSelector(tourHint, () => before.state)).toEqual({
			Title: "Reload the page.",
			Text: "The session is saved in this browser. It comes back as you left it."
		});

		await cue(before, "design");
		expect(before.processSelector(tourHint, () => before.state)?.Text).toBe(
			"The session is saved in this browser. Priya is typing in #design, and a reload reopens the message's stream from its row."
		);
		await gate.release("typing");
		await gate.release("letter", 2);
		expect(before.processSelector(tourHint, () => before.state)?.Text).toBe(
			"The session is saved in this browser. Priya's message in #design carries on from the letter it reached."
		);
		const runtime = await reload(before, chatGate().wait);
		expect(runtime.state.Tour.Reloaded).toBe(true);
	});

	it("names a send the reload would cut off", async () => {
		const before = await chat(chatGate().wait);
		await before.dispatch(answerAndLeave, "Tour");
		await before.dispatch(send, conversation(before, "dm-ana").$Id, "Thursday works");
		await flush();
		expect(before.processSelector(tourHint, () => before.state)?.Text).toBe(
			"The session is saved in this browser. Your message to Ana Torres comes back as Didn't send, with Retry."
		);
		const runtime = await reload(before, chatGate().wait);
		expect(runtime.state.Tour.Reloaded).toBe(true);
	});
});

describe("the chat's times", () => {
	it("stamps today's history before the session started, so your messages come after it, and keeps the stamp across a restore", async () => {
		vi.useFakeTimers({
			toFake: [
				"Date"
			]
		});
		try {
			vi.setSystemTime(new Date(2026, 10, 16, 8, 15));
			const gate = chatGate();
			const before = await chat(gate.wait);
			const today = conversation(before, "launch").Messages.find((m) => m.Day === "Today")!;
			expect(today.At).toBe("08:03");
			await before.dispatch(send, conversation(before, "launch").$Id, "Morning");
			await flush();
			expect(lastOf(before, "launch").At).toBe("08:15");

			vi.setSystemTime(new Date(2026, 10, 16, 9, 40));
			const runtime = await reload(before, chatGate().wait);
			expect(conversation(runtime, "launch").Messages.find((m) => m.Day === "Today")?.At).toBe("08:03");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the scripted teammate posts", () => {
	it("takes each cue once, in its conversation, then removes the cue timer", async () => {
		const runtime = await chat(chatGate().wait);
		expect(runtime.timers(runtime.state.Chat).map((row) => row.Key)).toEqual([
			"Chat/Cue"
		]);
		for (let i = 0; i < 9; i++) {
			await runtime.dispatch(
				ChatReceiver.handle,
				"Chat",
				{
					Type: "Chat/Cue"
				},
				{
					publisher: {
						Id: "Chat"
					}
				}
			);
			await flush();
		}
		expect(runtime.state.Chat.Cue).toBe(8);
		expect(runtime.timers(runtime.state.Chat)).toHaveLength(0);
		const cued = (key: string) => {
			const c = conversation(runtime, key);
			return [
				c.Reply?.Line,
				...c.Queue.map((q) => q.Line)
			].filter(Boolean);
		};
		expect(cued("design")).toEqual([
			"cue:0",
			"cue:5"
		]);
		expect(cued("launch")).toEqual([
			"cue:1",
			"cue:7"
		]);
		expect(cued("dm-jonah")).toEqual([
			"cue:2"
		]);
		expect(cued("dm-marcus")).toEqual([
			"cue:3"
		]);
		expect(cued("support")).toEqual([
			"cue:4"
		]);
		expect(cued("dm-priya")).toEqual([
			"cue:6"
		]);
	});
});

describe("the finished-while-away toast for the chat", () => {
	it("shows a reply that finished in a conversation you aren't viewing, with what it said", async () => {
		const gate = chatGate();
		const runtime = await chat(gate.wait);
		await gate.allow("typing");
		await gate.allow("letter");
		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await flush();

		await cue(runtime, "launch");
		expect(runtime.processSelector(toast, () => runtime.state)).toBeNull();

		await cue(runtime, "design", "priya", "cue:0");
		const shown = runtime.processSelector(toast, () => runtime.state)!;
		expect(shown.Title).toBe("Priya Shah in #design");
		expect(lastOf(runtime, "design").Text.startsWith(shown.Text.replace(/…$/, ""))).toBe(true);
		expect(shown.Link).toBe("Open #design →");

		await runtime.dispatch(followToast, ROOT_ID);
		await flush();
		expect(runtime.state.Chat.OpenId).toBe(conversation(runtime, "design").$Id);
		expect(conversation(runtime, "design").Unread).toBe(0);
		expect(runtime.processSelector(toast, () => runtime.state)).toBeNull();
	});

	it("goes once you open the conversation yourself, and doesn't come back after you move on", async () => {
		const gate = chatGate();
		const runtime = await chat(gate.wait);
		await gate.allow("typing");
		await gate.allow("letter");
		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await flush();
		await cue(runtime, "design", "priya", "cue:0");
		expect(runtime.processSelector(toast, () => runtime.state)).not.toBeNull();

		await runtime.dispatch(openConversation, "Chat", conversation(runtime, "design").$Id);
		await flush();
		expect(runtime.processSelector(toast, () => runtime.state)).toBeNull();
		await runtime.dispatch(openConversation, "Chat", conversation(runtime, "launch").$Id);
		await runtime.dispatch(openApp, ROOT_ID, "aquarium");
		await flush();
		expect(runtime.processSelector(toast, () => runtime.state)).toBeNull();
	});

	it("names a teammate's direct message as one to you, the way its toast does", async () => {
		const gate = chatGate();
		const before = await chat(gate.wait);
		await cue(before, "dm-jonah", "jonah", "cue:2");
		await gate.release("typing");
		await gate.release("letter", 2);
		const after = chatGate();
		const runtime = await reload(before, after.wait);
		expect(restoreBanner(runtime.state)?.Back).toContain(
			"Jonah's message to you, part-way through, and its stream reopened from the letter it had reached"
		);
		await after.allow("letter");
		expect(runtime.processSelector(toast, () => runtime.state)?.Title).toBe("Jonah Okafor sent you a message");
	});
});

describe("a message you send", () => {
	it("says Sending… while the post is in flight, and a teammate answers once it is sent", async () => {
		const gate = chatGate();
		const runtime = await chat(gate.wait);
		await runtime.dispatch(send, conversation(runtime, "dm-priya").$Id, "  Morning!  ");
		await flush();
		expect(lastOf(runtime, "dm-priya")).toMatchObject({
			From: "me",
			Text: "Morning!",
			Sent: false
		});
		expect(statusOf(runtime, "dm-priya")).toBe("sending");

		await gate.release("post");
		expect(statusOf(runtime, "dm-priya")).toBe("");
		expect(lastOf(runtime, "dm-priya").Sent).toBe(true);
		expect(conversation(runtime, "dm-priya").Reply?.From).toBe("priya");
	});

	it("fails now and then, deterministically, and says Didn't send until Retry sends it", async () => {
		expect(
			sendFails({
				Type: "Backend/PostMessage",
				Conversation: "launch",
				Text: "x",
				Number: 1,
				Attempt: 0
			})
		).toBe(true);
		const gate = chatGate();
		const runtime = await chat(gate.wait);
		await gate.allow("post");
		const launch = conversation(runtime, "launch").$Id;
		await runtime.dispatch(send, launch, "First");
		await flush();
		await runtime.dispatch(send, launch, "Second");
		await flush();

		expect(lastOf(runtime, "launch").Text).toBe("Second");
		expect(statusOf(runtime, "launch")).toBe("failed");
		expect(runtime.processSelector(summary, () => runtime.state.Chat).Line).toBe("1 message didn't send");

		await runtime.dispatch(retry, lastOf(runtime, "launch").$Id);
		await flush();
		expect(statusOf(runtime, "launch")).toBe("");
		expect(lastOf(runtime, "launch").Attempts).toBe(2);
	});

	it("comes back from a restore as Didn't send when it was in flight, and Retry sends it", async () => {
		const before = await chat(chatGate().wait);
		await before.dispatch(send, conversation(before, "launch").$Id, "Are we still doing the annual discount at 20%?");
		await flush();
		expect(statusOf(before, "launch")).toBe("sending");

		const after = chatGate();
		const runtime = await reload(before, after.wait);
		expect(statusOf(runtime, "launch")).toBe("failed");
		expect(runtime.state.Chat.Restore?.Unsent).toEqual([
			"#launch"
		]);
		const banner = restoreBanner(runtime.state)!;
		expect(banner.Lost).toEqual([
			"Your message to #launch, which was sending",
			"It came back as Didn't send, with Retry"
		]);

		await runtime.dispatch(retry, lastOf(runtime, "launch").$Id);
		await flush();
		expect(statusOf(runtime, "launch")).toBe("sending");
		await after.release("post");
		expect(statusOf(runtime, "launch")).toBe("");
		expect(restoreBanner(runtime.state)!.Lost).toEqual(banner.Lost);
	});

	it("doesn't call a message that had already failed one the reload cut off", async () => {
		const gate = chatGate();
		const before = await chat(gate.wait);
		await gate.allow("post");
		const launch = conversation(before, "launch").$Id;
		await before.dispatch(send, launch, "First");
		await flush();
		await before.dispatch(send, launch, "Second");
		await flush();
		expect(statusOf(before, "launch")).toBe("failed");

		const runtime = await reload(before, chatGate().wait);
		expect(statusOf(runtime, "launch")).toBe("failed");
		expect(runtime.state.Chat.Restore?.Unsent).toEqual([]);
		expect(restoreBanner(runtime.state)?.Lost.some((line) => line.startsWith("Your message to"))).toBe(false);
	});

	it("sends on Retry the message built to fail, when a restore caught it in flight", async () => {
		const gate = chatGate();
		const before = await chat(gate.wait);
		const launch = conversation(before, "launch").$Id;
		await before.dispatch(send, launch, "First");
		await flush();
		await gate.release("post");
		expect(lastOf(before, "launch").Sent).toBe(true);
		await before.dispatch(send, launch, "Second");
		await flush();
		const second = {
			...lastOf(before, "launch")
		};
		expect(
			sendFails({
				Type: "Backend/PostMessage",
				Conversation: "launch",
				Text: second.Text,
				Number: second.Number,
				Attempt: 0
			})
		).toBe(true);
		expect(statusOf(before, "launch")).toBe("sending");

		const after = chatGate();
		const runtime = await reload(before, after.wait);
		const restored = () => conversation(runtime, "launch").Messages.find((m) => m.$Id === second.$Id)!;
		expect(runtime.processSelector(sendStatus, restored)).toBe("failed");

		await runtime.dispatch(retry, second.$Id);
		await flush();
		await after.release("post");
		expect(restored().Sent).toBe(true);
		expect(runtime.processSelector(sendStatus, restored)).toBe("");
	});
});
