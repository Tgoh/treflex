import type { IMonitor } from "../../../portal/src/portal/monitor";
import { useEffect, useState } from "react";
import { lanesOf, lineTime, SHOWN_LINES } from "../../../portal/src/shell/records";

function read(monitor: IMonitor) {
	return {
		lines: monitor.lines().slice(0, SHOWN_LINES),
		ticks: monitor.ticks()
	};
}

export function RecordPanel(props: { monitor: IMonitor }) {
	const monitor = props.monitor;
	const [{ lines, ticks }, setShown] = useState(() => read(monitor));
	useEffect(() => {
		let frame = 0;
		const refresh = (): void => {
			if (frame !== 0) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				setShown(read(monitor));
			});
		};
		const stop = monitor.subscribe(refresh);
		// The first read was the render's, and a line can land between it and this subscription.
		refresh();
		return () => {
			stop();
			cancelAnimationFrame(frame);
		};
	}, [
		monitor
	]);

	return (
		<aside className="records">
			<div className="rh">
				<b>
					Record stream <span>every app · live · {ticks} timer ticks and stream letters hidden</span>
				</b>
				<div className="filters">
					{lanesOf(lines).map(([lane, name]) => (
						<span key={lane}>
							<i className={`lane-${lane}`} />
							{name}
						</span>
					))}
				</div>
			</div>
			<div className="rec mono">
				{lines.length > 0 ? (
					lines.map((line) => (
						<div className="r" key={line.Seq}>
							<time>{lineTime(line.At)}</time>
							<i className={`lane-${line.Lane}`} />
							<div>
								<span className={`what${line.Tone ? ` k-${line.Tone}` : ""}`}>
									{line.What} <em>{line.Detail}</em>
								</span>
								<span className="where">{line.Label}</span>
							</div>
						</div>
					))
				) : (
					<div className="empty">Nothing recorded yet. Start a trip.</div>
				)}
			</div>
		</aside>
	);
}
