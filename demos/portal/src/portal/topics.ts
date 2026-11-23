export type IAppId = "trips" | "aquarium" | "chat";

export interface IFinished {
	App: IAppId;
	/** The trip or conversation the work finished on. */
	Target: string;
	Title: string;
	Text: string;
	Link: string;
	/** The finished message carries the travel voucher, so the toast can apply it. */
	Voucher?: true;
}

/** An action a restore resumed or dropped, by its durable name and the entity it ran on. */
export interface IRestoredWork {
	Name: string | null;
	EntityId: string;
}

declare module "treflex" {
	interface IMessageRegistry {
		"Portal/Restored": {
			Resumed: IRestoredWork[];
			Dropped: IRestoredWork[];
		};
		"Portal/AppShown": {
			App: IAppId;
		};
		"Portal/AppHidden": {
			App: IAppId;
		};
		"Portal/Finished": IFinished;
		/** An app put another trip or conversation on screen. */
		"Portal/Viewed": {};
		/** An app's report of what the restore found in it, published to the portal from its Portal/Restored case. */
		"Portal/RestoreFound": {
			/** Work the restore stopped: a trip's flight question, or a send. */
			CutOff: boolean;
		};
		/** The chat's travel voucher was applied, once: every trip, current and future, takes Percent off. */
		"Portal/VoucherApplied": {
			Percent: number;
			/** The first name of the teammate who sent it. */
			From: string;
		};
	}
}
