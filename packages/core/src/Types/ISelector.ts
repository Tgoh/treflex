import type { IWorkTag } from "../Runtime/workTag";
import type { IEntity } from "./IEntity";

/**
 * A selector is a generator that yields reads and returns a derived value. The state argument
 * is the slice the selector is evaluated against — held sub-references survive `yield*` chains
 * within the selector.
 */
export type ISelector<S, R = any> = (draft: S) => ISelectorGenerator<R>;

/** What a read yields: the closed set the runtime answers itself, which a selector may yield and nothing else. */
export type IRead =
	| {
			readonly Type: "getData";
			readonly Key: string;
			readonly FromId: string;
	  }
	| {
			readonly Type: "getDataGlobal";
			readonly Key: string;
	  }
	| {
			readonly Type: "getDataPath";
			readonly Key: string;
			readonly FromId: string;
	  }
	| {
			readonly Type: "select";
			readonly Accessor: ((state: any) => unknown) | undefined;
			readonly Selector: ISelector<any, unknown>;
	  }
	| {
			readonly Type: "transient";
			readonly Owner: IEntity;
			readonly Name: string;
			readonly Initial: object;
	  }
	| {
			readonly Type: "inFlight";
			readonly Actions: readonly (Function | IWorkTag)[];
			readonly Owner: IEntity;
	  }
	| {
			readonly Type: "pendingAsks";
			readonly Owner: IEntity;
	  }
	| {
			readonly Type: "external";
			readonly Key: string;
	  };

/** A read's generator, which an action and a selector can both `yield*`. */
export type IReadGenerator<R> = Generator<IRead, R, any>;

export type ISelectorGenerator<R = any> = Generator<IRead, R, any>;
