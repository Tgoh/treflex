import type { IPortalHost } from "../../../portal/src/shell/host";
import { useEffect, useState } from "react";
import { wallClock } from "../../../portal/src/portal/clock";
import { sessionStatus } from "../../../portal/src/portal/sessionStatus";
import { otherBuildUrl } from "../../../portal/src/shell/builds";
import { cx } from "./dom";
import { CheckIcon } from "./icons";

const OTHER_BUILD_URL = otherBuildUrl("react");

export function SessionCard(props: { host: IPortalHost; recordsOpen: boolean; onToggleRecords: () => void }) {
	const autosave = props.host.autosave;
	const [saved, setSaved] = useState(() => autosave.state());
	const [now, setNow] = useState(wallClock);
	useEffect(() => {
		setSaved(autosave.state());
		return autosave.onChange(setSaved);
	}, [
		autosave
	]);
	useEffect(() => {
		const clock = setInterval(() => setNow(wallClock()), 1000);
		return () => clearInterval(clock);
	}, []);
	const status = sessionStatus(saved, props.host.restoredAt, now);

	return (
		<div className="session">
			<div className="row">
				{status.Saved ? <CheckIcon /> : null}
				<b>{status.Title}</b>
			</div>
			{status.Meta ? <div className="meta">{status.Meta}</div> : null}
			<div className="sbtns">
				<button type="button" className="sbtn primary" onClick={() => props.host.reload()}>
					↻ Reload page
				</button>
				<button type="button" className="sbtn" onClick={() => props.host.reset()}>
					Reset
				</button>
			</div>
			<div className="seg">
				{OTHER_BUILD_URL ? (
					<a href={OTHER_BUILD_URL}>Solid</a>
				) : (
					<button type="button" disabled>
						Solid
					</button>
				)}
				<span className="on" aria-current="true">
					React
				</span>
			</div>
			<button type="button" className="toggle" onClick={() => props.onToggleRecords()} aria-pressed={props.recordsOpen}>
				<span>Record stream</span>
				<span
					className={cx("sw", {
						on: props.recordsOpen
					})}
				/>
			</button>
		</div>
	);
}
