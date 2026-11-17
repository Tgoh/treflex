import type { MouseEvent } from "react";
import type { IEntityView } from "treflex-react";
import type { IAppInfo } from "../../../portal/src/portal/apps";
import type { IAppId, IPortal } from "../../../portal/src/portal/Portal";
import type { IPortalHost } from "../../../portal/src/shell/host";
import type { IAppViews } from "./apps";
import type { IRestoreProps } from "./RestoreBanner";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	closeRecords,
	closesDrawer,
	closesRecords,
	DRAWER_ID,
	focusRecords,
	syncDrawer,
	watchDrawer
} from "../../../portal/src/shell/overlays";
import { Patterns } from "../trips/Art";
import { APP_VIEWS } from "./apps";
import { ViewFailed } from "./BootFailed";
import { Portal } from "./contexts";
import { cx } from "./dom";
import { Guarded } from "./Guarded";
import { AppIcon, MenuIcon } from "./icons";
import { RecordPanel } from "./RecordPanel";
import { SessionCard } from "./SessionCard";
import { Toast } from "./Toast";
import { TourStrip } from "./TourStrip";

const AppEntry = memo(function AppEntry(props: {
	app: IAppInfo & IAppViews;
	portal: IEntityView<IPortal>;
	viewKey: unknown;
	onShow: (app: IAppId) => void;
}) {
	const { app, portal, onShow } = props;
	const on = portal.ActiveApp === app.Id;
	const show = useCallback(
		() => onShow(app.Id),
		[
			onShow,
			app.Id
		]
	);
	const acted = [
		portal.ActiveApp,
		props.viewKey
	];
	const Nav = app.Nav;
	return (
		<>
			<button
				type="button"
				className={cx("app", {
					on
				})}
				onClick={show}
			>
				<AppIcon icon={app.Icon} />
				<div>
					{app.Name}
					<Guarded name={`${app.Name} status`} retryOn={acted} fallback={() => <small>Status failed</small>}>
						<app.Status portal={portal} />
					</Guarded>
				</div>
				<Guarded name={`${app.Name} badge`} retryOn={acted} fallback={() => null}>
					<app.Badge portal={portal} />
				</Guarded>
			</button>
			{Nav ? (
				<Guarded name={`${app.Name} sidebar list`} retryOn={acted} fallback={() => null}>
					<Nav portal={portal} active={on} onShow={show} />
				</Guarded>
			) : null}
		</>
	);
});

export const PortalView = Portal.provider<{
	host: IPortalHost;
}>((props) => {
	const portal = Portal.use();
	const state = portal.state;
	const keys = portal.viewKeys();
	const active = APP_VIEWS.find((app) => app.Id === state.ActiveApp) ?? APP_VIEWS[0];
	const lines = portal.restoreBanner();
	const { dismissRestore, openApp, toggleRecords } = portal;
	const restore = useMemo<IRestoreProps>(
		() => ({
			lines,
			onDismiss: () => void dismissRestore()
		}),
		[
			lines,
			dismissRestore
		]
	);
	const showApp = useCallback(
		(id: IAppId) => void openApp(id),
		[
			openApp
		]
	);
	const onToggleRecords = useCallback(
		() => void toggleRecords(),
		[
			toggleRecords
		]
	);
	const tourStep = portal.tourStep();
	const Recover = active.Recover;
	const [drawerOpen, setDrawerOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const recordsOpen = state.RecordsOpen;
	const synced = useRef({
		drawer: false,
		records: recordsOpen
	});
	useEffect(() => watchDrawer(() => setDrawerOpen(false)), []);
	useEffect(() => {
		const was = synced.current;
		synced.current = {
			drawer: drawerOpen,
			records: recordsOpen
		};
		if (!root.current) return;
		if (drawerOpen !== was.drawer) syncDrawer(root.current, drawerOpen);
		if (recordsOpen && !was.records) focusRecords(root.current);
	}, [
		drawerOpen,
		recordsOpen
	]);
	const closePanel = useCallback(() => {
		if (root.current) closeRecords(root.current, onToggleRecords);
	}, [
		onToggleRecords
	]);
	const onPick = (event: MouseEvent<HTMLElement>) => {
		if (recordsOpen && closesRecords(event.target)) closePanel();
	};

	return (
		<div
			ref={root}
			className={cx("portal", {
				"with-records": state.RecordsOpen,
				"drawer-open": drawerOpen
			})}
		>
			<Patterns />
			<header className="mobilebar">
				<button
					type="button"
					className="menu"
					aria-label="Apps and session"
					aria-controls={DRAWER_ID}
					aria-expanded={drawerOpen}
					onClick={() => setDrawerOpen(true)}
				>
					<MenuIcon />
				</button>
				<div className="mark" />
				<b>{active.Name}</b>
			</header>
			<button type="button" className="scrim" aria-label="Close the menu" tabIndex={-1} onClick={() => setDrawerOpen(false)} />
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: it acts only on clicks from the buttons and links inside, which keys fire too */}
			<aside
				id={DRAWER_ID}
				className="side"
				onClick={(event) => {
					if (closesDrawer(event.target)) setDrawerOpen(false);
					onPick(event);
				}}
			>
				<div className="brand">
					<div className="mark" />
					<div>
						<b>treflex</b>
						<span>Demo portal</span>
					</div>
				</div>
				<nav>
					<div className="label">Apps</div>
					{APP_VIEWS.map((app) => (
						<AppEntry key={app.Id} app={app} portal={state} viewKey={keys[app.Id]} onShow={showApp} />
					))}
				</nav>
				<SessionCard host={props.host} recordsOpen={state.RecordsOpen} onToggleRecords={onToggleRecords} />
			</aside>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: it acts only on clicks from the buttons and links inside, which keys fire too */}
			<main className={`app-${state.ActiveApp}`} onClick={onPick}>
				<TourStrip state={state.Tour} />
				<Guarded
					key={active.Id}
					name={`${active.Name} view`}
					retryOn={[
						keys[active.Id]
					]}
					fallback={(retry) => (
						<ViewFailed title={`The ${active.Name} view failed.`} onRetry={retry} onReset={() => props.host.reset()} inset>
							{Recover ? <Recover portal={state} /> : null}
						</ViewFailed>
					)}
				>
					<active.View portal={state} tourStep={tourStep} restore={restore} />
				</Guarded>
				<Toast />
			</main>
			{state.RecordsOpen ? <RecordPanel monitor={props.host.monitor} onClose={closePanel} /> : null}
		</div>
	);
});
