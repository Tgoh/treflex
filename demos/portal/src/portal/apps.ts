import type { IPortal } from "./Portal";
import type { IAppId } from "./topics";

export type IAppIcon = "plane" | "fish" | "chat";

export interface IAppInfo {
	Id: IAppId;
	Name: string;
	Icon: IAppIcon;
	/** What the app's view shows. A view that failed tries again when this changes. */
	ViewKey: (portal: IPortal) => unknown;
	/** Whether the open view shows this trip or conversation, given the app is the active one. */
	Shows: (portal: IPortal, target: string) => boolean;
}

export const APPS: readonly IAppInfo[] = [
	{
		Id: "trips",
		Name: "Trip planner",
		Icon: "plane",
		ViewKey: (portal) => portal.Trips.OpenTripId,
		Shows: (portal, target) => portal.Trips.OpenTripId === target
	},
	{
		Id: "aquarium",
		Name: "Aquarium",
		Icon: "fish",
		ViewKey: () => null,
		Shows: () => true
	},
	{
		Id: "chat",
		Name: "Team chat",
		Icon: "chat",
		ViewKey: (portal) => portal.Chat.OpenId,
		Shows: (portal, target) => portal.Chat.OpenId === target
	}
];

export function appName(id: IAppId): string {
	return APPS.find((app) => app.Id === id)?.Name ?? id;
}

export function appIcon(id: IAppId): IAppIcon {
	return APPS.find((app) => app.Id === id)?.Icon ?? "plane";
}

export function onScreen(portal: IPortal, app: IAppId, target: string): boolean {
	return portal.ActiveApp === app && (APPS.find((a) => a.Id === app)?.Shows(portal, target) ?? false);
}
