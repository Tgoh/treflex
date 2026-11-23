import type { IRestoreProps } from "../shell/RestoreBanner";
import { For, Show } from "solid-js";
import { RestoreBanner } from "../shell/RestoreBanner";
import { DestinationArt } from "./Art";
import { Planner } from "./contexts";
import { DESTINATION_KEYS, DESTINATIONS } from "./destinations";
import { CARD_STAGGER_MS, CARD_TICK_MS, endsFlourish } from "./flourish";
import { priced } from "./Planner";
import { createFlourish, Ticker } from "./Ticker";

export function StartScreen(props: { highlight: boolean; restore: IRestoreProps }) {
	const planner = Planner.use();
	const [flourish, endFlourish] = createFlourish(
		() => planner.voucher(),
		() => void planner.flourishPlayed()
	);
	return (
		<section class="start">
			<div>
				<h1 class="serif">
					Where to <em>next?</em>
				</h1>
				<p class="lede">
					Pick a trip. An agent searches flights, hotels and things to do all at once, and asks you when it needs a decision.
				</p>
			</div>
			<RestoreBanner restore={props.restore} />
			<div
				class={[
					"cards",
					{
						vdrop: flourish()
					}
				]}
				onAnimationEnd={(event) => {
					if (endsFlourish(event)) endFlourish();
				}}
			>
				<For each={DESTINATION_KEYS}>
					{(key, i) => {
						const destination = DESTINATIONS[key];
						const first = () => i() === 0;
						const price = () => priced(destination.Budget, planner.voucher());
						return (
							<div
								class={[
									"card",
									{
										hot: props.highlight && first()
									}
								]}
								style={{
									"--i": String(i())
								}}
							>
								<div class="art">
									<DestinationArt destination={key} />
									<div
										class="tagline"
										style={{
											color: destination.TaglineColour
										}}
									>
										{destination.Tagline}
									</div>
								</div>
								<div class="body">
									<h3 class="serif">{destination.Name}</h3>
									<div class="meta">
										{destination.Nights} nights · {destination.Dates.replace(" – ", "–")} · {destination.Travellers} adults ·{" "}
										<Show when={price().Was}>{(was) => <s>{was()}</s>}</Show>
										<Ticker price={price()} playing={flourish()} delayMs={CARD_TICK_MS + i() * CARD_STAGGER_MS} />
										<Show when={planner.voucher()}>{(voucher) => <span class="vpill">{voucher().Pill}</span>}</Show>
									</div>
									<div class="go">
										<span>From {destination.From}</span>
										<button
											type="button"
											class={[
												"btn",
												{
													teal: first()
												}
											]}
											onClick={() => planner.startTrip(key)}
										>
											Start planning →
										</button>
									</div>
								</div>
							</div>
						);
					}}
				</For>
			</div>
			<div class="how">
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
