import type { IRestoreLines } from "../portal/restoreBanner";
import { For, Show } from "solid-js";
import { RestoreIcon } from "./icons";

export interface IRestoreProps {
	lines: IRestoreLines | null;
	onDismiss: () => void;
}

export function RestoreBanner(props: { restore: IRestoreProps }) {
	return (
		<Show when={props.restore.lines}>
			{(lines) => (
				<div class="restored">
					<div class="badge">
						<RestoreIcon />
					</div>
					<div>
						<h4>Came back from the snapshot</h4>
						<ul>
							<For each={lines().Back}>{(line) => <li>{line}</li>}</For>
						</ul>
					</div>
					<div class="no">
						<h4>Didn't come back</h4>
						<ul>
							<For each={lines().Lost}>{(line) => <li>{line}</li>}</For>
						</ul>
					</div>
					<button type="button" class="btn" onClick={() => props.restore.onDismiss()}>
						Dismiss
					</button>
				</div>
			)}
		</Show>
	);
}
