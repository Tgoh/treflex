import type { IPrice } from "../../../portal/src/trips/Planner";
import { useLayoutEffect, useRef, useState } from "react";
import { runTicker } from "../../../portal/src/trips/flourish";
import { cx } from "../shell/dom";

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
