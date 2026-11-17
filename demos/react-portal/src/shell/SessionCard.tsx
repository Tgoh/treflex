import type { IPortalHost, IRendererSwap } from "../../../portal/src/shell/host";
import { useEffect, useState } from "react";
import { wallClock } from "../../../portal/src/portal/clock";
import { sessionStatus } from "../../../portal/src/portal/sessionStatus";
import { otherBuild, swapButtons } from "../../../portal/src/shell/builds";
import { cx } from "./dom";
import { CheckIcon } from "./icons";

function SwapSegment(props: { swap: IRendererSwap }) {
	const swap = props.swap;
	const [pending, setPending] = useState(() => swap.pending());
	useEffect(() => {
		setPending(swap.pending());
		return swap.onPendingChange(setPending);
	}, [
		swap
	]);
	return (
		<fieldset className="seg" aria-label="Renderer">
			{swapButtons("react", pending).map((button) => (
				<button
					key={button.Build}
					type="button"
					className={button.Pressed ? "on" : undefined}
					aria-pressed={button.Pressed}
					aria-busy={button.Busy}
					onClick={() => swap.switchTo(button.Build)}
				>
					{button.Label}
				</button>
			))}
		</fieldset>
	);
}

export function SessionCard(props: { host: IPortalHost; recordsOpen: boolean; onToggleRecords: () => void }) {
	const other = otherBuild("react", props.host.swap);
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
			{other.kind === "swap" ? (
				<SwapSegment swap={other.swap} />
			) : (
				<div className="seg">
					{other.kind === "link" ? (
						<a href={other.href}>Solid</a>
					) : (
						<button type="button" disabled>
							Solid
						</button>
					)}
					<span className="on" aria-current="true">
						React
					</span>
				</div>
			)}
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
