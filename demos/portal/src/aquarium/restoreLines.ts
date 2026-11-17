import type { IRestoreLines } from "../portal/restoreBanner";
import type { IAquariumRestore } from "./Aquarium";
import { listed, plural } from "../text";

export function aquariumRestoreLines(note: IAquariumRestore): IRestoreLines | null {
	const parts: string[] = [];
	if (note.Fish > 0) parts.push(`${note.Fish} fish in ${plural(note.Schools, "school")}`);
	else if (note.Schools > 0) parts.push(plural(note.Schools, "empty school"));
	if (note.Giants > 0) parts.push(plural(note.Giants, "giant"));
	if (parts.length === 0) return null;
	const swimmers = note.Fish + note.Giants;
	const timers = swimmers === 0 ? "" : swimmers === 1 ? ", with its swim timer" : ", each with its swim timer";
	return {
		Back: [
			`The aquarium's ${listed(parts)}${timers}`
		],
		Lost: []
	};
}
