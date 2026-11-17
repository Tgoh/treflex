import type { IPrice } from "./Planner";
import { tickerText } from "./Planner";

/** The ticker's run after its delay; the `.vdrop` keyframes in styles/trips.css are timed around it. */
export const TICK_MS = 700;

/** When the "So far" total's ticker starts, matching `.total.vdrop .now` in styles/trips.css. */
export const TOTAL_TICK_DELAY_MS = 650;

/** When the first destination card's ticker starts, matching `.cards.vdrop .card .meta .now` in styles/trips.css. */
export const CARD_TICK_MS = 450;

/** How far each card's ticker lags the one before it: the 120ms by which `--i` staggers the card keyframes in styles/trips.css. */
export const CARD_STAGGER_MS = 120;

/** One per `.sparks i:nth-child` rule in styles/trips.css. */
export const SPARK_COUNT = 14;

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Counts `price` down from its full price to the discounted one, `delayMs` after the first animation frame, calling
 * `show` each frame with the text to overlay and with null once it ends. Returns the stop, which clears the overlay.
 */
export function runTicker(price: IPrice, delayMs: number, show: (text: string | null) => void): () => void {
	if (price.Was === null || reducedMotion()) {
		show(null);
		return () => {};
	}
	let start: number | null = null;
	const step = (at: number): void => {
		start ??= at;
		const progress = (at - start - delayMs) / TICK_MS;
		show(progress >= 1 ? null : tickerText(price, progress));
		if (progress < 1) frame = requestAnimationFrame(step);
	};
	let frame = requestAnimationFrame(step);
	return () => {
		cancelAnimationFrame(frame);
		show(null);
	};
}

/** Whether an animationend is the flourish timeline's own, not one bubbled from a child or a pseudo-element. */
export function endsFlourish(event: { target: EventTarget | null; currentTarget: EventTarget | null; pseudoElement: string }): boolean {
	return event.target === event.currentTarget && event.pseudoElement === "";
}
