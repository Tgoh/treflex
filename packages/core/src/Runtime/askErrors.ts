import { TreflexRefusal } from "./refusal";

export type IAskRefusedReason = "outside-open" | "in-branch" | "in-run";

function messageOf(reason: IAskRefusedReason, actionName: string, entityId: string, ownerId: string): string {
	if (reason === "in-run") {
		return (
			`[treflex] ask: the r.run of resource "${actionName}" on "${entityId}" asked on "${ownerId}". A method can be called from an action on any ` +
			`entity, holding anything, so nothing can tell whether the answer would queue behind it: a resource can't ask a person. ` +
			`Emit, and let an action ask (docs/reference/conversations.md#what-an-ask-takes).`
		);
	}
	if (reason === "in-branch") {
		return (
			`[treflex] ask: action "${actionName}" asked on "${ownerId}" from a branch of parallel or parallelSettled. An ask comes from the ` +
			`action's own generator, so nothing else of the action runs while it waits: ask before or after the fan-out, or start the work ` +
			`that runs beside the ask (docs/reference/conversations.md#ask-and-answer).`
		);
	}
	return (
		`[treflex] ask: action "${actionName}" holds "${entityId}" and waits for an answer on "${ownerId}" outside open(...), so an ` +
		`answer that needs "${entityId}" would queue behind it. Wait for the answer inside open(...) ` +
		`(docs/reference/conversations.md#ask-and-answer).`
	);
}

export class AskRefusedError extends TreflexRefusal {
	readonly reason: IAskRefusedReason;
	/** The asking action's name, or for an r.run, its resource's key. */
	readonly actionName: string;
	/** The entity the asker holds, or runs on if it holds none; for an r.run, its resource's owner. */
	readonly entityId: string;
	readonly ownerId: string;
	constructor(reason: IAskRefusedReason, actionName: string, entityId: string, ownerId: string) {
		super(messageOf(reason, actionName, entityId, ownerId));
		this.name = "AskRefusedError";
		this.reason = reason;
		this.actionName = actionName;
		this.entityId = entityId;
		this.ownerId = ownerId;
	}
}

export class AnswerOutsideOwnerError extends TreflexRefusal {
	readonly ownerId: string;
	readonly answererId: string;
	constructor(ownerId: string, answererId: string) {
		super(
			`[treflex] answer: the answering action runs on "${answererId}", which is neither the ask's owner "${ownerId}" nor below it, ` +
				`so it could be queued behind the asker. Dispatch the answer on the owner, or publish to a receiver there ` +
				`(docs/reference/conversations.md#ask-and-answer).`
		);
		this.name = "AnswerOutsideOwnerError";
		this.ownerId = ownerId;
		this.answererId = answererId;
	}
}
