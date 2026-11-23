import type { IEffect, IEffectPayload } from "treflex";
import type { IDestinationKey, ILegKind } from "../trips/destinations";
import { defineEffect } from "treflex";

export interface IFare {
	Id: string;
	Carrier: string;
	Slot: "Morning" | "Evening";
	Depart: string;
	Arrive: string;
	ArriveDay: string;
	Duration: string;
	Via: string;
	ArriveHour: number;
	Price: number;
}

export interface IPick {
	Id: string;
	Name: string;
	Detail: string;
	Rating: number;
	Price: number;
}

export interface IProviderResult {
	Provider: string;
	Fares: IFare[];
	Picks: IPick[];
}

export interface ICheckProvider extends IEffect {
	Type: "Backend/CheckProvider";
	Destination: IDestinationKey;
	Kind: ILegKind;
	Index: number;
	/** How many more times to ask after the provider fails with a `ProviderError`. */
	Retries: number;
}

export const checkProvider = defineEffect<ICheckProvider, IProviderResult>("Backend/CheckProvider");

export class ProviderError extends Error {
	readonly Provider: string;

	constructor(provider: string, message: string) {
		super(message);
		this.name = "ProviderError";
		this.Provider = provider;
	}
}

// In [0, 1), as Math.random(): callers scale by it, so a stub must stay in it.
export interface IRandom extends IEffect {
	Type: "Backend/Random";
}

export const random = defineEffect<IRandom, number>("Backend/Random", {
	settles: "sync"
});

export interface IChatTime extends IEffect {
	Type: "Backend/ChatTime";
}

/** The time of day a chat message is stamped with, as "10:04". */
export const chatTime = defineEffect<IChatTime, string>("Backend/ChatTime", {
	settles: "sync"
});

export interface INow extends IEffect {
	Type: "Backend/Now";
}

/** The wall-clock time, in milliseconds since the epoch. */
export const now = defineEffect<INow, number>("Backend/Now", {
	settles: "sync"
});

export type IChatDay = "Yesterday" | "Today";

export interface IChatLine {
	From: string;
	Day: IChatDay;
	At: string;
	Text: string;
}

export interface IChatHistory extends IEffect {
	Type: "Backend/ChatHistory";
	Conversation: string;
}

export const chatHistory = defineEffect<IChatHistory, IChatLine[]>("Backend/ChatHistory");

export interface IChatCue {
	Conversation: string;
	From: string;
	Line: string;
	/** The percent off trips of the travel voucher this post carries, if it carries one. */
	Voucher?: number;
}

export interface IChatCueEffect extends IEffect {
	Type: "Backend/ChatCue";
	Index: number;
}

/** The scripted teammate post at this place in the run, or null once the script is done. */
export const chatCue = defineEffect<IChatCueEffect, IChatCue | null>("Backend/ChatCue");

export interface IPostMessage extends IEffect {
	Type: "Backend/PostMessage";
	Conversation: string;
	Text: string;
	/** How many messages you had sent to this conversation before this one. */
	Number: number;
	Attempt: number;
}

/** Whether the server took the message, and if not, why. */
export type IPostAnswer =
	| {
			Sent: true;
	  }
	| {
			Sent: false;
			Message: string;
	  };

export const postMessage = defineEffect<IPostMessage, IPostAnswer>("Backend/PostMessage");

export class SendError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SendError";
	}
}

/** Posts a message, and throws `SendError` when the server didn't take it. */
export function* sendMessage(message: IEffectPayload<IPostMessage>) {
	const answer = yield* postMessage(message);
	if (!answer.Sent) throw new SendError(answer.Message);
}

export interface IReplyChunk {
	/** The index of the first letter in Letters, so a receiver can skip what it has applied. */
	Index: number;
	/** Characters of the reply, counted as code points, as `replyLetters` splits them. */
	Letters: string[];
}

declare module "treflex" {
	interface IResourceTypeRegistry {
		"Chat/Stream": {
			Params: {
				Conversation: string;
				From: string;
				Line: string;
			};
			Message: IReplyChunk;
		};
	}
	interface IResourceRegistry {
		"Chat/Reply": {
			Type: "Chat/Stream";
		};
	}
}
