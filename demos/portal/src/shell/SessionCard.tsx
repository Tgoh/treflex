import type { IPortalHost } from "./host";
import { createSignal, onCleanup, Show } from "solid-js";
import { wallClock } from "../portal/clock";
import { sessionStatus } from "../portal/sessionStatus";
import { otherBuildUrl } from "./builds";
import { CheckIcon } from "./icons";

const OTHER_BUILD_URL = otherBuildUrl("solid");

export function SessionCard(props: { host: IPortalHost; recordsOpen: boolean; onToggleRecords: () => void }) {
	const [saved, setSaved] = createSignal(props.host.autosave.state());
	const [now, setNow] = createSignal(wallClock());
	onCleanup(props.host.autosave.onChange(setSaved));
	const clock = setInterval(() => setNow(wallClock()), 1000);
	onCleanup(() => clearInterval(clock));
	const status = () => sessionStatus(saved(), props.host.restoredAt, now());

	return (
		<div class="session">
			<div class="row">
				<Show when={status().Saved}>
					<CheckIcon />
				</Show>
				<b>{status().Title}</b>
			</div>
			<Show when={status().Meta}>
				<div class="meta">{status().Meta}</div>
			</Show>
			<div class="sbtns">
				<button type="button" class="sbtn primary" onClick={() => props.host.reload()}>
					↻ Reload page
				</button>
				<button type="button" class="sbtn" onClick={() => props.host.reset()}>
					Reset
				</button>
			</div>
			<div class="seg">
				<span class="on" aria-current="true">
					Solid
				</span>
				<Show
					when={OTHER_BUILD_URL}
					fallback={
						<button type="button" disabled>
							React
						</button>
					}
				>
					{(url) => <a href={url()}>React</a>}
				</Show>
			</div>
			<button type="button" class="toggle" onClick={() => props.onToggleRecords()} aria-pressed={props.recordsOpen}>
				<span>Record stream</span>
				<span
					class="sw"
					classList={{
						on: props.recordsOpen
					}}
				/>
			</button>
		</div>
	);
}
