import type { IActionGenerator, IEntity, IReceiverId, IRecordChange, ISelectorGenerator } from "treflex";
import type { IAquarium } from "../aquarium/Aquarium";
import type { IChat } from "../chat/Chat";
import type { ITour } from "../tour/Tour";
import type { IPlanner } from "../trips/Planner";
import type { IThreadLine } from "../trips/Trip";
import type { IRestoreLines } from "./restoreBanner";
import type { IAppId, IFinished } from "./topics";
import { publish, receiver, start, startTimer, stopTimer, transient } from "treflex";
import * as Aquarium from "../aquarium/Aquarium";
import * as Chat from "../chat/Chat";
import { conversationLabel } from "../chat/directory";
import * as Tour from "../tour/Tour";
import { DESTINATION_KEYS, DESTINATIONS } from "../trips/destinations";
import * as Planner from "../trips/Planner";
import { LEG_NAMES, SEARCH_NOUNS } from "../trips/Trip";
import { APPS, appName, onScreen } from "./apps";
import { restoreBanner as restoreBannerOf } from "./restoreBanner";
import { tourHint } from "./tourHints";

export type { IAppId } from "./topics";

declare module "treflex" {
	interface ITimerRegistry {
		"Portal/ToastTimeout": {};
	}
}

export const TOAST_MS = 9000;

/** What the last restore found across the apps, kept as it was so the banner reports the restore. */
export interface IPortalRestore {
	/** Whether any search, question or send was cut off, whatever has been removed since. */
	LostAny: boolean;
}

export interface IPortal extends IEntity {
	readonly $Receiver?: IReceiverId<IPortal>;
	ActiveApp: IAppId;
	RecordsOpen: boolean;
	Restore: IPortalRestore | null;
	Tour: ITour;
	Trips: IPlanner;
	Aquarium: IAquarium;
	Chat: IChat;
}

export const ROOT_ID = "Portal";

export function getDefaultState(): IPortal {
	return {
		$Id: ROOT_ID,
		$Receiver: PortalReceiver.Id,
		ActiveApp: "trips",
		RecordsOpen: false,
		Restore: null,
		Tour: Tour.getDefaultState("Tour"),
		Trips: Planner.getDefaultState("Trips"),
		Aquarium: Aquarium.getDefaultState("Aquarium"),
		Chat: Chat.getDefaultState("Chat")
	};
}

const NO_TOAST: {
	Toast: IFinished | null;
} = {
	Toast: null
};

export const toastMark = (draft: IPortal) => transient(draft, "Portal/Toast", NO_TOAST);

/** A fresh session's setup. A restore doesn't run it: what it made is in the snapshot. */
export function* init(draft: IPortal): IActionGenerator {
	yield* start(Aquarium.init, draft.Aquarium);
	yield* start(Chat.init, draft.Chat);
}

function* clearShownToast(draft: IPortal): IActionGenerator {
	const mark = yield* toastMark(draft);
	if (!mark.Toast || !onScreen(draft, mark.Toast.App, mark.Toast.Target)) return;
	mark.Toast = null;
	yield* stopTimer(draft, "Portal/ToastTimeout");
}

export function* openApp(draft: IPortal, app: IAppId): IActionGenerator {
	if (draft.ActiveApp === app) return;
	const previous = draft.ActiveApp;
	draft.ActiveApp = app;
	yield* clearShownToast(draft);
	yield* publish("Portal/AppHidden", {
		App: previous
	});
	yield* publish("Portal/AppShown", {
		App: app
	});
}

export function* toggleRecords(draft: IPortal): IActionGenerator {
	draft.RecordsOpen = !draft.RecordsOpen;
}

export function* dismissRestore(draft: IPortal): IActionGenerator {
	draft.Restore = null;
	draft.Trips.Restore = null;
	draft.Aquarium.Restore = null;
	draft.Chat.Restore = null;
}

