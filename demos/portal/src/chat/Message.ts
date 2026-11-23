import type { IActionGenerator, IEntity, ISelectorGenerator } from "treflex";
import type { IChatDay } from "../backend/backend";
import { inFlight, leading, named, publishToNearest, start } from "treflex";
import { SendError, sendMessage } from "../backend/backend";

declare module "treflex" {
	interface IMessageRegistry {
		"Chat/Sent": {};
	}
}

export interface IMessage extends IEntity {
	Conversation: string;
	From: string;
	Day: IChatDay;
	At: string;
	Text: string;
	/** A teammate's reply whose letters are still arriving. */
	Streaming: boolean;
	/** True for every teammate message, and for yours once the backend took it. */
	Sent: boolean;
	/** For your messages: how many you had sent to this conversation before this one. */
	Number: number;
	Attempts: number;
	/** The percent off trips of the travel voucher this message carries, if it carries one. */
	Voucher?: number;
}

export interface IVoucherButton {
	Label: string;
	Disabled: boolean;
}

/** The message's "Apply to my trips" button, shown once a voucher message has finished streaming. */
export function voucherButton(message: IMessage, applied: boolean): IVoucherButton | null {
	if (message.Voucher === undefined || message.Streaming) return null;
	return applied
		? {
				Label: "Applied",
				Disabled: true
			}
		: {
				Label: "Apply to my trips",
				Disabled: false
			};
}

export function* deliver(draft: IMessage): IActionGenerator {
	if (draft.Sent) return;
	const attempt = draft.Attempts;
	draft.Attempts++;
	try {
		yield* sendMessage({
			Conversation: draft.Conversation,
			Text: draft.Text,
			Number: draft.Number,
			Attempt: attempt
		});
	} catch (error) {
		if (!(error instanceof SendError)) throw error;
		return;
	}
	draft.Sent = true;
	yield* publishToNearest(draft, "Chat/Sent");
}
named(deliver, "Chat/Deliver");
leading(deliver);

export function* retry(draft: IMessage): IActionGenerator {
	if (draft.Sent) return;
	yield* start(deliver, draft);
}
named(retry, "Chat/RetryMessage");

export const actions = {
	retry
};

export type ISendStatus = "" | "sending" | "failed";

export function* sendStatus(draft: IMessage): ISelectorGenerator<ISendStatus> {
	if (draft.Sent) return "";
	return (yield* inFlight(deliver, draft)) ? "sending" : "failed";
}

export const selectors = {
	sendStatus
};

/** The `.letter` fade's length in styles/chat.css: a finished message switches to plain text once its last letter has faded in. */
export const LETTER_FADE_MS = 300;

/** The characters of `text` after its first `seen` UTF-16 units, one string each: the letters a view fades in. */
export function lettersAfter(text: string, seen: number): string[] {
	return Array.from(text.slice(seen));
}
