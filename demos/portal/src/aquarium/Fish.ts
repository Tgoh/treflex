import type { IEntity } from "treflex";
import { receiver } from "treflex";
import { now, random } from "../backend/backend";

declare module "treflex" {
	interface ITimerRegistry {
		"Fish/Swim": {};
	}
}

export interface IFish extends IEntity {
	/** Percent of the tank's width. */
	X: number;
	/** Percent of the tank's height. */
	Y: number;
	/** Where the latest swim to X and Y set off from. */
	FromX: number;
	FromY: number;
	/** When the latest swim set off, in ms since the epoch, or 0 before the first. */
	SwamAt: number;
	/** 1 faces right, -1 left. */
	Facing: number;
	Hue: number;
	/** In px. */
	Length: number;
	/** In seconds. */
	Wobble: number;
	/** In px. */
	Glow: number;
	Cycles: number;
}

/** How long one swim's glide takes. `.fish-slot`'s transition in styles/aquarium.css must match it. */
export const SWIM_MS = 2600;

// The fish's own timer row, started by addFish or addGiant, is the loop.
export const FishReceiver = receiver<IFish>("FishReceiver")({
	*"Fish/Swim"(draft) {
		const nextX = 7 + (yield* random()) * 86;
		draft.FromX = draft.X;
		draft.FromY = draft.Y;
		draft.SwamAt = yield* now();
		draft.Facing = nextX >= draft.X ? 1 : -1;
		draft.X = nextX;
		draft.Y = 12 + (yield* random()) * 74;
		draft.Cycles++;
	}
});

export interface ISwimInProgress {
	FromX: number;
	FromY: number;
	/** How far into the glide, in ms. */
	Elapsed: number;
}

/** The swim a view mounting at `at` should pick up part-way, or null when the fish is at rest at X and Y. */
export function swimInProgress(fish: IFish, at: number): ISwimInProgress | null {
	if (fish.SwamAt === 0) return null;
	const elapsed = Math.max(0, at - fish.SwamAt);
	if (elapsed >= SWIM_MS) return null;
	return {
		FromX: fish.FromX,
		FromY: fish.FromY,
		Elapsed: elapsed
	};
}
