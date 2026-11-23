import type { IActionGenerator, IEntity, IReceiverId, ISelectorGenerator } from "treflex";
import type { IConversation } from "./Conversation";
import type { IMessage } from "./Message";
import { entity, mapGen, named, publish, publishToNearest, receiver, start, startTimer, stopTimer } from "treflex";
import { chatCue, chatHistory } from "../backend/backend";
import { paced } from "../backend/fast";
import { plural } from "../text";
import { newConversation, queueReply, typing } from "./Conversation";
import { CONVERSATIONS, conversationInfo, conversationLabel, FIRST_CONVERSATION, firstName, PERSON_IDS, person } from "./directory";
import { sendStatus, voucherButton } from "./Message";

declare module "treflex" {
	interface ITimerRegistry {
		"Chat/Cue": {};
	}
}

export const CUE_MS = paced(14_000);

/** A teammate's reply on its way: Letters is 0 while they are typing. */
export interface IReplyStream {
	Who: string;
	/** The channel, or null for a direct message. */
	Where: string | null;
	Letters: number;
}

export function streamOf(conversation: IConversation): IReplyStream | null {
	const reply = conversation.Reply;
	if (!reply) return null;
	return {
		Who: firstName(reply.From),
		Where: conversationInfo(conversation.Key).Kind === "channel" ? conversationLabel(conversation.Key) : null,
		Letters: conversation.Applied
	};
}

/** The chat as the restore found it, kept so the banner reports the restore, not what happened after it. */
export interface IChatRestore {
	Conversations: number;
	Unread: number;
	Streams: IReplyStream[];
	/** Where each of your messages that was sending at the reload had gone. */
	Unsent: string[];
}

export interface IChat extends IEntity {
	readonly $Receiver?: IReceiverId<IChat>;
	Conversations: IConversation[];
	OpenId: string | null;
	Visible: boolean;
	Intro: boolean;
	/** The next scripted teammate post. */
	Cue: number;
	Restore: IChatRestore | null;
	/** Whether the travel voucher a teammate sent has been applied. It applies once. */
	VoucherApplied: boolean;
}

export function getDefaultState(id: string): IChat {
	return {
		$Id: id,
		$Receiver: ChatReceiver.Id,
		Conversations: [],
		OpenId: null,
		Visible: false,
		Intro: true,
		Cue: 0,
		Restore: null,
		VoucherApplied: false
	};
}

export function* init(draft: IChat): IActionGenerator {
	for (const info of CONVERSATIONS) {
		const history = yield* chatHistory({
			Conversation: info.Key
		});
		const messages = yield* mapGen(history, (line) =>
			entity<IMessage>({
				Conversation: info.Key,
				From: line.From,
				Day: line.Day,
				At: line.At,
				Text: line.Text,
				Streaming: false,
				Sent: true,
				Number: 0,
				Attempts: 0
			})
		);
		const conversation = yield* entity<IConversation>(newConversation(info.Key, messages));
		draft.Conversations.push(conversation);
	}
	draft.OpenId = draft.Conversations.find((c) => c.Key === FIRST_CONVERSATION)?.$Id ?? null;
	yield* startTimer(draft, "Chat/Cue", ChatReceiver, CUE_MS);
}
named(init, "Chat/Init");

function viewing(draft: IChat, conversationId: string): boolean {
	return draft.Visible && draft.OpenId === conversationId;
}

function markRead(draft: IChat): void {
	const open = draft.Conversations.find((c) => c.$Id === draft.OpenId);
	if (open && draft.Visible) open.Unread = 0;
}

export function* openConversation(draft: IChat, conversationId: string): IActionGenerator {
	if (!draft.Conversations.some((c) => c.$Id === conversationId)) return;
	draft.OpenId = conversationId;
	markRead(draft);
	yield* publishToNearest(draft, "Portal/Viewed");
}
named(openConversation, "Chat/OpenConversation");

export function* dismissIntro(draft: IChat): IActionGenerator {
	draft.Intro = false;
}
named(dismissIntro, "Chat/DismissIntro");

/** Applies the travel voucher to the trips, once its message has finished streaming, and only once. */
export function* applyVoucher(draft: IChat): IActionGenerator {
	if (draft.VoucherApplied) return;
	const message = draft.Conversations.flatMap((c) => c.Messages).find((m) => voucherButton(m, false) !== null);
	if (message?.Voucher === undefined) return;
	draft.VoucherApplied = true;
	yield* publish("Portal/VoucherApplied", {
		Percent: message.Voucher,
		From: firstName(message.From)
	});
}
named(applyVoucher, "Chat/ApplyVoucher");

export const actions = {
	openConversation,
	dismissIntro,
	applyVoucher
};

