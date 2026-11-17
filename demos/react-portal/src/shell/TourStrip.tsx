import type { IPlanner } from "../../../portal/src/trips/Planner";
import { Fragment } from "react";
import { useEntity } from "treflex-react";
import { TOUR_STEPS } from "../../../portal/src/tour/Tour";
import { Portal, Tour } from "./contexts";
import { cx } from "./dom";
import { Guarded } from "./Guarded";

function TourHint() {
	const portal = Portal.use();
	const hint = portal.tourHint();
	if (!hint) return null;
	return (
		<div className="hint">
			<span className="arrow">→</span>
			<span>
				<b>{hint.Title}</b> {hint.Text}
			</span>
		</div>
	);
}

export const TourStrip = Tour.provider(() => {
	const tour = Tour.use();
	const portal = Portal.use();
	const planner = useEntity<IPlanner>(portal.state.Trips.$Id);
	const step = tour.currentStep();
	const finished = step > TOUR_STEPS.length;

	if (tour.state.Skipped) return null;
	return (
		<>
			<div className="tour">
				<div className="k">
					Guided tour<b>{finished ? "All done" : `Step ${step} of ${TOUR_STEPS.length}`}</b>
				</div>
				<div className="tsteps">
					{TOUR_STEPS.map((s, i) => (
						<Fragment key={s.Mark}>
							{i > 0 ? <span className="tline" /> : null}
							<span
								className={cx("ts", {
									done: tour.state[s.Mark],
									now: step === i + 1
								})}
							>
								<i>{tour.state[s.Mark] ? "✓" : i + 1}</i>
								<span className="ts-label">{s.Label}</span>
							</span>
						</Fragment>
					))}
				</div>
				<button type="button" className="skip" onClick={() => tour.skipTour()}>
					{finished ? "Close tour" : "Skip tour"}
				</button>
			</div>
			<Guarded
				name="tour hint"
				retryOn={[
					portal.state.ActiveApp,
					planner?.OpenTripId,
					planner?.Trips.length
				]}
				fallback={() => null}
			>
				<TourHint />
			</Guarded>
		</>
	);
});
