import type { IRestoreProps } from "../shell/RestoreBanner";
import { DESTINATION_KEYS, DESTINATIONS } from "../../../portal/src/trips/destinations";
import { CARD_STAGGER_MS, CARD_TICK_MS, endsFlourish } from "../../../portal/src/trips/flourish";
import { priced } from "../../../portal/src/trips/Planner";
import { cx, styled } from "../shell/dom";
import { RestoreBanner } from "../shell/RestoreBanner";
import { DestinationArt } from "./Art";
import { Planner } from "./contexts";
import { Ticker } from "./Ticker";

export function StartScreen(props: { highlight: boolean; restore: IRestoreProps }) {
	const planner = Planner.use();
	const voucher = planner.voucher();
	const flourish = voucher?.Flourish ?? false;
	return (
		<section className="start">
			<div>
				<h1 className="serif">
					Where to <em>next?</em>
				</h1>
				<p className="lede">
					Pick a trip. An agent searches flights, hotels and things to do all at once, and asks you when it needs a decision.
				</p>
			</div>
			<RestoreBanner restore={props.restore} />
			<div
				className={cx("cards", {
					vdrop: flourish
				})}
				onAnimationEnd={(event) => {
					if (endsFlourish(event)) void planner.flourishPlayed();
				}}
			>
				{DESTINATION_KEYS.map((key, i) => {
					const destination = DESTINATIONS[key];
					const first = i === 0;
					const price = priced(destination.Budget, voucher);
					return (
						<div
							key={key}
							className={cx("card", {
								hot: props.highlight && first
							})}
							style={styled({
								"--i": String(i)
							})}
						>
							<div className="art">
								<DestinationArt destination={key} />
								<div
									className="tagline"
									style={{
										color: destination.TaglineColour
									}}
								>
									{destination.Tagline}
								</div>
							</div>
							<div className="body">
								<h3 className="serif">{destination.Name}</h3>
								<div className="meta">
									{destination.Nights} nights · {destination.Dates.replace(" – ", "–")} · {destination.Travellers} adults ·{" "}
									{price.Was ? <s>{price.Was}</s> : null}
									<Ticker price={price} playing={flourish} delayMs={CARD_TICK_MS + i * CARD_STAGGER_MS} />
									{voucher ? <span className="vpill">{voucher.Pill}</span> : null}
								</div>
								<div className="go">
									<span>From {destination.From}</span>
									<button
										type="button"
										className={cx("btn", {
											teal: first
										})}
										onClick={() => planner.startTrip(key)}
									>
										Start planning →
									</button>
								</div>
							</div>
						</div>
					);
				})}
			</div>
			<div className="how">
				<div>
					<i>1</i>
					<span>
						<b>You pick a trip</b>Dates and budget are filled in for you.
					</span>
				</div>
				<div>
					<i>2</i>
					<span>
						<b>The agent gets to work</b>Flights, hotel and activities, searched side by side.
					</span>
				</div>
				<div>
					<i>3</i>
					<span>
						<b>It asks when it needs you</b>The rest keeps going while you decide.
					</span>
				</div>
			</div>
		</section>
	);
}
