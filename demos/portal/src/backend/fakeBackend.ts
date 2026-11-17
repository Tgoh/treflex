import type { IRuntime } from "treflex";
import type { ICheckProvider, IFare, IPick, IPostMessage, IProviderResult } from "./backend";
import { implementation } from "treflex";
import { wallClock } from "../portal/clock";
import { CARRIERS, DESTINATIONS } from "../trips/destinations";
import { chatCue, chatHistory, chatTime, checkProvider, now, ProviderError, postMessage, random, SendError } from "./backend";
import { CUES, HISTORY, lineText } from "./chatScript";
import { paced } from "./fast";

export type IWait = (ms: number, signal: AbortSignal | undefined, effect: ICheckProvider) => Promise<void>;

function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function seeded(key: string): () => number {
	let a = hash(key);
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const between = (rand: () => number, low: number, high: number): number => low + Math.floor(rand() * (high - low + 1));

const FAILURES = [
	"provider timeout",
	"rate limited",
	"bad gateway"
];

const FLIGHT_HOURS: Record<
	ICheckProvider["Destination"],
	[
		number,
		number
	]
> = {
	lisbon: [
		24,
		29
	],
	kyoto: [
		12,
		16
	],
	reykjavik: [
		27,
		33
	]
};

const FARE_BASE: Record<
	ICheckProvider["Destination"],
	[
		number,
		number
	]
> = {
	lisbon: [
		1090,
		1420
	],
	kyoto: [
		720,
		980
	],
	reykjavik: [
		1480,
		1890
	]
};

const EXTRAS = [
	"breakfast",
	"river view",
	"rooftop bar",
	"quiet street",
	"free cancellation",
	"late checkout"
];

const clock = (minutes: number): string => {
	const m = ((minutes % 1440) + 1440) % 1440;
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

function providerName(effect: ICheckProvider): string {
	const destination = DESTINATIONS[effect.Destination];
	switch (effect.Kind) {
		case "flights":
			return CARRIERS[effect.Index % CARRIERS.length];
		case "hotel":
			return destination.Hotels[effect.Index % destination.Hotels.length];
		case "activities":
			return `Provider ${effect.Index + 1}`;
		default:
			return effect.Kind satisfies never;
	}
}

function fares(effect: ICheckProvider): IFare[] {
	const destination = DESTINATIONS[effect.Destination];
	const rand = seeded(`${effect.Destination}|flights|${effect.Index}`);
	const carrier = CARRIERS[effect.Index % CARRIERS.length];
	const code = carrier
		.split(" ")
		.map((word) => word[0])
		.join("")
		.padEnd(2, "X");
	const [low, high] = FLIGHT_HOURS[effect.Destination];
	const [cheap, dear] = FARE_BASE[effect.Destination];
	const count = between(rand, 3, 6);
	const out: IFare[] = [];
	for (let i = 0; i < count; i++) {
		const morning = rand() < 0.5;
		const depart = morning ? between(rand, 66, 138) * 5 : between(rand, 210, 282) * 5;
		const duration = between(rand, low * 12, high * 12) * 5;
		const landing = depart + duration + destination.ClockShift * 60;
		out.push({
			Id: `${code}${between(rand, 100, 989)}`,
			Carrier: carrier,
			Slot: morning ? "Morning" : "Evening",
			Depart: clock(depart),
			Arrive: clock(landing),
			ArriveDay: `${destination.DepartDay + Math.floor(landing / 1440)} ${destination.Month}`,
			Duration: `${Math.floor(duration / 60)}h ${String(duration % 60).padStart(2, "0")}m`,
			Via: destination.Hubs[between(rand, 0, destination.Hubs.length - 1)],
			ArriveHour: Math.floor((((landing % 1440) + 1440) % 1440) / 60),
			Price: between(rand, cheap, dear)
		});
	}
	return out;
}

function hotel(effect: ICheckProvider): IPick[] {
	const destination = DESTINATIONS[effect.Destination];
	const name = destination.Hotels[effect.Index % destination.Hotels.length];
	if (seeded(`${effect.Destination}|hotel|${effect.Index}|free`)() < 0.25) return [];
	const rand = seeded(`${effect.Destination}|hotel|${name}`);
	const area = destination.Neighbourhoods[between(rand, 0, destination.Neighbourhoods.length - 1)];
	const rating = between(rand, 39, 48) / 10;
	const extra = EXTRAS[between(rand, 0, EXTRAS.length - 1)];
	return [
		{
			Id: `H${hash(name) % 10000}`,
			Name: name,
			Detail: `${area} · ${rating.toFixed(1)} · ${extra}`,
			Rating: rating,
			Price: between(rand, 14, 32) * 10 + between(rand, 0, 9)
		}
	];
}

function activities(effect: ICheckProvider): IPick[] {
	const destination = DESTINATIONS[effect.Destination];
	const rand = seeded(`${effect.Destination}|activities|${effect.Index}`);
	const count = between(rand, 0, 2);
	const out: IPick[] = [];
	for (let i = 0; i < count; i++) {
		const activity = destination.Activities[(effect.Index * 2 + i) % destination.Activities.length];
		const own = seeded(`${effect.Destination}|activity|${activity.Name}`);
		out.push({
			Id: `A${hash(activity.Name) % 10000}`,
			Name: activity.Name,
			Detail: activity.When,
			Rating: between(own, 40, 49) / 10,
			Price: between(own, 9, 24) * 10 + between(own, 0, 9) - 2
		});
	}
	return out;
}

export function providerAnswer(effect: ICheckProvider): IProviderResult {
	const provider = providerName(effect);
	const roll = seeded(`${effect.Destination}|${effect.Kind}|${effect.Index}|fail`)();
	if (effect.Attempt === 0 && roll < 0.09) {
		throw new ProviderError(provider, FAILURES[Math.floor(roll * 100) % FAILURES.length]);
	}
	return {
		Provider: provider,
		Fares: effect.Kind === "flights" ? fares(effect) : [],
		Picks: effect.Kind === "hotel" ? hotel(effect) : effect.Kind === "activities" ? activities(effect) : []
	};
}

const LEG_MS: Record<ICheckProvider["Kind"], number> = {
	flights: 10_500,
	hotel: 31_000,
	activities: 29_000
};

export function providerDelay(effect: ICheckProvider): number {
	const rand = seeded(`${effect.Destination}|${effect.Kind}|${effect.Index}|${effect.Attempt}|delay`);
	const each = LEG_MS[effect.Kind] / DESTINATIONS[effect.Destination].Providers[effect.Kind];
	return Math.round(each * (0.85 + rand() * 0.3));
}

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, {
			once: true
		});
	});

