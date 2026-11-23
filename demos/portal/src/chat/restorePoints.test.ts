import type { IRuntime } from "treflex";
import type { IDifferentialStep, IStateDifference } from "treflex/snapshot";
import type { IPortal } from "../portal/Portal";
import type { IChatRestore } from "./Chat";
import { differentialRestore, dispatchStep, settleStep } from "treflex/snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type IPostAnswer, postMessage } from "../backend/backend";
import { answerLine } from "../backend/chatScript";
import { registerFakeBackend } from "../backend/fakeBackend";
import { getDefaultState, init, ROOT_ID } from "../portal/Portal";
import { registerReceivers, repairRestore } from "../portal/session";
import { send } from "./Conversation";
import { conversationLabel } from "./directory";
import { retry } from "./Message";

const launch = (runtime: IRuntime<IPortal>) => runtime.state.Chat.Conversations.find((c) => c.Key === "launch")!;

const UNSENT = /^(Chat\.Conversations\[\d+\])\.Messages\[\d+\]\.Sent$/;

const SENT: IPostAnswer = {
	Sent: true
};

const NOT_SENT: IPostAnswer = {
	Sent: false,
	Message: "the server didn't answer"
};

const isNotice = (difference: IStateDifference) => difference.path === "Restore" || difference.path.endsWith(".Restore");

beforeEach(() => {
	vi.useFakeTimers({
		toFake: [
			"Date"
		]
	});
	vi.setSystemTime(new Date(2026, 10, 18, 9, 30));
});

afterEach(() => {
	vi.useRealTimers();
});

it("announces each send a restore drops, and loses only the sends that would have gone through", async () => {
	const script: IDifferentialStep<IPortal>[] = [
		dispatchStep(init, ROOT_ID),
		dispatchStep(send, (runtime) => launch(runtime).$Id, [
			"Morning all"
		]),
		settleStep(postMessage, {
			value: SENT
		}),
		dispatchStep(send, (runtime) => launch(runtime).$Id, [
			"Is the build green?"
		]),
		settleStep(postMessage, {
			value: NOT_SENT
		}),
		dispatchStep(retry, (runtime) => launch(runtime).Messages.at(-1)!.$Id),
		settleStep(postMessage, {
			value: SENT
		})
	];
	const report = await differentialRestore(
		{
			seed: getDefaultState(),
			setup: (runtime) => {
				registerReceivers(runtime);
				registerFakeBackend(runtime);
			},
			repair: repairRestore,
			hold: [
				postMessage
			]
		},
		script
	);

	const wouldHaveFailed = (after: number) =>
		(
			script[after] as {
				value?: unknown;
			}
		).value === NOT_SENT;
	expect(new Set(report.points.map((point) => wouldHaveFailed(point.after)))).toEqual(
		new Set([
			true,
			false
		])
	);
	for (const point of report.points) {
		const state = point.differences.state ?? [];
		expect(point.result.dropped.map((d) => d.name)).toEqual([
			"Chat/Deliver"
		]);
		expect((state.find((d) => d.path === "Chat.Restore")?.actual as IChatRestore | undefined)?.Unsent).toEqual([
			conversationLabel("launch")
		]);
		expect(Object.keys(point.differences)).toEqual([
			"state"
		]);

		const lost = state.filter((d) => !isNotice(d));
		if (wouldHaveFailed(point.after)) {
			expect(lost).toEqual([]);
			continue;
		}
		const unsent = lost.find((d) => UNSENT.test(d.path));
		const conversation = UNSENT.exec(unsent?.path ?? "")?.[1];
		const answers = lost.find((d) => d.path === `${conversation}.Answers`)?.expected as number;
		const cue = lost.find((d) => d.path.startsWith(`${conversation}.Queue[`));
		expect(lost).toEqual([
			{
				path: unsent?.path,
				expected: true,
				actual: false
			},
			{
				path: `${conversation}.Answers`,
				expected: answers,
				actual: answers - 1
			},
			{
				path: cue?.path,
				expected: {
					From: expect.any(String),
					Line: answerLine("launch", answers - 1)
				},
				actual: undefined
			}
		]);
	}
});
