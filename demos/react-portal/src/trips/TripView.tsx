import type { IRestoreProps } from "../shell/RestoreBanner";
import { Fragment } from "react";
import { clock, money, segments } from "../../../portal/src/text";
import { DESTINATIONS } from "../../../portal/src/trips/destinations";
import { endsFlourish, SPARK_COUNT, TOTAL_TICK_DELAY_MS } from "../../../portal/src/trips/flourish";
import { priced } from "../../../portal/src/trips/Planner";
import { cx } from "../shell/dom";
import { RestoreBanner } from "../shell/RestoreBanner";
import { Planner, Trip } from "./contexts";
import { FlightQuestion } from "./FlightQuestion";
import { LegCard } from "./LegCard";
import { Ticker } from "./Ticker";

const SPARKS = Array.from(
	{
		length: SPARK_COUNT
	},
	(_, i) => i
);

function Line(props: { text: string }) {
	return (
		<>
			{segments(props.text).map((s, at) =>
				// biome-ignore lint/suspicious/noArrayIndexKey: a line's segments never reorder
				s.Bold ? <b key={at}>{s.Text}</b> : <Fragment key={at}>{s.Text}</Fragment>
			)}
		</>
	);
}

export const TripView = Trip.provider<{
	tourOnQuestion: boolean;
	restore: IRestoreProps;
}>((props) => {
	const trip = Trip.use();
	const planner = Planner.use();
	const destination = DESTINATIONS[trip.state.Destination];
	const busy = trip.tripFacts().Running > 0;
	const voucher = planner.voucher();
	const total = priced(trip.soFar(), voucher);
	const flourish = voucher?.Flourish ?? false;
	const options = trip.flightOptions();
	const typing = trip.typing();
	const tip = trip.tip();

	return (
		<>
			<div className="top">
				<div className="crumbs">
					<button type="button" onClick={() => planner.openTrip(null)}>
						Trip planner
					</button>
					<span>/</span>
					<b>{trip.state.Name}</b>
				</div>
				<div className="btns">
					<button type="button" className="btn" onClick={() => planner.removeTrip(trip.state.$Id)}>
						Start over
					</button>
					<button type="button" className="btn dark" onClick={() => planner.openTrip(null)}>
						+ New trip
					</button>
				</div>
			</div>

			<div className="tscroll">
				<section
					className={cx("hero", {
						burst: flourish
					})}
				>
					<svg preserveAspectRatio="none" aria-hidden="true">
						<rect width="100%" height="100%" fill={`url(#hero-${trip.state.Destination})`} />
					</svg>
					<div
						style={{
							position: "relative"
						}}
					>
						<div className="kicker">{trip.headline()}</div>
						<h1 className="serif">
							{trip.state.Name}
							<em>, {destination.NightsWord} nights</em>
						</h1>
						<p>
							{destination.Dates} · {destination.Travellers} adults · from {destination.From}
						</p>
					</div>
					<div
						className={cx("total", {
							over: total.Amount > destination.Budget,
							vdrop: flourish
						})}
						onAnimationEnd={(event) => {
							if (endsFlourish(event)) void planner.flourishPlayed();
						}}
					>
						<small>So far</small>
						<b>
							{total.Was ? <s>{total.Was}</s> : null}
							<Ticker price={total} playing={flourish} delayMs={TOTAL_TICK_DELAY_MS} />
						</b>
						{voucher ? (
							<div className="vpill">
								{voucher.Pill}
								<span className="sparks" aria-hidden="true">
									{SPARKS.map((i) => (
										<i key={i} />
									))}
								</span>
							</div>
						) : null}
						<div>of {money(destination.Budget)}</div>
					</div>
				</section>

				<div className="tbody">
					<div className="board">
						<RestoreBanner restore={props.restore} />
						{options ? <FlightQuestion options={options} highlight={props.tourOnQuestion} /> : null}
						<div className="legs">
							{trip.state.Legs.map((leg) => (
								<LegCard key={leg.$Id} state={leg} />
							))}
						</div>
					</div>

					<aside className="rail">
						<div className="agent">
							<div
								className={cx("av", {
									busy
								})}
							>
								P
							</div>
							<div>
								<b>Your planner</b>
								<small>{trip.agentStatus()}</small>
							</div>
						</div>
						<h3>
							What I've done <span>{clock(trip.state.Elapsed)}</span>
						</h3>
						<div className="feed">
							{trip.state.Thread.map((line, at) =>
								line.Divider ? (
									// biome-ignore lint/suspicious/noArrayIndexKey: the thread only grows at its end
									<div className="divider" key={at}>
										{line.Text}
									</div>
								) : (
									// biome-ignore lint/suspicious/noArrayIndexKey: the thread only grows at its end
									<div className="msg" key={at}>
										<time>{clock(line.At)}</time>
										<div>
											<Line text={line.Text} />
											{line.Asked ? <span className="chip">Asked you</span> : null}
										</div>
									</div>
								)
							)}
						</div>
						{typing ? (
							<div className="typing">
								<span className="dots">
									<i />
									<i />
									<i />
								</span>
								{typing}
							</div>
						) : null}
						<div className="tip">
							<b>{tip.Lead}</b> {tip.Text}
						</div>
					</aside>
				</div>
			</div>
		</>
	);
});
