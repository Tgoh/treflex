import type { IChatCue, IChatLine } from "./backend";

/** A "Yesterday" line keeps its At. A "Today" line is stamped when the history loads, MinutesAgo before then. */
export type IScriptLine = Omit<IChatLine, "At"> &
	(
		| {
				At: string;
		  }
		| {
				MinutesAgo: number;
		  }
	);

export const HISTORY: Record<string, IScriptLine[]> = {
	general: [
		{
			From: "sam",
			Day: "Yesterday",
			At: "09:12",
			Text: "Reminder that the office is closed on Monday for the public holiday. Enjoy the long weekend, everyone."
		},
		{
			From: "marcus",
			Day: "Yesterday",
			At: "15:30",
			Text: "Lunch on Friday is on the company to celebrate the spring release. Add your order to the sheet by Thursday."
		}
	],
	launch: [
		{
			From: "ana",
			Day: "Yesterday",
			At: "16:40",
			Text: "Final screenshots for the store listing are in the shared folder. I went with the dark theme for the hero shot."
		},
		{
			From: "jonah",
			Day: "Yesterday",
			At: "17:12",
			Text: "Support macros for the new billing page are live. I'll watch the queue on launch day."
		},
		{
			From: "marcus",
			Day: "Today",
			MinutesAgo: 12,
			Text: "Release notes are drafted. Can someone check the pricing section before I send it to marketing?"
		}
	],
	design: [
		{
			From: "ana",
			Day: "Yesterday",
			At: "11:48",
			Text: "The new icon set is in the library. Please swap the old ones as you touch each screen."
		}
	],
	support: [
		{
			From: "jonah",
			Day: "Yesterday",
			At: "14:05",
			Text: "Three tickets this morning asking where the export button went. It moved under the share menu."
		},
		{
			From: "sam",
			Day: "Yesterday",
			At: "14:20",
			Text: "I'll add a tooltip for it in the next patch."
		}
	],
	"dm-priya": [
		{
			From: "priya",
			Day: "Yesterday",
			At: "18:01",
			Text: "Thanks for covering the review today. I owe you one."
		}
	],
	"dm-marcus": [],
	"dm-ana": [
		{
			From: "ana",
			Day: "Yesterday",
			At: "10:15",
			Text: "Can we move our sync to Thursday afternoon?"
		}
	],
	"dm-jonah": []
};

interface IScriptedCue extends IChatCue {
	Text: string;
}

const CUE_SCRIPT: readonly Omit<IScriptedCue, "Line">[] = [
	{
		Conversation: "design",
		From: "priya",
		Text: "Pushed the new onboarding screens to the design file. The empty states finally have illustrations, and the first-run checklist is down from seven steps to four."
	},
	{
		Conversation: "dm-marcus",
		From: "marcus",
		Text: "Found the offsite travel voucher: 10% off trips. Use it before Friday.",
		Voucher: 10
	},
	{
		Conversation: "launch",
		From: "priya",
		Text: "Pricing looks right to me. The one thing I'd change is the table in section 3: the annual plan still says $96, but finance moved it to $90 last week."
	},
	{
		Conversation: "dm-jonah",
		From: "jonah",
		Text: "Quick one: are you around on Thursday morning? I'd like a second pair of eyes on the support queue for the first hour after the release goes out."
	},
	{
		Conversation: "support",
		From: "jonah",
		Text: "A customer asked whether the spring release changes their invoices. It doesn't, but I'll add a line to the macro so nobody has to look it up."
	},
	{
		Conversation: "design",
		From: "ana",
		Text: "Love the checklist. Could we try the progress ring from the trip planner mockups on it? It reads well at small sizes and we already have the component."
	},
	{
		Conversation: "dm-priya",
		From: "priya",
		Text: "Are you free for ten minutes after lunch? I want to walk you through the pricing table change before Marcus sends the notes."
	},
	{
		Conversation: "launch",
		From: "marcus",
		Text: "Fixed the annual price in section 3 and sent the notes to marketing. Thanks for catching it, Priya. Launch checklist is next."
	}
];

export const CUES: readonly IScriptedCue[] = CUE_SCRIPT.map((cue, i) => ({
	...cue,
	Line: `cue:${i}`
}));

const ANSWERS: Record<string, readonly string[]> = {
	general: [
		"Nice, thanks for the update. I'll pass it on to the people who weren't in this morning.",
		"Good to know. I'll keep an eye on this channel for anything else that comes up."
	],
	launch: [
		"Thanks, that helps. I'll fold it into the checklist so we don't lose it before Thursday.",
		"Agreed. Let's keep the release notes as they are and fix anything else in the follow-up patch."
	],
	design: [
		"Good call. I'll try it in the file this afternoon and post a screenshot here when it's ready.",
		"That works for me. Let's keep the spacing from the old version and only change the colours."
	],
	support: [
		"Makes sense. I'll update the macro and tag you on the first ticket that uses it.",
		"Thanks. I'll watch for more of these and post a summary at the end of the day."
	],
	"dm-priya": [
		"Sounds good. I'll send you the table once finance confirms the new numbers, probably by this afternoon.",
		"Perfect, thank you. Let's catch up properly after the release."
	],
	"dm-marcus": [
		"Got it. I'll look at it after my next meeting and get back to you before lunch.",
		"Thanks for the heads up. I'll make sure the notes go out on time."
	],
	"dm-ana": [
		"Thursday works. I'll move the invite and add the screenshots we talked about to the agenda.",
		"Great, see you then."
	],
	"dm-jonah": [
		"Thanks, that's a big help. I'll set up the queue view before you get in so we can start straight away.",
		"Perfect. I'll bring coffee."
	]
};

export function answerLine(conversation: string, index: number): string {
	return `answer:${conversation}:${index}`;
}

export function lineText(line: string): string {
	const [kind, ...rest] = line.split(":");
	if (kind === "cue") return CUES[Number(rest[0])]?.Text ?? "";
	if (kind === "answer") {
		const index = Number(rest.pop());
		const options = ANSWERS[rest.join(":")] ?? [];
		return options.length === 0 ? "" : options[index % options.length];
	}
	return "";
}
