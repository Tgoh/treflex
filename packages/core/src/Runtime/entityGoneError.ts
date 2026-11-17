/** The entity a dispatch, an `ask` or an `openResource` names is not in the tree, or is leaving it. */
export class EntityGoneError extends Error {
	readonly id: string;
	constructor(id: string, message: string) {
		super(message);
		this.name = "EntityGoneError";
		this.id = id;
	}
}
