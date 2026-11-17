export type IPersonId = "me" | "priya" | "marcus" | "ana" | "jonah" | "sam";

export interface IPerson {
	Name: string;
	Initials: string;
	Colour: string;
	Online: boolean;
}

export const PEOPLE: Record<IPersonId, IPerson> = {
	me: {
		Name: "You",
		Initials: "You",
		Colour: "#1a1c21",
		Online: true
	},
	priya: {
		Name: "Priya Shah",
		Initials: "PS",
		Colour: "#c2410c",
		Online: true
	},
	marcus: {
		Name: "Marcus Lee",
		Initials: "ML",
		Colour: "#2563eb",
		Online: true
	},
	ana: {
		Name: "Ana Torres",
		Initials: "AT",
		Colour: "#7c3aed",
		Online: false
	},
	jonah: {
		Name: "Jonah Okafor",
		Initials: "JO",
		Colour: "#0e7490",
		Online: true
	},
	sam: {
		Name: "Sam Reid",
		Initials: "SR",
		Colour: "#15803d",
		Online: true
	}
};

export const PERSON_IDS = Object.keys(PEOPLE) as IPersonId[];

export function person(id: string): IPerson {
	return PEOPLE[id as IPersonId] ?? PEOPLE.me;
}

export function firstName(id: string): string {
	return person(id).Name.split(" ")[0];
}

export type IConversationKind = "channel" | "direct";

export interface IConversationInfo {
	Key: string;
	Kind: IConversationKind;
	Name: string;
	Topic: string;
	Members: IPersonId[];
}

const TEAM: IPersonId[] = [
	"priya",
	"marcus",
	"ana",
	"jonah",
	"sam"
];

function direct(id: IPersonId): IConversationInfo {
	return {
		Key: `dm-${id}`,
		Kind: "direct",
		Name: PEOPLE[id].Name,
		Topic: "Direct message",
		Members: [
			id
		]
	};
}

export const CONVERSATIONS: readonly IConversationInfo[] = [
	{
		Key: "general",
		Kind: "channel",
		Name: "general",
		Topic: "Company-wide news and notes",
		Members: TEAM
	},
	{
		Key: "launch",
		Kind: "channel",
		Name: "launch",
		Topic: "Shipping the spring release on Thursday",
		Members: [
			"priya",
			"marcus",
			"ana",
			"jonah"
		]
	},
	{
		Key: "design",
		Kind: "channel",
		Name: "design",
		Topic: "Screens, flows and the design system",
		Members: [
			"priya",
			"ana",
			"sam"
		]
	},
	{
		Key: "support",
		Kind: "channel",
		Name: "support",
		Topic: "What customers are asking about",
		Members: [
			"jonah",
			"sam",
			"marcus"
		]
	},
	direct("priya"),
	direct("marcus"),
	direct("ana"),
	direct("jonah")
];

export const FIRST_CONVERSATION = "launch";

export function conversationInfo(key: string): IConversationInfo {
	return CONVERSATIONS.find((c) => c.Key === key) ?? CONVERSATIONS[0];
}

/** "#launch" for a channel, the person's name for a direct message. */
export function conversationLabel(key: string): string {
	const info = conversationInfo(key);
	return info.Kind === "channel" ? `#${info.Name}` : info.Name;
}
