import type { IPrice, IVoucherView } from "../../../portal/src/trips/Planner";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { callsForFlourish, runTicker } from "../../../portal/src/trips/flourish";
import { cx } from "../shell/dom";

/**
 * Whether this view is playing the voucher's flourish, and the call that ends it. It starts when `callsForFlourish`
 * says so, at mount or later, and calls `markPlayed` as it starts.
 */
export function useFlourish(
	voucher: IVoucherView | null,
	markPlayed: () => void
): [
	boolean,
	() => void
] {
	const calls = callsForFlourish(voucher);
	// An initialiser, not an effect: the first frame already plays.
	const [playing, setPlaying] = useState(calls);
	const [called, setCalled] = useState(calls);
	if (calls !== called) {
		setCalled(calls);
		if (calls) setPlaying(true);
	}
	useEffect(() => {
		if (calls) markPlayed();
	}, [
		calls,
		markPlayed
	]);
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
	const [text, setText] = useState<string | null>(null);
	const latest = useRef(props);
	useLayoutEffect(() => {
		latest.current = props;
	});
	const playing = props.playing;
	useLayoutEffect(() => {
		if (!playing) {
			setText(null);
			return;
		}
		return runTicker(latest.current.price, latest.current.delayMs, setText);
	}, [
		playing
	]);
	return (
		<span className="now">
			<span
				className={cx("real", {
					ticking: text !== null
				})}
			>
				{props.price.Now}
			</span>
			{text ? <span className="tick">{text}</span> : null}
		</span>
	);
}
