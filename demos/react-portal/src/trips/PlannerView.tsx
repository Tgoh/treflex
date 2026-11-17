import type { IRestoreProps } from "../shell/RestoreBanner";
import { cx } from "../shell/dom";
import { Planner, Trip } from "./contexts";
import { StartScreen } from "./StartScreen";
import { TripView } from "./TripView";

export const PlannerView = Planner.provider<{
	tourStep: number | null;
	restore: IRestoreProps;
}>((props) => {
	const planner = Planner.use();
	const trip = planner.currentTrip();
	return trip ? (
		<TripView key={trip.$Id} state={trip} tourOnQuestion={props.tourStep === 2} restore={props.restore} />
	) : (
		<StartScreen highlight={props.tourStep === 1} restore={props.restore} />
	);
});

const TripRow = Trip.provider<{
	open: boolean;
	onOpen: () => void;
}>((props) => {
	const trip = Trip.use();
	const progress = trip.tripFacts().Progress;
	const dot = trip.dot();
	return (
		<button
			type="button"
			className={cx("trip", {
				on: props.open
			})}
			onClick={() => props.onOpen()}
		>
			<div>
				{trip.state.Name}
				<small>{trip.statusLine()}</small>
				<div className="bar">
					<i
						className={dot}
						style={{
							width: `${Math.round(progress * 100)}%`
						}}
					/>
				</div>
			</div>
			{dot ? <span className={`dot ${dot}`} /> : null}
		</button>
	);
});

export const PlannerRecover = Planner.provider(() => {
	const planner = Planner.use();
	const tripId = planner.state.OpenTripId;
	if (!tripId) return null;
	return (
		<>
			<button type="button" className="btn" onClick={() => planner.openTrip(null)}>
				Back to the start screen
			</button>
			<button type="button" className="btn" onClick={() => planner.removeTrip(tripId)}>
				Remove this trip
			</button>
		</>
	);
});

export const PlannerSummary = Planner.provider(() => {
	const planner = Planner.use();
	return <small>{planner.summary().Line}</small>;
});

export const PlannerDot = Planner.provider(() => {
	const planner = Planner.use();
	const dot = planner.summary().Dot;
	return dot ? <span className={`dot ${dot}`} /> : null;
});

export const PlannerNav = Planner.provider<{
	active: boolean;
	onShow: () => void;
}>((props) => {
	const planner = Planner.use();
	const go = (tripId: string | null) => {
		void planner.openTrip(tripId);
		props.onShow();
	};
	if (planner.state.Trips.length === 0) return null;
	return (
		<div className="trips">
			{planner.state.Trips.map((trip) => (
				<TripRow key={trip.$Id} state={trip} open={props.active && planner.state.OpenTripId === trip.$Id} onOpen={() => go(trip.$Id)} />
			))}
			<button type="button" className="newtrip" onClick={() => go(null)}>
				+ Plan another trip
			</button>
		</div>
	);
});
