import type { IPortalHost, IRendererSwap } from "./host";
import { createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { wallClock } from "../portal/clock";
import { sessionStatus } from "../portal/sessionStatus";
import { otherBuild, swapButtons } from "./builds";
import { CheckIcon } from "./icons";

function SwapSegment(props: { swap: IRendererSwap }) {
	const swap = untrack(() => props.swap);
	const [pending, setPending] = createSignal(swap.pending());
	onCleanup(swap.onPendingChange(setPending));
	return (
		<fieldset class="seg" aria-label="Renderer">
			<For each={swapButtons("solid", pending())} keyed={false}>
				{(button) => (
					<button
						type="button"
						class={{
							on: button().Pressed
						}}
						aria-pressed={button().Pressed ? "true" : "false"}
						aria-busy={button().Busy ? "true" : "false"}
						onClick={() => swap.switchTo(button().Build)}
					>
						{button().Label}
					</button>
				)}
			</For>
		</fieldset>
	);
}

export function SessionCard(props: { host: IPortalHost; recordsOpen: boolean; onToggleRecords: () => void }) {
	const other = otherBuild("solid", props.host.swap);
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
			<Show
				when={other.kind === "swap" && other}
				fallback={
					<div class="seg">
						<span class="on" aria-current="true">
							Solid
						</span>
						<Show
							when={other.kind === "link" && other}
							fallback={
								<button type="button" disabled>
									React
								</button>
							}
						>
							{(link) => <a href={link().href}>React</a>}
						</Show>
					</div>
				}
			>
				{(swap) => <SwapSegment swap={swap().swap} />}
			</Show>
			<button type="button" class="toggle" onClick={() => props.onToggleRecords()} aria-pressed={props.recordsOpen ? "true" : "false"}>
				<span>Record stream</span>
				<span
					class={[
						"sw",
						{
							on: props.recordsOpen
						}
					]}
				/>
			</button>
		</div>
	);
}
