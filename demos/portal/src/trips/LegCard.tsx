import type { IPick } from "../backend/backend";
import { For, Match, Show, Switch } from "solid-js";
import { CompassIcon, HotelIcon, PlaneIcon } from "../shell/icons";
import { money } from "../text";
import { Leg, Trip } from "./contexts";
import { LEG_NAMES, runLegAction } from "./Trip";

const RING = 2 * Math.PI * 22;

function Quotes(props: { picks: readonly IPick[]; unit: string; more: number }) {
	return (
		<Show when={props.picks.length > 0 || props.more > 0}>
			<div class="quotes">
				<For each={props.picks}>
					{(pick) => (
						<div class="q">
							<div>
								<b>{pick.Name}</b>
								<small>{pick.Detail}</small>
							</div>
							<div class="p">
								{money(pick.Price)}
								<Show when={props.unit}>
									<small> /{props.unit}</small>
								</Show>
							</div>
						</div>
					)}
				</For>
				<Show when={props.more > 0}>
					<div class="q ghost">
						<div>
							<b>Checking {props.more} more…</b>
						</div>
						<div />
					</div>
				</Show>
			</div>
		</Show>
	);
}

export const LegCard = Leg.provider(() => {
	const leg = Leg.use();
	const trip = Trip.use();
	const kind = () => leg.state.Kind;
	const view = () => trip.legViews()[kind()];

	return (
		<div class="leg">
			<div class="h">
				<div class="ico">
					<Switch>
						<Match when={kind() === "flights"}>
							<PlaneIcon />
						</Match>
						<Match when={kind() === "hotel"}>
							<HotelIcon />
						</Match>
						<Match when={kind() === "activities"}>
							<CompassIcon />
						</Match>
					</Switch>
				</div>
				<b>{LEG_NAMES[kind()]}</b>
				<span class={`st ${view().Badge.Tone}`}>
					<Show when={view().Badge.Tone === "work"}>
						<span class="spin" />
					</Show>
					{view().Badge.Label}
				</span>
			</div>

			<Show
				when={view().Hold}
				fallback={
					<>
						<div class={`prog ${view().Bar}`}>
							<i
								style={{
									width: `${Math.round(view().Progress * 100)}%`
								}}
							/>
						</div>
						<div class="pmeta">
							<span>{view().Counted}</span>
							<span>{view().Kept}</span>
						</div>
					</>
				}
			>
				{(hold) => (
					<>
						<div class="holdbox">
							<svg class="ring" viewBox="0 0 52 52" aria-hidden="true">
								<circle cx="26" cy="26" r="22" fill="none" stroke="#2c3038" stroke-width="5" />
								<circle
									cx="26"
									cy="26"
									r="22"
									fill="none"
									stroke="#5eead4"
									stroke-width="5"
									stroke-linecap="round"
									stroke-dasharray={String(RING)}
									stroke-dashoffset={String(RING * (1 - hold().Fraction))}
									transform="rotate(-90 26 26)"
								/>
							</svg>
							<div>
								<b>{hold().Left}</b> <span class="left">left on the hold</span>
								<small>{hold().Detail}</small>
							</div>
						</div>
						<div class="foot">The hold's deadline is in state, so time with the page closed counts too.</div>
					</>
				)}
			</Show>

			<Show when={kind() !== "flights"}>
				<Quotes picks={leg.state.Picks} unit={view().PriceUnit} more={view().StillToCheck} />
			</Show>

			<Show when={view().Note}>
				{(note) => (
					<div class={`stopnote ${note().Tone}`}>
						<span>{note().Text}</span>
						<button type="button" class="btn" onClick={() => runLegAction(trip, leg.state.$Id, note().Action)}>
							{note().Label}
						</button>
					</div>
				)}
			</Show>
		</div>
	);
});
