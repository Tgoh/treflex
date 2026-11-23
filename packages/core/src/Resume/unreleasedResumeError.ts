import { errorClass } from "../Utility/errorClasses";

/**
 * A public dispatch or a `start` refused after a restore resumed work and before it released the
 * held waits: a dispatch that would have waited behind a resumed action's hold, or a dispatch or a
 * `start` of a function the restore resumed on that entity, which a `start` throws into its starter.
 * See docs/reference/restart-and-records.md#the-window-before-the-release.
 *
 * @experimental
 */
export class UnreleasedResumeError extends Error {
	/** The resumed action's durable name. */
	readonly actionName: string;
	/** The resumed action's id in the save, as `result.resumed` names it. */
	readonly actionId: string;
	/** The resumed action's entity, which the dispatch was for. */
	readonly entityId: string;
	constructor(
		message: string,
		resumed: {
			readonly name: string;
			readonly actionId: string;
			readonly entityId: string;
		}
	) {
		super(message);
		this.name = "UnreleasedResumeError";
		this.actionName = resumed.name;
		this.actionId = resumed.actionId;
		this.entityId = resumed.entityId;
	}
}

errorClass("treflex/UnreleasedResumeError", UnreleasedResumeError);
