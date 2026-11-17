import type { IAskId } from "treflex";
import type { ISelected } from "treflex-react";
import type { IFlightOptions } from "../../../portal/src/trips/Trip";
import { money } from "../../../portal/src/text";
import { DESTINATIONS } from "../../../portal/src/trips/destinations";
import { cx } from "../shell/dom";
import { Trip } from "./contexts";

export function FlightQuestion(props: { options: ISelected<IFlightOptions>; highlight: boolean }) {
	const trip = Trip.use();
	const destination = DESTINATIONS[trip.state.Destination];
	const options = props.options;

	return (
		<div
			className={cx("askcard", {
				hot: props.highlight
			})}
		>
			<div className="who">
				<span className="dot blue" />
				Your call
			</div>
			<h2 className="serif">{options.Heading}</h2>
			<div className="sub">{options.Sub}</div>
			<div className="opts">
				{options.Options.map((option, at) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: by position, as Solid's <Index> keys the Solid build's options
						key={at}
						className={cx("opt", {
							pick: option.Cheaper
						})}
					>
						<div className="h">
							<span>
								{option.Fare.Slot} · {option.Fare.Carrier}
							</span>
							<span className={`tag ${option.Tag.Tone}`}>{option.Tag.Text}</span>
						</div>
						<div className="fly">
							<div>
								<div className="t">{option.Fare.Depart}</div>
								<div className="c">{destination.FromCode}</div>
							</div>
							<div className="mid">
								<span>{option.Fare.Duration}</span>
								<div className="ln" />
								<span>via {option.Fare.Via}</span>
							</div>
							<div className="arr">
								<div className="t">{option.Fare.Arrive}</div>
								<div className="c">
									{destination.Code} · {option.Fare.ArriveDay}
								</div>
							</div>
						</div>
						<div className="f">
							<span className="price">
								{money(option.Fare.Price)} <small>per person</small>
							</span>
							<button
								type="button"
								className={cx("btn", {
									teal: option.Cheaper
								})}
								onClick={() => void trip.pickFare(options.Entry.Id as IAskId<string>, option.Fare.Id)}
							>
								{option.Button}
							</button>
						</div>
					</div>
				))}
			</div>
			{options.Meanwhile ? (
				<div className="meanwhile">
					<span className="spin meanwhile-spin" />
					{options.Meanwhile}
				</div>
			) : null}
		</div>
	);
}
