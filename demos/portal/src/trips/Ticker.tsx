import type { IPrice } from "./Planner";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { runTicker } from "./flourish";

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
