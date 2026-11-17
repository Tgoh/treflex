import { wallClock } from "../portal/clock";
import { GIANT_HUE } from "./Aquarium";

function sequence(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 16807) % 2147483647;
		return s / 2147483647;
	};
}

const rnd = sequence(7);

export interface ISnowflake {
	x: number;
	delay: number;
	dur: number;
	size: number;
	drift: number;
}

export interface IBubble {
	x: number;
	delay: number;
	dur: number;
	size: number;
}

export const SNOW: readonly ISnowflake[] = Array.from(
	{
		length: 22
	},
	() => ({
		x: rnd() * 100,
		delay: -rnd() * 26,
		dur: 16 + rnd() * 22,
		size: 1 + rnd() * 2.4,
		drift: (rnd() - 0.5) * 60
	})
);

export const BUBBLES: readonly IBubble[] = Array.from(
	{
		length: 9
	},
	() => ({
		x: rnd() * 100,
		delay: -rnd() * 14,
		dur: 9 + rnd() * 10,
		size: 3 + rnd() * 9
	})
);

/**
 * The `animation-delay`, in seconds, that starts a loop of `durationS` at the phase the wall clock puts it
 * at, so an element the view mounts again carries the loop on instead of restarting it. `offsetS` is the
 * delay the loop would have had, which staggers it against others of the same length.
 */
export function loopDelay(durationS: number, offsetS = 0): number {
	const phase = (((wallClock() / 1000 - offsetS) % durationS) + durationS) % durationS;
	return -phase;
}

/** The `.photophore` glow's loop length in styles/aquarium.css. */
export const PHOTOPHORE_S = 2.7;

/** How far each of a fish's three photophores lags the one before it. */
export const PHOTOPHORE_STAGGER_S = 0.5;

/** The dot on a school's chip. */
export function schoolColour(hue: number): string {
	return `hsl(${hue} 90% 60%)`;
}

export const GIANT_COLOUR = `hsl(${GIANT_HUE} 95% 60%)`;
