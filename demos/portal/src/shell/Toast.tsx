import { Show } from "solid-js";
import { appIcon } from "../portal/apps";
import { Portal } from "./contexts";
import { AppIcon } from "./icons";

export function Toast() {
	const portal = Portal.use();
	return (
		<Show when={portal.toast()}>
			{(toast) => (
				<div class="toast" role="status">
					<div class="ico">
						<AppIcon icon={appIcon(toast().App)} />
					</div>
					<div>
						<b>{toast().Title}</b>
						<small>{toast().Text}</small>
						<Show when={portal.toastVoucher()}>
							{(label) => (
								<button type="button" class="btn voucher" onClick={() => portal.applyToastVoucher()}>
									{label()}
								</button>
							)}
						</Show>
						<button type="button" class="link" onClick={() => portal.followToast()}>
							{toast().Link}
						</button>
					</div>
					<button type="button" class="x" aria-label="Dismiss" onClick={() => portal.dismissToast()}>
						×
					</button>
				</div>
			)}
		</Show>
	);
}