export const ChatReceiver = receiver<IChat>("ChatReceiver")({
	*"Chat/Cue"(draft) {
		const cue = yield* chatCue({
			Index: draft.Cue
		});
		if (!cue) {
			yield* stopTimer(draft, "Chat/Cue");
			return;
		}
		draft.Cue++;
		const conversation = draft.Conversations.find((c) => c.Key === cue.Conversation);
		if (conversation) {
			yield* start(queueReply, conversation, {
				From: cue.From,
				Line: cue.Line,
				...(cue.Voucher === undefined
					? {}
					: {
							Voucher: cue.Voucher
						})
			});
		}
	},
	*"Chat/Arrived"(draft, _message, { publisher }) {
		const conversation = draft.Conversations.find((c) => c.$Id === publisher.Id);
		if (!conversation || viewing(draft, conversation.$Id)) return;
		conversation.Unread++;
	},
	*"Portal/AppShown"(draft, message) {
		if (message.App !== "chat") return;
		draft.Visible = true;
		markRead(draft);
	},
	*"Portal/AppHidden"(draft, message) {
		if (message.App !== "chat") return;
		draft.Visible = false;
	},
	*"Portal/Restored"(draft, message) {
		if (draft.Conversations.length === 0) {
			draft.Restore = null;
			return;
		}
		const dropped = new Set(message.Dropped.map((work) => work.EntityId));
		const streams = draft.Conversations.map(streamOf).filter((s): s is IReplyStream => s !== null);
		const unsent = draft.Conversations.flatMap((c) =>
			c.Messages.filter((m) => !m.Sent && dropped.has(m.$Id)).map(() => conversationLabel(c.Key))
		);
		draft.Restore = {
			Conversations: draft.Conversations.length,
			Unread: draft.Conversations.reduce((n, c) => n + c.Unread, 0),
			Streams: streams,
			Unsent: unsent
		};
		yield* publishToNearest(draft, "Portal/RestoreFound", {
			CutOff: unsent.length > 0
		});
	}
});

export interface IChatRow {
	Id: string;
	Channel: boolean;
	Name: string;
	Initials: string;
	Colour: string;
	Online: boolean;
	Bold: boolean;
	/** "typing…" while a teammate is typing there; it takes the place of the unread count. */
	Note: string;
	/** The unread count to show, 0 for none. */
	Badge: number;
	On: boolean;
}

export interface IChatRows {
	Channels: IChatRow[];
	Direct: IChatRow[];
}

export function* rows(draft: IChat): ISelectorGenerator<IChatRows> {
	const all = yield* mapGen(draft.Conversations, function* (c): ISelectorGenerator<IChatRow> {
		const info = conversationInfo(c.Key);
		const who = info.Kind === "direct" ? person(info.Members[0]) : null;
		const typingNow = (yield* typing(c)) !== "";
		return {
			Id: c.$Id,
			Channel: info.Kind === "channel",
			Name: info.Name,
			Initials: who?.Initials ?? "",
			Colour: who?.Colour ?? "",
			Online: who?.Online ?? false,
			Bold: c.Unread > 0,
			Note: typingNow ? "typing…" : "",
			Badge: typingNow ? 0 : c.Unread,
			On: c.$Id === draft.OpenId
		};
	});
	return {
		Channels: all.filter((row) => row.Channel),
		Direct: all.filter((row) => !row.Channel)
	};
}

export interface IChatSummary {
	Line: string;
	Unread: number;
}

export function* summary(draft: IChat): ISelectorGenerator<IChatSummary> {
	const unread = draft.Conversations.reduce((n, c) => n + c.Unread, 0);
	const statuses = yield* mapGen(
		draft.Conversations.flatMap((c) => c.Messages),
		sendStatus
	);
	const failed = statuses.filter((s) => s === "failed").length;
	if (failed > 0) {
		return {
			Line: `${plural(failed, "message")} didn't send`,
			Unread: unread
		};
	}
	for (const c of draft.Conversations) {
		const who = yield* typing(c);
		if (who)
			return {
				Line: `${who}…`,
				Unread: unread
			};
	}
	const channels = CONVERSATIONS.filter((c) => c.Kind === "channel").length;
	return {
		Line: `${channels} channels · ${PERSON_IDS.length} people`,
		Unread: unread
	};
}

export interface IPaneHead {
	Title: string;
	Topic: string;
	Faces: {
		Initials: string;
		Colour: string;
	}[];
}

export function* current(draft: IChat): ISelectorGenerator<IConversation | undefined> {
	return draft.Conversations.find((c) => c.$Id === draft.OpenId);
}

export function* paneHead(draft: IChat): ISelectorGenerator<IPaneHead | null> {
	const open = yield* current(draft);
	if (!open) return null;
	const info = conversationInfo(open.Key);
	return {
		Title: info.Kind === "channel" ? `# ${info.Name}` : info.Name,
		Topic: info.Topic,
		Faces: [
			...info.Members,
			"me"
		].map((id) => ({
			Initials: person(id).Initials,
			Colour: person(id).Colour
		}))
	};
}

export const selectors = {
	rows,
	summary,
	current,
	paneHead
};
