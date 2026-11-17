import type { ReactNode } from "react";
import { cx } from "./dom";

export function FailedCard(props: {
	title: string;
	text: string;
	onReset: () => void;
	onRetry?: () => void;
	inset?: boolean;
	children?: ReactNode;
}) {
	const retry = props.onRetry;
	return (
		<div
			className={cx("boot", {
				inset: props.inset === true
			})}
		>
			<div className="bootcard">
				<b>{props.title}</b>
				<p>{props.text}</p>
				<div className="bootbtns">
					{retry ? (
						<button type="button" className="btn dark" onClick={() => retry()}>
							Try again
						</button>
					) : null}
					{props.children}
					<button
						type="button"
						className={cx("btn", {
							dark: !retry
						})}
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

export function ViewFailed(props: { title: string; onRetry: () => void; onReset: () => void; inset?: boolean; children?: ReactNode }) {
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
