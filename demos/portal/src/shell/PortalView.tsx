import type { IPortalHost } from "./host";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Patterns } from "../trips/Art";
import { APP_VIEWS } from "./apps";
import { ViewFailed } from "./BootFailed";
import { Portal } from "./contexts";
import { Guarded } from "./Guarded";
import { AppIcon, MenuIcon } from "./icons";
import { closeRecords, closesDrawer, closesRecords, DRAWER_ID, focusRecords, syncDrawer, watchDrawer } from "./overlays";
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

	const [drawerOpen, setDrawerOpen] = createSignal(false);
	let root!: HTMLDivElement;
	onCleanup(watchDrawer(() => setDrawerOpen(false)));
	createEffect(
		on(drawerOpen, (open) => syncDrawer(root, open), {
			defer: true
		})
	);
	createEffect(
		on(
			() => portal.state.RecordsOpen,
			(open) => {
				if (open) focusRecords(root);
			},
			{
				defer: true
			}
		)
	);
	const closePanel = () => closeRecords(root, () => void portal.toggleRecords());
	const onPick = (event: MouseEvent) => {
		if (portal.state.RecordsOpen && closesRecords(event.target)) closePanel();
	};

	return (
		<div
			ref={root}
			class="portal"
			classList={{
				"with-records": portal.state.RecordsOpen,
				"drawer-open": drawerOpen()
			}}
		>
			<Patterns />
			<header class="mobilebar">
				<button
					type="button"
					class="menu"
					aria-label="Apps and session"
					aria-controls={DRAWER_ID}
					aria-expanded={drawerOpen()}
					onClick={() => setDrawerOpen(true)}
				>
					<MenuIcon />
				</button>
				<div class="mark" />
				<b>{active().Name}</b>
			</header>
			<button type="button" class="scrim" aria-label="Close the menu" tabIndex={-1} onClick={() => setDrawerOpen(false)} />
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: it acts only on clicks from the buttons and links inside, which keys fire too */}
			<aside
				id={DRAWER_ID}
				class="side"
				onClick={(event) => {
					if (closesDrawer(event.target)) setDrawerOpen(false);
					onPick(event);
				}}
			>
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
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: it acts only on clicks from the buttons and links inside, which keys fire too */}
			<main class={`app-${portal.state.ActiveApp}`} onClick={onPick}>
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
				<RecordPanel monitor={props.host.monitor} onClose={closePanel} />
			</Show>
		</div>
	);
});
