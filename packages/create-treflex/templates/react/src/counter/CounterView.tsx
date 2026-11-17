import { useInFlight } from "treflex-react";
import { Counter, increment } from "./counter";

export const CounterView = Counter.provider(() => {
	const counter = Counter.use();
	const counting = useInFlight(increment, counter.state);
	return (
		<main>
			<button
				type="button"
				disabled={counting}
				onClick={() => counter.increment()}
			>
				{counting ? "Counting..." : "Count"}
			</button>
			<p>{counter.clicks()}</p>
			{counter.state.Notice && <p role="status">{counter.state.Notice}</p>}
		</main>
	);
});
