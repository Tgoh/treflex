import type { IActionGenerator, IEntity, IReceiverId, ISelectorGenerator } from "treflex";
import type { IFinished } from "../portal/topics";
import type { IMessage } from "./Message";
import { entity, isEnded, openResource, publish, publishToNearest, receiver, start } from "treflex";
import { chatTime } from "../backend/backend";
import { answerLine } from "../backend/chatScript";
import { conversationInfo, conversationLabel, firstName, person } from "./directory";
import { deliver } from "./Message";

declare module "treflex" {
	interface IMessageRegistry {
		"Chat/Arrived": {};
	}
}

export interface IReplyCue {
	From: string;
	Line: string;
	/** The percent off trips of the travel voucher the reply carries, if it carries one. */
	Voucher?: number;
}

export interface IReply extends IReplyCue {
	MessageId: string | null;
}

export interface IConversation extends IEntity {
	readonly $Receiver?: IReceiverId<IConversation>;
	Key: string;
	Messages: IMessage[];
	Unread: number;
	Sends: number;
	Answers: number;
	Queue: IReplyCue[];
	/** The teammate reply being streamed, one at a time per conversation. */
	Reply: IReply | null;
	/** How many of the reply's letters are in its message: the stream's resume cursor. */
	Applied: number;
}

export function newConversation(key: string, messages: IMessage[]): Omit<IConversation, "$Id"> {
	return {
		$Receiver: ConversationReceiver.Id,
		Key: key,
		Messages: messages,
		Unread: 0,
		Sends: 0,
		Answers: 0,
		Queue: [],
		Reply: null,
		Applied: 0
	};
}

/** The text `send` would post, or null when it would post nothing. */
export function sendable(text: string): string | null {
	const trimmed = text.trim();
	return trimmed === "" ? null : trimmed;
}

export function* send(draft: IConversation, text: string): IActionGenerator {
	const trimmed = sendable(text);
	if (trimmed === null) return;
	const at = yield* chatTime();
	const message = yield* entity<IMessage>({
		Conversation: draft.Key,
		From: "me",
		Day: "Today",
		At: at,
		Text: trimmed,
		Streaming: false,
		Sent: false,
		Number: draft.Sends,
		Attempts: 0
	});
	draft.Sends++;
	draft.Messages.push(message);
	yield* start(deliver, message);
}

export function* queueReply(draft: IConversation, cue: IReplyCue): IActionGenerator {
	draft.Queue.push({
		...cue
	});
	if (draft.Reply === null) yield* nextReply(draft);
}

function* nextReply(draft: IConversation): IActionGenerator {
	const cue = draft.Queue.shift();
	if (!cue) return;
	draft.Reply = {
		...cue,
		MessageId: null
	};
	draft.Applied = 0;
	yield* openResource(
		draft,
		"Chat/Reply",
		ConversationReceiver,
		{
			Type: "Chat/Stream",
			Conversation: draft.Key,
			From: cue.From,
			Line: cue.Line
		},
		{
			ResumeFrom: "Applied"
		}
	);
}

export const actions = {
	send
};

function excerpt(text: string): string {
	if (text.length <= 96) return text;
	const cut = text.slice(0, 96);
	return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

export function replyFinished(conversation: IConversation, message: IMessage): IFinished {
	const info = conversationInfo(conversation.Key);
	const channel = info.Kind === "channel";
	return {
		App: "chat",
		Target: conversation.$Id,
		Title: channel ? `${person(message.From).Name} in ${conversationLabel(info.Key)}` : `${person(message.From).Name} sent you a message`,
		Text: excerpt(message.Text),
		Link: channel ? `Open ${conversationLabel(info.Key)} →` : "Open the conversation →",
		...(message.Voucher === undefined
			? {}
			: {
					Voucher: true
				})
	};
}

function* finishReply(draft: IConversation, completed: boolean): IActionGenerator {
	const reply = draft.Reply;
	draft.Reply = null;
	draft.Applied = 0;
	const message = reply ? draft.Messages.find((m) => m.$Id === reply.MessageId) : undefined;
	if (message) {
		message.Streaming = false;
		if (completed) yield* publish("Portal/Finished", replyFinished(draft, message));
	}
	yield* nextReply(draft);
}

function replier(draft: IConversation): string {
	const info = conversationInfo(draft.Key);
	return info.Members[draft.Answers % info.Members.length];
}

export const ConversationReceiver = receiver<IConversation>("ConversationReceiver")({
	*"Chat/Reply"(draft, e) {
		if (isEnded(e)) {
			yield* finishReply(draft, e.$Ended.Reason === "done");
			return;
		}
		const reply = draft.Reply;
		if (!reply) return;
		const fresh = e.Letters.slice(Math.max(0, draft.Applied - e.Index)).join("");
		if (fresh === "") return;
		draft.Applied = e.Index + e.Letters.length;
		const current = draft.Messages.find((m) => m.$Id === reply.MessageId);
		if (current) {
			current.Text += fresh;
			return;
		}
		const at = yield* chatTime();
		const message = yield* entity<IMessage>({
			Conversation: draft.Key,
			From: reply.From,
			Day: "Today",
			At: at,
			Text: fresh,
			Streaming: true,
			Sent: true,
			Number: 0,
			Attempts: 0,
			...(reply.Voucher === undefined
				? {}
				: {
						Voucher: reply.Voucher
					})
		});
		draft.Messages.push(message);
		reply.MessageId = message.$Id;
		yield* publishToNearest(draft, "Chat/Arrived");
	},
	*"Chat/Sent"(draft) {
		const line = answerLine(draft.Key, draft.Answers);
		const from = replier(draft);
		draft.Answers++;
		yield* queueReply(draft, {
			From: from,
			Line: line
		});
	}
});

/** "Priya is typing", while a teammate's reply has been asked for and no letter of it has arrived. */
export function* typing(draft: IConversation): ISelectorGenerator<string> {
	const reply = draft.Reply;
	return reply && reply.MessageId === null ? `${firstName(reply.From)} is typing` : "";
}

/** The day heading to show above the message at `index`, or null when it continues the day before it. */
export function dayBreak(messages: readonly IMessage[], index: number): string | null {
	const day = messages[index]?.Day;
	if (day === undefined) return null;
	return index === 0 || messages[index - 1].Day !== day ? day : null;
}

/** Each message's `dayBreak`, in order. */
export function* dayBreaks(draft: IConversation): ISelectorGenerator<(string | null)[]> {
	return draft.Messages.map((_, index) => dayBreak(draft.Messages, index));
}

export const selectors = {
	typing,
	dayBreaks
};
