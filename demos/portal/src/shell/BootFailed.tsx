import type { JSX } from "solid-js";
import { Show } from "solid-js";

export function FailedCard(props: {
	title: string;
	text: string;
	onReset: () => void;
	onRetry?: () => void;
	inset?: boolean;
	children?: JSX.Element;
}) {
	return (
		<div
			class="boot"
			classList={{
				inset: props.inset === true
			}}
		>
			<div class="bootcard">
				<b>{props.title}</b>
				<p>{props.text}</p>
				<div class="bootbtns">
					<Show when={props.onRetry}>
						{(retry) => (
							<button type="button" class="btn dark" onClick={() => retry()()}>
								Try again
							</button>
						)}
					</Show>
					{props.children}
					<button
						type="button"
						class="btn"
						classList={{
							dark: !props.onRetry
						}}
						onClick={() => props.onReset()}
					>
						Reset
					</button>
				</div>
			</div>
		</div>
	);
}

export function BootFailed(props: { onReset: () => void }) {
	return (
		<FailedCard
			title="The portal couldn't start."
			text="The session saved in this browser may be one this build can't load. Resetting clears it and starts fresh."
			onReset={props.onReset}
		/>
	);
}

export function ViewFailed(props: { title: string; onRetry: () => void; onReset: () => void; inset?: boolean; children?: JSX.Element }) {
	return (
		<FailedCard
			title={props.title}
			text="Try again, or reset to clear the session saved in this browser and start fresh."
			onRetry={props.onRetry}
			onReset={props.onReset}
			inset={props.inset}
		>
			{props.children}
		</FailedCard>
	);
}
