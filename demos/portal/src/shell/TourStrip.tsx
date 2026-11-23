import { For, Show } from "solid-js";
import { TOUR_STEPS } from "../tour/Tour";
import { Portal, Tour } from "./contexts";
import { Guarded } from "./Guarded";

export const TourStrip = Tour.provider(() => {
	const tour = Tour.use();
	const portal = Portal.use();
	const step = () => tour.currentStep();
	const finished = () => step() > TOUR_STEPS.length;

	return (
		<Show when={!tour.state.Skipped}>
			<div class="tour">
				<div class="k">
					Guided tour<b>{finished() ? "All done" : `Step ${step()} of ${TOUR_STEPS.length}`}</b>
				</div>
				<div class="tsteps">
					<For each={TOUR_STEPS}>
						{(s, i) => (
							<>
								<Show when={i() > 0}>
									<span class="tline" />
								</Show>
								<span
									class={[
										"ts",
										{
											done: tour.state[s.Mark],
											now: step() === i() + 1
										}
									]}
								>
									<i>{tour.state[s.Mark] ? "✓" : i() + 1}</i>
									<span class="ts-label">{s.Label}</span>
								</span>
							</>
						)}
					</For>
				</div>
				<button type="button" class="skip" onClick={() => tour.skipTour()}>
					{finished() ? "Close tour" : "Skip tour"}
				</button>
			</div>
			<Guarded
				name="tour hint"
				retryOn={() => [
					portal.state.ActiveApp,
					portal.state.Trips.OpenTripId,
					portal.state.Trips.Trips.length
				]}
				fallback={() => null}
			>
				<Show when={portal.tourHint()}>
					{(hint) => (
						<div class="hint">
							<span class="arrow">→</span>
							<span>
								<b>{hint().Title}</b> {hint().Text}
							</span>
						</div>
					)}
				</Show>
			</Guarded>
		</Show>
	);
});
