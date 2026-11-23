import type { IPortal } from "./Portal";
import type { IAppId } from "./topics";
import { aquariumRestoreLines } from "../aquarium/restoreLines";
import { chatRestoreLines } from "../chat/restoreLines";
import { tripRestoreLines } from "../trips/restoreLines";
import { APPS } from "./apps";

export interface IRestoreLines {
	Back: string[];
	Lost: string[];
}

function section(portal: IPortal, app: IAppId): IRestoreLines | null {
	switch (app) {
		case "trips": {
			const note = portal.Trips.Restore;
			return note ? tripRestoreLines(note, portal.ActiveApp === "trips" ? portal.Trips.OpenTripId : null) : null;
		}
		case "aquarium":
			return portal.Aquarium.Restore ? aquariumRestoreLines(portal.Aquarium.Restore) : null;
		case "chat":
			return portal.Chat.Restore ? chatRestoreLines(portal.Chat.Restore) : null;
		default:
			return app satisfies never;
	}
}

/** What the last restore found, the open app's lines first. */
export function restoreBanner(portal: IPortal): IRestoreLines | null {
	const active = portal.ActiveApp;
	const sections = [
		section(portal, active),
		...APPS.filter((app) => app.Id !== active).map((app) => section(portal, app.Id))
	].filter((s): s is IRestoreLines => s !== null);
	if (sections.length === 0) return null;
	const back = sections.flatMap((s) => s.Back);
	const lost = sections.flatMap((s) => s.Lost);
	if (lost.length === 0) {
		lost.push(portal.Restore?.LostAny ? "Nothing on what's still here" : "Nothing: no question or message was cut off");
	}
	return {
		Back: back,
		Lost: lost
	};
}
