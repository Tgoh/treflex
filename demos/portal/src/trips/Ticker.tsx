import type { IPrice, IVoucherView } from "./Planner";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { callsForFlourish, runTicker } from "./flourish";

/**
 * Whether this view is playing the voucher's flourish, and the call that ends it. It starts when `callsForFlourish`
 * says so, at mount or later, and calls `markPlayed` as it starts.
 */
export function createFlourish(
	voucher: () => IVoucherView | null,
	markPlayed: () => void
): [
	() => boolean,
	() => void
] {
	const [playing, setPlaying] = createSignal(false);
	createEffect(
		on(
			() => callsForFlourish(voucher()),
			(calls) => {
				if (!calls) return;
				setPlaying(true);
				markPlayed();
			}
		)
	);
	return [
		playing,
		() => setPlaying(false)
	];
}

/**
 * A discounted price that, while `playing`, counts down from its full price to the discounted one after `delayMs`.
 * At rest it shows the price's real Now.
 */
export function Ticker(props: { price: IPrice; playing: boolean; delayMs: number }) {
	const [text, setText] = createSignal<string | null>(null);
	createEffect(
		on(
			() => props.playing,
			(playing) => {
				if (!playing) {
					setText(null);
					return;
				}
				onCleanup(runTicker(props.price, props.delayMs, setText));
			}
		)
	);
	return (
		<span class="now">
			<span
				class="real"
				classList={{
					ticking: text() !== null
				}}
			>
				{props.price.Now}
			</span>
			<Show when={text()}>{(shown) => <span class="tick">{shown()}</span>}</Show>
		</span>
	);
}
