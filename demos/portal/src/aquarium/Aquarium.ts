import type { IActionGenerator, IEntity, IReceiverId, ISelectorGenerator } from "treflex";
import type { IFish } from "./Fish";
import { entity, receiver, startTimer } from "treflex";
import { random } from "../backend/backend";
import { plural } from "../text";
import { FishReceiver } from "./Fish";

export interface ISchool extends IEntity {
	Name: string;
	Hue: number;
	Fish: IFish[];
}

/** The tank as the restore found it, kept so the banner reports the restore, not what happened after it. */
export interface IAquariumRestore {
	Fish: number;
	Schools: number;
	Giants: number;
}

export interface IAquarium extends IEntity {
	readonly $Receiver?: IReceiverId<IAquarium>;
	Schools: ISchool[];
	Giants: IFish[];
	Restore: IAquariumRestore | null;
}

export function getDefaultState(id: string): IAquarium {
	return {
		$Id: id,
		$Receiver: AquariumReceiver.Id,
		Schools: [],
		Giants: [],
		Restore: null
	};
}

export const SPECIES: readonly {
	Name: string;
	Hue: number;
}[] = [
	{
		Name: "Lanternfish",
		Hue: 188
	},
	{
		Name: "Hatchetfish",
		Hue: 166
	},
	{
		Name: "Viperfish",
		Hue: 282
	},
	{
		Name: "Anglerfish",
		Hue: 38
	},
	{
		Name: "Dragonfish",
		Hue: 322
	},
	{
		Name: "Gulper Eel",
		Hue: 210
	}
];

export const MAX_SCHOOLS = SPECIES.length;
export const MAX_FISH = 40;
export const MAX_GIANTS = 3;

/** Every giant's hue is drawn within 12 of this, the Anglerfish's. */
export const GIANT_HUE = 38;

export function createSchool(name: string, hue: number): Omit<ISchool, "$Id"> {
	return {
		Name: name,
		Hue: hue,
		Fish: []
	};
}

export function* init(draft: IAquarium): IActionGenerator {
	yield* addSchool(draft);
	yield* addSchool(draft);
	yield* addSchool(draft);
}

// Keyed on the species present, not on the count, so removing then re-adding can't bring back a duplicate.
export function* addSchool(draft: IAquarium): IActionGenerator {
	if (draft.Schools.length >= MAX_SCHOOLS) return;

	const present = new Set(draft.Schools.map((s) => s.Name));
	const species = SPECIES.find((s) => !present.has(s.Name));
	if (!species) return;

	const school = yield* entity(createSchool(species.Name, species.Hue));
	const schoolId = school.$Id;
	draft.Schools.push(school);

	for (let i = 0; i < 4; i++) {
		yield* addFish(draft, schoolId);
	}
}

export function* addFish(draft: IAquarium, schoolId: string): IActionGenerator {
	if (schoolFish(draft) >= MAX_FISH) return;
	const school = draft.Schools.find((s) => s.$Id === schoolId);
	if (!school) return;

	const fish = yield* entity(yield* createFish(school.Hue));
	const period = 2200 + (yield* random()) * 3600;
	school.Fish.push(fish);
	yield* startTimer(fish, "Fish/Swim", FishReceiver, period);
}

export function* releaseFish(draft: IAquarium, schoolId: string, fishId: string): IActionGenerator {
	const school = draft.Schools.find((s) => s.$Id === schoolId);
	if (!school) return;
	school.Fish = school.Fish.filter((f) => f.$Id !== fishId);
}

export function* releaseSchool(draft: IAquarium, schoolId: string): IActionGenerator {
	draft.Schools = draft.Schools.filter((s) => s.$Id !== schoolId);
}

export function* addGiant(draft: IAquarium): IActionGenerator {
	if (draft.Giants.length >= MAX_GIANTS) return;
	const giant = yield* entity(yield* createGiant());
	const period = 2200 + (yield* random()) * 3600;

	draft.Giants.push(giant);
	yield* startTimer(giant, "Fish/Swim", FishReceiver, period);
}

