import type { ISelected } from "treflex-react";
import type { IRestoreLines } from "../../../portal/src/portal/restoreBanner";
import { RestoreIcon } from "./icons";

export interface IRestoreProps {
	lines: ISelected<IRestoreLines> | null;
	onDismiss: () => void;
}

export function RestoreBanner(props: { restore: IRestoreProps }) {
	const lines = props.restore.lines;
	if (!lines) return null;
	return (
		<div className="restored">
			<div className="badge">
				<RestoreIcon />
			</div>
			<div>
				<h4>Came back from the snapshot</h4>
				<ul>
					{lines.Back.map((line, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a line can repeat, and an <li> holds no state
						<li key={at}>{line}</li>
					))}
				</ul>
			</div>
			<div className="no">
				<h4>Didn't come back</h4>
				<ul>
					{lines.Lost.map((line, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a line can repeat, and an <li> holds no state
						<li key={at}>{line}</li>
					))}
				</ul>
			</div>
			<button type="button" className="btn" onClick={() => props.restore.onDismiss()}>
				Dismiss
			</button>
		</div>
	);
}
