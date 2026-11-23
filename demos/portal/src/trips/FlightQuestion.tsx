import type { IAskId } from "treflex";
import type { IFlightOptions } from "./Trip";
import { For, Show } from "solid-js";
import { money } from "../text";
import { Trip } from "./contexts";
import { DESTINATIONS } from "./destinations";

export function FlightQuestion(props: { options: IFlightOptions; highlight: boolean }) {
	const trip = Trip.use();
	const destination = () => DESTINATIONS[trip.state.Destination];

	return (
		<div
			class={[
				"askcard",
				{
					hot: props.highlight
				}
			]}
		>
			<div class="who">
				<span class="dot blue" />
				Your call
			</div>
			<h2 class="serif">{props.options.Heading}</h2>
			<div class="sub">{props.options.Sub}</div>
			<div class="opts">
				<For each={props.options.Options} keyed={false}>
					{(option) => (
						<div
							class={[
								"opt",
								{
									pick: option().Cheaper
								}
							]}
						>
							<div class="h">
								<span>
									{option().Fare.Slot} · {option().Fare.Carrier}
								</span>
								<span class={`tag ${option().Tag.Tone}`}>{option().Tag.Text}</span>
							</div>
							<div class="fly">
								<div>
									<div class="t">{option().Fare.Depart}</div>
									<div class="c">{destination().FromCode}</div>
								</div>
								<div class="mid">
									<span>{option().Fare.Duration}</span>
									<div class="ln" />
									<span>via {option().Fare.Via}</span>
								</div>
								<div class="arr">
									<div class="t">{option().Fare.Arrive}</div>
									<div class="c">
										{destination().Code} · {option().Fare.ArriveDay}
									</div>
								</div>
							</div>
							<div class="f">
								<span class="price">
									{money(option().Fare.Price)} <small>per person</small>
								</span>
								<button
									type="button"
									class={[
										"btn",
										{
											teal: option().Cheaper
										}
									]}
									onClick={() => void trip.pickFare(props.options.Entry.Id as IAskId<string>, option().Fare.Id)}
								>
									{option().Button}
								</button>
							</div>
						</div>
					)}
				</For>
			</div>
			<Show when={props.options.Meanwhile}>
				<div class="meanwhile">
					<span class="spin meanwhile-spin" />
					{props.options.Meanwhile}
				</div>
			</Show>
		</div>
	);
}
