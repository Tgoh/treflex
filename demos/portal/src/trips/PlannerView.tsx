import type { IRestoreProps } from "../shell/RestoreBanner";
import { For, Show } from "solid-js";
import { Planner, Trip } from "./contexts";
import { StartScreen } from "./StartScreen";
import { TripView } from "./TripView";

export const PlannerView = Planner.provider<{
	tourStep: number | null;
	restore: IRestoreProps;
}>((props) => {
	const planner = Planner.use();
	return (
		<Show when={planner.currentTrip()} fallback={<StartScreen highlight={props.tourStep === 1} restore={props.restore} />} keyed>
			{(trip) => <TripView state={trip} tourOnQuestion={props.tourStep === 2} restore={props.restore} />}
		</Show>
	);
});

const TripRow = Trip.provider<{
	open: boolean;
	onOpen: () => void;
}>((props) => {
	const trip = Trip.use();
	const progress = () => trip.tripFacts().Progress;
	return (
		<button
			type="button"
			class="trip"
			classList={{
				on: props.open
			}}
			onClick={() => props.onOpen()}
		>
			<div>
				{trip.state.Name}
				<small>{trip.statusLine()}</small>
				<div class="bar">
					<i
						class={trip.dot()}
						style={{
							width: `${Math.round(progress() * 100)}%`
						}}
					/>
				</div>
			</div>
			<Show when={trip.dot()}>
				<span class={`dot ${trip.dot()}`} />
			</Show>
		</button>
	);
});

export const PlannerRecover = Planner.provider(() => {
	const planner = Planner.use();
	return (
		<Show when={planner.state.OpenTripId} keyed>
			{(tripId) => (
				<>
					<button type="button" class="btn" onClick={() => planner.openTrip(null)}>
						Back to the start screen
					</button>
					<button type="button" class="btn" onClick={() => planner.removeTrip(tripId)}>
						Remove this trip
					</button>
				</>
			)}
		</Show>
	);
});

export const PlannerSummary = Planner.provider(() => {
	const planner = Planner.use();
	return <small>{planner.summary().Line}</small>;
});

export const PlannerDot = Planner.provider(() => {
	const planner = Planner.use();
	return (
		<Show when={planner.summary().Dot}>
			<span class={`dot ${planner.summary().Dot}`} />
		</Show>
	);
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
	return (
		<Show when={planner.state.Trips.length > 0}>
			<div class="trips">
				<For each={planner.state.Trips}>
					{(trip) => <TripRow state={trip} open={props.active && planner.state.OpenTripId === trip.$Id} onOpen={() => go(trip.$Id)} />}
				</For>
				<button type="button" class="newtrip" onClick={() => go(null)}>
					+ Plan another trip
				</button>
			</div>
		</Show>
	);
});
