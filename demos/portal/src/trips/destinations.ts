export type IDestinationKey = "lisbon" | "kyoto" | "reykjavik";

export type ILegKind = "flights" | "hotel" | "activities";

export const LEG_KINDS: readonly ILegKind[] = [
	"flights",
	"hotel",
	"activities"
];

export interface IDestination {
	Key: IDestinationKey;
	Name: string;
	Nights: number;
	NightsWord: string;
	Dates: string;
	DatesSpoken: string;
	Travellers: number;
	TravellersWord: string;
	Budget: number;
	From: string;
	FromCode: string;
	Code: string;
	DepartDay: number;
	Month: string;
	// Hours from Sydney's clock to the destination's, so an arrival time reads locally.
	ClockShift: number;
	Tagline: string;
	TaglineColour: string;
	Neighbourhoods: readonly string[];
	Hotels: readonly string[];
	Activities: readonly {
		Name: string;
		When: string;
	}[];
	Hubs: readonly string[];
	Providers: Record<ILegKind, number>;
}

export const CARRIERS: readonly string[] = [
	"Meridian Air",
	"Corsa Airways",
	"Tasman Jet",
	"Kestrel",
	"Aurora Atlantic",
	"Sundial",
	"Pacifica",
	"Halcyon",
	"Southern Arc"
];

export const DESTINATIONS: Record<IDestinationKey, IDestination> = {
	lisbon: {
		Key: "lisbon",
		Name: "Lisbon",
		Nights: 6,
		NightsWord: "six",
		Dates: "12 – 18 March",
		DatesSpoken: "12 to 18 March",
		Travellers: 2,
		TravellersWord: "two",
		Budget: 5000,
		From: "Sydney",
		FromCode: "SYD",
		Code: "LIS",
		DepartDay: 12,
		Month: "Mar",
		ClockShift: -11,
		Tagline: "Tiles, trams and custard tarts",
		TaglineColour: "#24519a",
		Neighbourhoods: [
			"Alfama",
			"Chiado",
			"Príncipe Real"
		],
		Hotels: [
			"Casa do Largo",
			"The Tile House",
			"Hotel Miradouro",
			"Pensão Amor",
			"Palácio Graça",
			"Casa das Janelas",
			"The Lumiar",
			"Tejo Rooms",
			"Hotel Sé",
			"Bairro Suites",
			"Casa Azulejo",
			"The Tram Stop"
		],
		Activities: [
			{
				Name: "Sintra and Cascais day trip",
				When: "Sat 15 · small group"
			},
			{
				Name: "Fado dinner in Alfama",
				When: "Thu 13 · 8pm"
			},
			{
				Name: "Tile painting class",
				When: "Fri 14 · morning"
			},
			{
				Name: "Sunset sail on the Tejo",
				When: "Sun 16 · 6pm"
			},
			{
				Name: "Pastry walk in Belém",
				When: "Mon 17 · 10am"
			},
			{
				Name: "Tram 28 and the castle",
				When: "Fri 14 · afternoon"
			}
		],
		Hubs: [
			"Doha",
			"Dubai",
			"Singapore"
		],
		Providers: {
			flights: 9,
			hotel: 36,
			activities: 8
		}
	},
	kyoto: {
		Key: "kyoto",
		Name: "Kyoto",
		Nights: 7,
		NightsWord: "seven",
		Dates: "4 – 11 April",
		DatesSpoken: "4 to 11 April",
		Travellers: 2,
		TravellersWord: "two",
		Budget: 6500,
		From: "Sydney",
		FromCode: "SYD",
		Code: "KIX",
		DepartDay: 4,
		Month: "Apr",
		ClockShift: -1,
		Tagline: "Temples and tiny bars",
		TaglineColour: "#8f1d22",
		Neighbourhoods: [
			"Gion",
			"Higashiyama",
			"Pontocho"
		],
		Hotels: [
			"Ryokan Hanami",
			"The Lantern House",
			"Hotel Kamo",
			"Gion Machiya",
			"Kiyomizu Inn",
			"The Paper Screen",
			"Hotel Sanjo",
			"Momiji Rooms",
			"Pontocho Stay",
			"The Moss Garden",
			"Ryokan Shirakawa",
			"Hotel Tsuki"
		],
		Activities: [
			{
				Name: "Fushimi Inari at dawn",
				When: "Sat 6 · 6am"
			},
			{
				Name: "Tea ceremony in Gion",
				When: "Sun 7 · 2pm"
			},
			{
				Name: "Nara day trip",
				When: "Tue 9 · small group"
			},
			{
				Name: "Izakaya crawl in Pontocho",
				When: "Fri 5 · 7pm"
			},
			{
				Name: "Arashiyama bamboo walk",
				When: "Mon 8 · morning"
			},
			{
				Name: "Kaiseki dinner",
				When: "Wed 10 · 7pm"
			}
		],
		Hubs: [
			"Tokyo",
			"Singapore",
			"Hong Kong"
		],
		Providers: {
			flights: 9,
			hotel: 30,
			activities: 8
		}
	},
	reykjavik: {
		Key: "reykjavik",
		Name: "Reykjavík",
		Nights: 5,
		NightsWord: "five",
		Dates: "20 – 25 Feb",
		DatesSpoken: "20 to 25 February",
		Travellers: 2,
		TravellersWord: "two",
		Budget: 7000,
		From: "Sydney",
		FromCode: "SYD",
		Code: "KEF",
		DepartDay: 20,
		Month: "Feb",
		ClockShift: -11,
		Tagline: "Hot springs and northern lights",
		TaglineColour: "#13284d",
		Neighbourhoods: [
			"Miðborg",
			"Vesturbær",
			"Hlíðar"
		],
		Hotels: [
			"Hótel Norðurljós",
			"The Basalt House",
			"Harbour Rooms",
			"Hótel Esja",
			"The Lava Field",
			"Guesthouse Sól",
			"Hótel Tjörn",
			"The Old Bakery",
			"Skuggi Suites",
			"Hótel Hekla",
			"Fjord Loft",
			"The Snow Line"
		],
		Activities: [
			{
				Name: "Northern lights by jeep",
				When: "Fri 21 · 9pm"
			},
			{
				Name: "Golden Circle day trip",
				When: "Sat 22 · small group"
			},
			{
				Name: "Sky Lagoon evening",
				When: "Sun 23 · 7pm"
			},
			{
				Name: "Glacier walk",
				When: "Mon 24 · morning"
			},
			{
				Name: "Whale watching",
				When: "Thu 20 · afternoon"
			},
			{
				Name: "Lamb soup and a saga",
				When: "Sat 22 · 7pm"
			}
		],
		Hubs: [
			"Singapore",
			"London",
			"Doha"
		],
		Providers: {
			flights: 9,
			hotel: 24,
			activities: 8
		}
	}
};

export const DESTINATION_KEYS: readonly IDestinationKey[] = [
	"lisbon",
	"kyoto",
	"reykjavik"
];
