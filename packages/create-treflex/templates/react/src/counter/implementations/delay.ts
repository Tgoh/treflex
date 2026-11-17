import { implementation } from "treflex";
import { delay } from "../effects";

export const delayImpl = implementation(
	delay,
	(effect) => new Promise<void>((resolve) => setTimeout(resolve, effect.Ms)),
);
