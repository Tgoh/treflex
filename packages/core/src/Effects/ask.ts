import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";

export interface IAskEffect extends IEffect {
	Type: "ask";
	OwnerId: string;
	Request: unknown;
}

/**
 * Asks the person a question about `owner`, an entity attached now in any of the three roots, and waits for the answer.
 * `request` is plain data, copied and frozen at the yield like any message; a view finds the ask
 * with `pendingAsks(owner)` and answers it with `answer`. Answers `undefined` when the ask is dismissed or
 * its owner leaves.
 *
 * Ask from the action's own generator, not a branch of `parallel` or `parallelSettled`, and from an
 * action that holds an entity, wait inside `open(...)`, or the ask throws `AskRefusedError`: an answer
 * that needs the entity would queue behind the asker. See docs/reference/conversations.md#ask-and-answer.
 */
export function* ask<R>(owner: IEntity | string, request: unknown): IActionGenerator<R | undefined> {
	return yield {
		Type: "ask",
		OwnerId: typeof owner === "string" ? owner : owner.$Id,
		Request: request
	};
}