export function* dismissToast(draft: IPortal): IActionGenerator {
	const mark = yield* toastMark(draft);
	mark.Toast = null;
	yield* stopTimer(draft, "Portal/ToastTimeout");
}

export function* followToast(draft: IPortal): IActionGenerator {
	const mark = yield* toastMark(draft);
	if (!mark.Toast) return;
	const { App, Target } = mark.Toast;
	mark.Toast = null;
	yield* stopTimer(draft, "Portal/ToastTimeout");
	yield* openApp(draft, App);
	if (App === "trips") yield* start(Planner.openTrip, draft.Trips, Target);
	if (App === "chat") yield* start(Chat.openConversation, draft.Chat, Target);
}

export function* applyToastVoucher(draft: IPortal): IActionGenerator {
	const mark = yield* toastMark(draft);
	if (!mark.Toast?.Voucher) return;
	mark.Toast = null;
	yield* stopTimer(draft, "Portal/ToastTimeout");
	yield* start(Chat.applyVoucher, draft.Chat);
}

export function* announceRestore(_draft: IPortal, droppedEntityIds: string[]): IActionGenerator {
	yield* publish("Portal/Restored", {
		DroppedEntityIds: droppedEntityIds
	});
}

export const actions = {
	openApp,
	toggleRecords,
	dismissRestore,
	dismissToast,
	followToast,
	applyToastVoucher
};

export const PortalReceiver = receiver<IPortal>("PortalReceiver")({
	*"Portal/Finished"(draft, message): IActionGenerator {
		if (onScreen(draft, message.App, message.Target)) return;
		const mark = yield* toastMark(draft);
		mark.Toast = {
			App: message.App,
			Target: message.Target,
			Title: message.Title,
			Text: message.Text,
			Link: message.Link,
			...(message.Voucher
				? {
						Voucher: true
					}
				: {})
		};
		yield* stopTimer(draft, "Portal/ToastTimeout");
		yield* startTimer(draft, "Portal/ToastTimeout", PortalReceiver, TOAST_MS);
	},
	*"Portal/ToastTimeout"(draft): IActionGenerator {
		yield* stopTimer(draft, "Portal/ToastTimeout");
		const mark = yield* toastMark(draft);
		mark.Toast = null;
	},
	"Portal/Viewed": clearShownToast,
	*"Portal/Restored"(draft): IActionGenerator {
		draft.Restore = {
			LostAny: false
		};
	},
	*"Portal/RestoreFound"(draft, message): IActionGenerator {
		draft.Restore = {
			LostAny: (draft.Restore?.LostAny ?? false) || message.CutOff
		};
	}
});

export function* tourStep(draft: IPortal): ISelectorGenerator<number | null> {
	if (draft.Tour.Skipped) return null;
	return yield* Tour.currentStep(draft.Tour);
}

/** The "finished while you were away" notice. */
export function* toast(draft: IPortal): ISelectorGenerator<IFinished | null> {
	return (yield* toastMark(draft)).Toast;
}

/** The toast's "Apply to my trips" button label, while its message carries a voucher not yet applied. */
export function* toastVoucher(draft: IPortal): ISelectorGenerator<string | null> {
	const shown = (yield* toastMark(draft)).Toast;
	return shown?.Voucher && !draft.Chat.VoucherApplied ? "Apply to my trips" : null;
}

export function* restoreBanner(draft: IPortal): ISelectorGenerator<IRestoreLines | null> {
	return restoreBannerOf(draft);
}

/** Each app's `ViewKey`, for a view that holds the apps as entity refs and so can't read into them. */
export function* viewKeys(draft: IPortal): ISelectorGenerator<Record<IAppId, unknown>> {
	return Object.fromEntries(
		APPS.map((app) => [
			app.Id,
			app.ViewKey(draft)
		])
	) as Record<IAppId, unknown>;
}

export const selectors = {
	tourHint,
	tourStep,
	toast,
	toastVoucher,
	restoreBanner,
	viewKeys
};

