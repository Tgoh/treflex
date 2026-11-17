import type { IActionGenerator } from "../Types/IAction";
import type { IAskId } from "../Types/IAskId";
import type { IEffect } from "../Types/IEffect";

export interface IAnswerEffect extends IEffect {
	Type: "answer";
	AskId: string;
	Data: any;
}

/** Answers the ask `id`. With no value, or `undefined`, it dismisses: the asker resumes with `undefined`. */
export function* answer<R>(id: IAskId<R>, data?: NoInfer<R>): IActionGenerator {
	yield {
		Type: "answer",
		AskId: id,
		Data: data
	};
}
