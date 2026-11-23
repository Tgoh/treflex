import type { IActionGenerator, IEntity, IRuntime } from "treflex";

interface IFetchResult {
	Status: number;
	Body: unknown;
}
interface IDelayEffect extends IEffect {
	Type: "app/delay";
	Ms: number;
}
interface IForm {
	Title: string;
}
declare const runtime: IRuntime<IEntity>;
declare function getSession(): IActionGenerator<{ BaseUrl: string }>;