export interface IEntityLabel {
	Label: string;
	Lane: string;
	LaneName: string;
}

function written(changes: readonly IRecordChange[], field: string): unknown {
	return changes.find((change) => change.Path.at(-1) === field)?.Value;
}

export function describeStep(state: IPortal, entityId: string, changes: readonly IRecordChange[]): string | null {
	for (const trip of state.Trips.Trips) {
		const leg = trip.Legs.find((l) => l.$Id === entityId);
		if (leg) {
			const checked = written(changes, "Checked");
			if (typeof checked === "number") return `${SEARCH_NOUNS[leg.Kind]} ${checked}/${leg.Total}`;
			if (written(changes, "Started") === true) return `${SEARCH_NOUNS[leg.Kind]} started`;
			return null;
		}
		if (trip.$Id !== entityId) continue;
		const choice = written(changes, "Choice") as
			| {
					Slot?: string;
			  }
			| undefined;
		if (choice?.Slot) return `chose ${choice.Slot.toLowerCase()} flight`;
		if (written(changes, "Finished") === true) return "ready to review";
		const lines = changes
			.filter((change) => change.Path.at(-2) === "Thread" && change.Created)
			.map((change) => change.Value as Partial<IThreadLine>);
		const parts = lines.map((line) => (line.Divider ? "marks the reload" : `says “${(line.Text ?? "").replaceAll("**", "")}”`));
		return parts.length > 0 ? parts.join(" · ") : null;
	}
	return null;
}

export const LANE_ORDER: readonly string[] = [
	"portal",
	...APPS.map((app) => app.Id),
	...DESTINATION_KEYS
];

export function labelIndex(state: IPortal): Map<string, IEntityLabel> {
	const index = new Map<string, IEntityLabel>();
	index.set(state.$Id, {
		Label: "Portal",
		Lane: "portal",
		LaneName: "Portal"
	});
	index.set(state.Tour.$Id, {
		Label: "Tour",
		Lane: "portal",
		LaneName: "Portal"
	});
	const planner = appName("trips");
	index.set(state.Trips.$Id, {
		Label: planner,
		Lane: "trips",
		LaneName: planner
	});
	for (const trip of state.Trips.Trips) {
		const name = trip.Name;
		const lane = {
			Lane: trip.Destination,
			LaneName: DESTINATIONS[trip.Destination].Name
		};
		index.set(trip.$Id, {
			Label: `${name}/Trip`,
			...lane
		});
		for (const leg of trip.Legs) {
			index.set(leg.$Id, {
				Label: `${name}/${LEG_NAMES[leg.Kind]}`,
				...lane
			});
		}
	}
	const aquarium = {
		Lane: "aquarium",
		LaneName: appName("aquarium")
	};
	const tag = (id: string) => id.replace(/^~/, "").slice(-4);
	index.set(state.Aquarium.$Id, {
		Label: "Aquarium",
		...aquarium
	});
	for (const school of state.Aquarium.Schools) {
		index.set(school.$Id, {
			Label: `Aquarium/School ${school.Name}`,
			...aquarium
		});
		for (const fish of school.Fish) {
			index.set(fish.$Id, {
				Label: `Aquarium/Fish ${tag(fish.$Id)}`,
				...aquarium
			});
		}
	}
	for (const giant of state.Aquarium.Giants) {
		index.set(giant.$Id, {
			Label: `Aquarium/Giant ${tag(giant.$Id)}`,
			...aquarium
		});
	}
	const chat = {
		Lane: "chat",
		LaneName: appName("chat")
	};
	index.set(state.Chat.$Id, {
		Label: "Chat",
		...chat
	});
	for (const conversation of state.Chat.Conversations) {
		const where = conversationLabel(conversation.Key);
		index.set(conversation.$Id, {
			Label: `Chat/${where}`,
			...chat
		});
		for (const message of conversation.Messages) {
			index.set(message.$Id, {
				Label: `Chat/${where}/Message`,
				...chat
			});
		}
	}
	return index;
}
