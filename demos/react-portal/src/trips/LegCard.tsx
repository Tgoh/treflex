import type { ISelected } from "treflex-react";
import type { IPick } from "../../../portal/src/backend/backend";
import { money } from "../../../portal/src/text";
import { LEG_NAMES, runLegAction } from "../../../portal/src/trips/Trip";
import { CompassIcon, HotelIcon, PlaneIcon } from "../shell/icons";
import { Leg, Trip } from "./contexts";

const RING = 2 * Math.PI * 22;

function Quotes(props: { picks: readonly ISelected<IPick>[]; unit: string; more: number }) {
	if (props.picks.length === 0 && props.more === 0) return null;
	return (
		<div className="quotes">
			{props.picks.map((pick) => (
				<div className="q" key={pick.Name}>
					<div>
						<b>{pick.Name}</b>
						<small>{pick.Detail}</small>
					</div>
					<div className="p">
						{money(pick.Price)}
						{props.unit ? <small> /{props.unit}</small> : null}
					</div>
				</div>
			))}
			{props.more > 0 ? (
				<div className="q ghost">
					<div>
						<b>Checking {props.more} more…</b>
					</div>
					<div />
				</div>
			) : null}
		</div>
	);
}

export const LegCard = Leg.provider(() => {
	const leg = Leg.use();
	const trip = Trip.use();
	const kind = leg.state.Kind;
	const view = trip.legViews()[kind];
	const hold = view.Hold;
	const note = view.Note;

	return (
		<div className="leg">
			<div className="h">
				<div className="ico">
					{kind === "flights" ? <PlaneIcon /> : null}
					{kind === "hotel" ? <HotelIcon /> : null}
					{kind === "activities" ? <CompassIcon /> : null}
				</div>
				<b>{LEG_NAMES[kind]}</b>
				<span className={`st ${view.Badge.Tone}`}>
					{view.Badge.Tone === "work" ? <span className="spin" /> : null}
					{view.Badge.Label}
				</span>
			</div>

			{hold ? (
				<>
					<div className="holdbox">
						<svg className="ring" viewBox="0 0 52 52" aria-hidden="true">
							<circle cx="26" cy="26" r="22" fill="none" stroke="#2c3038" strokeWidth="5" />
							<circle
								cx="26"
								cy="26"
								r="22"
								fill="none"
								stroke="#5eead4"
								strokeWidth="5"
								strokeLinecap="round"
								strokeDasharray={String(RING)}
								strokeDashoffset={String(RING * (1 - hold.Fraction))}
								transform="rotate(-90 26 26)"
							/>
						</svg>
						<div>
							<b>{hold.Left}</b> <span className="left">left on the hold</span>
							<small>{hold.Detail}</small>
						</div>
					</div>
					<div className="foot">The hold's deadline is in state, so time with the page closed counts too.</div>
				</>
			) : (
				<>
					<div className={`prog ${view.Bar}`}>
						<i
							style={{
								width: `${Math.round(view.Progress * 100)}%`
							}}
						/>
					</div>
					<div className="pmeta">
						<span>{view.Counted}</span>
						<span>{view.Kept}</span>
					</div>
				</>
			)}

			{kind !== "flights" ? <Quotes picks={leg.state.Picks} unit={view.PriceUnit} more={view.StillToCheck} /> : null}

			{note ? (
				<div className={`stopnote ${note.Tone}`}>
					<span>{note.Text}</span>
					<button type="button" className="btn" onClick={() => runLegAction(trip, leg.state.$Id, note.Action)}>
						{note.Label}
					</button>
				</div>
			) : null}
		</div>
	);
});
