import type { IMonitor, IResolvedLine } from "../portal/monitor";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { lanesOf, lineTime, SHOWN_LINES } from "./records";

export function RecordPanel(props: { monitor: IMonitor; onClose: () => void }) {
	const [lines, setLines] = createSignal<IResolvedLine[]>(props.monitor.lines().slice(0, SHOWN_LINES));
	const [ticks, setTicks] = createSignal(props.monitor.ticks());
	let frame = 0;
	const refresh = (): void => {
		if (frame !== 0) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			setLines(props.monitor.lines().slice(0, SHOWN_LINES));
			setTicks(props.monitor.ticks());
		});
	};
	onCleanup(props.monitor.subscribe(refresh));
	onCleanup(() => cancelAnimationFrame(frame));

	const lanes = () => lanesOf(lines());

	return (
		<aside class="records">
			<div class="rh">
				<b>
					Record stream <span>every app · live · {ticks()} timer ticks and stream letters hidden</span>
				</b>
				<div class="filters">
					<For each={lanes()}>
						{([lane, name]) => (
							<span>
								<i class={`lane-${lane}`} />
								{name}
							</span>
						)}
					</For>
				</div>
				<button type="button" class="rclose" aria-label="Close the record stream" onClick={() => props.onClose()}>
					×
				</button>
			</div>
			<div class="rec mono">
				<Show when={lines().length > 0} fallback={<div class="empty">Nothing recorded yet. Start a trip.</div>}>
					<For each={lines()}>
						{(line) => (
							<div class="r">
								<time>{lineTime(line.At)}</time>
								<i class={`lane-${line.Lane}`} />
								<div>
									<span class={`what${line.Tone ? ` k-${line.Tone}` : ""}`}>
										{line.What} <em>{line.Detail}</em>
									</span>
									<span class="where">{line.Label}</span>
								</div>
							</div>
						)}
					</For>
				</Show>
			</div>
		</aside>
	);
}