export const realWait: IWait = (ms, signal) => sleep(paced(ms), signal);

export function fakeBackend(wait: IWait = realWait) {
	return implementation(checkProvider, async (effect, action) => {
		await wait(providerDelay(effect), action?.signal, effect);
		return providerAnswer(effect);
	});
}

export function fakeRandom(seed = "portal") {
	const rand = seeded(seed);
	return implementation(random, () => rand());
}

export const realNow = implementation(now, () => wallClock());

export interface IChatWaitFor {
	Kind: "post" | "typing" | "letter";
	Conversation: string;
	Index: number;
}

export type IChatWait = (ms: number, signal: AbortSignal | undefined, what: IChatWaitFor) => Promise<void>;

const realChatWait: IChatWait = (ms, signal) => sleep(paced(ms), signal);

export function sendFails(effect: IPostMessage): boolean {
	if (effect.Attempt > 0) return false;
	return effect.Number === 1 || seeded(`${effect.Conversation}|${effect.Number}|send`)() < 0.15;
}

export function replyText(line: string): string {
	return lineText(line).split(" ").filter(Boolean).join(" ");
}

export function replyLetters(line: string): string[] {
	return Array.from(replyText(line));
}

function typingMs(line: string): number {
	return 1400 + Math.floor(seeded(`${line}|typing`)() * 1000);
}

function letterMs(line: string, index: number): number {
	return 22 + Math.floor(seeded(`${line}|${index}|letter`)() * 23);
}

function timeOfDay(ms: number): string {
	const at = new Date(ms);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function fakeChat(wait: IChatWait = realChatWait) {
	return [
		implementation(chatTime, () => timeOfDay(wallClock())),
		implementation(chatHistory, async (effect) => {
			const now = wallClock();
			const midnight = new Date(now).setHours(0, 0, 0, 0);
			return (HISTORY[effect.Conversation] ?? []).map((line) => ({
				From: line.From,
				Day: line.Day,
				At: "At" in line ? line.At : timeOfDay(Math.max(midnight, now - line.MinutesAgo * 60_000)),
				Text: line.Text
			}));
		}),
		implementation(chatCue, async (effect) => {
			const cue = CUES[effect.Index];
			return cue
				? {
						Conversation: cue.Conversation,
						From: cue.From,
						Line: cue.Line,
						...(cue.Voucher === undefined
							? {}
							: {
									Voucher: cue.Voucher
								})
					}
				: null;
		}),
		implementation(postMessage, async (effect, action) => {
			const ms = 700 + Math.floor(seeded(`${effect.Conversation}|${effect.Number}|${effect.Attempt}|post`)() * 600);
			await wait(ms, action?.signal, {
				Kind: "post",
				Conversation: effect.Conversation,
				Index: effect.Number
			});
			if (sendFails(effect)) throw new SendError("the server didn't answer");
		})
	];
}

export function registerChatStream(runtime: IRuntime<object>, wait: IChatWait = realChatWait): void {
	runtime.registerResourceType("Chat/Stream", async (params, r) => {
		const letters = replyLetters(params.Line);
		let next = typeof r.resumeFrom === "number" ? r.resumeFrom : 0;
		if (next === 0) {
			await wait(typingMs(params.Line), r.signal, {
				Kind: "typing",
				Conversation: params.Conversation,
				Index: 0
			});
		}
		while (next < letters.length) {
			await wait(letterMs(params.Line, next), r.signal, {
				Kind: "letter",
				Conversation: params.Conversation,
				Index: next
			});
			void r.emit({
				Index: next,
				Letters: [
					letters[next]
				]
			});
			next++;
		}
		r.end("done");
	});
}

export interface IFakeBackendOptions {
	wait?: IWait;
	chatWait?: IChatWait;
}

export function registerFakeBackend(runtime: IRuntime<object>, { wait, chatWait }: IFakeBackendOptions = {}): void {
	runtime.registerImplementation(fakeBackend(wait));
	runtime.registerImplementation(fakeRandom());
	runtime.registerImplementation(realNow);
	for (const chat of fakeChat(chatWait)) runtime.registerImplementation(chat);
	registerChatStream(runtime, chatWait);
}
