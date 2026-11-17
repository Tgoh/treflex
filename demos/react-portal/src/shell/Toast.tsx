import { appIcon } from "../../../portal/src/portal/apps";
import { Portal } from "./contexts";
import { AppIcon } from "./icons";

export function Toast() {
	const portal = Portal.use();
	const toast = portal.toast();
	const voucher = portal.toastVoucher();
	if (!toast) return null;
	return (
		<div className="toast" role="status">
			<div className="ico">
				<AppIcon icon={appIcon(toast.App)} />
			</div>
			<div>
				<b>{toast.Title}</b>
				<small>{toast.Text}</small>
				{voucher ? (
					<button type="button" className="btn voucher" onClick={() => portal.applyToastVoucher()}>
						{voucher}
					</button>
				) : null}
				<button type="button" className="link" onClick={() => portal.followToast()}>
					{toast.Link}
				</button>
			</div>
			<button type="button" className="x" aria-label="Dismiss" onClick={() => portal.dismissToast()}>
				×
			</button>
		</div>
	);
}