export function* releaseGiant(draft: IAquarium, giantId: string): IActionGenerator {
	draft.Giants = draft.Giants.filter((g) => g.$Id !== giantId);
}

/** The fish in schools, giants left out, as MAX_FISH counts them. */
export function schoolFish(draft: IAquarium): number {
	return draft.Schools.reduce((n, s) => n + s.Fish.length, 0);
}

function atRest(x: number, y: number): Pick<IFish, "X" | "Y" | "FromX" | "FromY" | "SwamAt"> {
	return {
		X: x,
		Y: y,
		FromX: x,
		FromY: y,
		SwamAt: 0
	};
}

function* createFish(schoolHue: number): IActionGenerator<Omit<IFish, "$Id">> {
	return {
		...atRest(10 + (yield* random()) * 80, 14 + (yield* random()) * 70),
		Facing: (yield* random()) < 0.5 ? 1 : -1,
		Hue: schoolHue + ((yield* random()) - 0.5) * 2 * 14,
		Length: 30 + (yield* random()) * 42,
		Wobble: 2.4 + (yield* random()) * 2.2,
		Glow: 10 + (yield* random()) * 16,
		Cycles: 0
	};
}

function* createGiant(): IActionGenerator<Omit<IFish, "$Id">> {
	return {
		...atRest(10 + (yield* random()) * 80, 22 + (yield* random()) * 56),
		Facing: (yield* random()) < 0.5 ? 1 : -1,
		Hue: GIANT_HUE + ((yield* random()) - 0.5) * 2 * 12,
		Length: 210 + (yield* random()) * 54,
		Wobble: 3.4 + (yield* random()) * 1.6,
		Glow: 48 + (yield* random()) * 21,
		Cycles: 0
	};
}

export const actions = {
	addSchool,
	addFish,
	releaseFish,
	releaseSchool,
	addGiant,
	releaseGiant
};

export const AquariumReceiver = receiver<IAquarium>("AquariumReceiver")({
	*"Portal/Restored"(draft) {
		draft.Restore = {
			Fish: schoolFish(draft),
			Schools: draft.Schools.length,
			Giants: draft.Giants.length
		};
	}
});

export function* schoolCount(draft: IAquarium): ISelectorGenerator<number> {
	return draft.Schools.length;
}

export function* liveCycles(draft: IAquarium): ISelectorGenerator<number> {
	const schools = draft.Schools.reduce((n, s) => n + s.Fish.reduce((m, f) => m + f.Cycles, 0), 0);
	return schools + draft.Giants.reduce((n, g) => n + g.Cycles, 0);
}

export interface ITankFacts {
	Fish: number;
	Line: string;
	Bar: string;
	Giants: string;
	CanAddSchool: boolean;
	CanAddFish: boolean;
	CanAddGiant: boolean;
}

export function* tankFacts(draft: IAquarium): ISelectorGenerator<ITankFacts> {
	const inSchools = schoolFish(draft);
	const fish = inSchools + draft.Giants.length;
	const schools = yield* schoolCount(draft);
	return {
		Fish: fish,
		Line: fish === 0 && schools === 0 ? "An empty tank" : `${fish} fish · ${plural(schools, "school")}`,
		Bar: fish === 0 ? "Depth 800 m · no fish" : `Depth 800 m · ${fish} fish · each one an entity with its own swim timer`,
		Giants: draft.Giants.length === 0 ? "" : `Anglerfish · ${plural(draft.Giants.length, "giant")}`,
		CanAddSchool: schools < MAX_SCHOOLS,
		CanAddFish: inSchools < MAX_FISH,
		CanAddGiant: draft.Giants.length < MAX_GIANTS
	};
}

/** The tank bar's swim count, as "1,204 swims · click a fish to release it", or "" with no fish to click. */
export function* swimLine(draft: IAquarium): ISelectorGenerator<string> {
	if (schoolFish(draft) + draft.Giants.length === 0) return "";
	const swims = yield* liveCycles(draft);
	return `${swims.toLocaleString("en")} ${swims === 1 ? "swim" : "swims"} · click a fish to release it`;
}

export const selectors = {
	schoolCount,
	liveCycles,
	tankFacts,
	swimLine
};
