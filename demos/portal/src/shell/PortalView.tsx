import type { IPortalHost } from "./host";
import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Patterns } from "../trips/Art";
import { APP_VIEWS } from "./apps";
import { ViewFailed } from "./BootFailed";
import { Portal } from "./contexts";
import { Guarded } from "./Guarded";
import { AppIcon } from "./icons";
import { RecordPanel } from "./RecordPanel";
import { SessionCard } from "./SessionCard";
import { Toast } from "./Toast";
import { TourStrip } from "./TourStrip";

export const PortalView = Portal.provider<{
	host: IPortalHost;
}>((props) => {
	const portal = Portal.use();
	const active = () => APP_VIEWS.find((app) => app.Id === portal.state.ActiveApp) ?? APP_VIEWS[0];
	const restore = {
		get lines() {
			return portal.restoreBanner();
		},
		onDismiss: () => void portal.dismissRestore()
	};

	return (
		<div
			class="portal"
			classList={{
				"with-records": portal.state.RecordsOpen
			}}
		>
			<Patterns />
			<aside class="side">
				<div class="brand">
					<div class="mark" />
					<div>
						<b>treflex</b>
						<span>Demo portal</span>
					</div>
				</div>
				<nav>
					<div class="label">Apps</div>
					<For each={APP_VIEWS}>
						{(app) => {
							const on = () => portal.state.ActiveApp === app.Id;
							const show = () => void portal.openApp(app.Id);
							const acted = () => [
								portal.state.ActiveApp,
								app.ViewKey(portal.state)
							];
							return (
								<>
									<button
										type="button"
										class="app"
										classList={{
											on: on()
										}}
										onClick={show}
									>
										<AppIcon icon={app.Icon} />
										<div>
											{app.Name}
											<Guarded name={`${app.Name} status`} retryOn={acted} fallback={() => <small>Status failed</small>}>
												<app.Status portal={portal.state} />
											</Guarded>
										</div>
										<Guarded name={`${app.Name} badge`} retryOn={acted} fallback={() => null}>
											<app.Badge portal={portal.state} />
										</Guarded>
									</button>
									<Show when={app.Nav}>
										{(nav) => (
											<Guarded name={`${app.Name} sidebar list`} retryOn={acted} fallback={() => null}>
												<Dynamic component={nav()} portal={portal.state} active={on()} onShow={show} />
											</Guarded>
										)}
									</Show>
								</>
							);
						}}
					</For>
				</nav>
				<SessionCard host={props.host} recordsOpen={portal.state.RecordsOpen} onToggleRecords={() => portal.toggleRecords()} />
			</aside>
			<main class={`app-${portal.state.ActiveApp}`}>
				<TourStrip state={portal.state.Tour} />
				<Show when={active()} keyed>
					{(app) => (
						<Guarded
							name={`${app.Name} view`}
							retryOn={() => app.ViewKey(portal.state)}
							fallback={(retry) => (
								<ViewFailed title={`The ${app.Name} view failed.`} onRetry={retry} onReset={() => props.host.reset()} inset>
									<Show when={app.Recover}>{(recover) => <Dynamic component={recover()} portal={portal.state} />}</Show>
								</ViewFailed>
							)}
						>
							<app.View portal={portal.state} tourStep={portal.tourStep()} restore={restore} />
						</Guarded>
					)}
				</Show>
				<Toast />
			</main>
			<Show when={portal.state.RecordsOpen}>
				<RecordPanel monitor={props.host.monitor} />
			</Show>
		</div>
	);
});
