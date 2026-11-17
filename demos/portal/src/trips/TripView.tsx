import type { IRestoreProps } from "../shell/RestoreBanner";
import { For, Show } from "solid-js";
import { RestoreBanner } from "../shell/RestoreBanner";
import { clock, money, segments } from "../text";
import { Planner, Trip } from "./contexts";
import { DESTINATIONS } from "./destinations";
import { FlightQuestion } from "./FlightQuestion";
import { endsFlourish, SPARK_COUNT, TOTAL_TICK_DELAY_MS } from "./flourish";
import { LegCard } from "./LegCard";
import { priced } from "./Planner";
import { createFlourish, Ticker } from "./Ticker";

const SPARKS = Array.from(
	{
		length: SPARK_COUNT
	},
	(_, i) => i
);

function Line(props: { text: string }) {
	return <For each={segments(props.text)}>{(s) => (s.Bold ? <b>{s.Text}</b> : s.Text)}</For>;
}

export const TripView = Trip.provider<{
	tourOnQuestion: boolean;
	restore: IRestoreProps;
}>((props) => {
	const trip = Trip.use();
	const planner = Planner.use();
	const destination = () => DESTINATIONS[trip.state.Destination];
	const busy = () => trip.tripFacts().Running > 0;
	const total = () => priced(trip.soFar(), planner.voucher());
	const [flourish, endFlourish] = createFlourish(
		() => planner.voucher(),
		() => void planner.flourishPlayed()
	);

	return (
		<>
			<div class="top">
				<div class="crumbs">
					<button type="button" onClick={() => planner.openTrip(null)}>
						Trip planner
					</button>
					<span>/</span>
					<b>{trip.state.Name}</b>
				</div>
				<div class="btns">
					<button type="button" class="btn" onClick={() => planner.removeTrip(trip.state.$Id)}>
						Start over
					</button>
					<button type="button" class="btn dark" onClick={() => planner.openTrip(null)}>
						+ New trip
					</button>
				</div>
			</div>

			<div class="tscroll">
				<section
					class="hero"
					classList={{
						burst: flourish()
					}}
				>
					<svg preserveAspectRatio="none" aria-hidden="true">
						<rect width="100%" height="100%" fill={`url(#hero-${trip.state.Destination})`} />
					</svg>
					<div
						style={{
							position: "relative"
						}}
					>
						<div class="kicker">{trip.headline()}</div>
						<h1 class="serif">
							{trip.state.Name}
							<em>, {destination().NightsWord} nights</em>
						</h1>
						<p>
							{destination().Dates} · {destination().Travellers} adults · from {destination().From}
						</p>
					</div>
					<div
						class="total"
						classList={{
							over: total().Amount > destination().Budget,
							vdrop: flourish()
						}}
						onAnimationEnd={(event) => {
							if (endsFlourish(event)) endFlourish();
						}}
					>
						<small>So far</small>
						<b>
							<Show when={total().Was}>{(was) => <s>{was()}</s>}</Show>
							<Ticker price={total()} playing={flourish()} delayMs={TOTAL_TICK_DELAY_MS} />
						</b>
						<Show when={planner.voucher()}>
							{(voucher) => (
								<div class="vpill">
									{voucher().Pill}
									<span class="sparks" aria-hidden="true">
										<For each={SPARKS}>{() => <i />}</For>
									</span>
								</div>
							)}
						</Show>
						<div>of {money(destination().Budget)}</div>
					</div>
				</section>

				<div class="tbody">
					<div class="board">
						<RestoreBanner restore={props.restore} />
						<Show when={trip.flightOptions()}>{(options) => <FlightQuestion options={options()} highlight={props.tourOnQuestion} />}</Show>
						<div class="legs">
							<For each={trip.state.Legs}>{(leg) => <LegCard state={leg} />}</For>
						</div>
					</div>

					<aside class="rail">
						<div class="agent">
							<div
								class="av"
								classList={{
									busy: busy()
								}}
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
						<div class="feed">
							<For each={trip.state.Thread}>
								{(line) => (
									<Show when={!line.Divider} fallback={<div class="divider">{line.Text}</div>}>
										<div class="msg">
											<time>{clock(line.At)}</time>
											<div>
												<Line text={line.Text} />
												<Show when={line.Asked}>
													<span class="chip">Asked you</span>
												</Show>
											</div>
										</div>
									</Show>
								)}
							</For>
						</div>
						<Show when={trip.typing()}>
							<div class="typing">
								<span class="dots">
									<i />
									<i />
									<i />
								</span>
								{trip.typing()}
							</div>
						</Show>
						<div class="tip">
							<b>{trip.tip().Lead}</b> {trip.tip().Text}
						</div>
					</aside>
				</div>
			</div>
		</>
	);
});
