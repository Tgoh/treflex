import type { Root } from "react-dom/client";
import type { IRuntime } from "treflex";
import type { IPortal } from "../../portal/src/portal/Portal";
import type { ISessionStore, ITabDocument, ITabWindow } from "../../portal/src/portal/session";
import type { IPortalHost } from "../../portal/src/shell/host";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TreflexProvider, useRoot } from "treflex-react";
import { startPortal } from "../../portal/src/shell/start";
import { BootFailed, ViewFailed } from "./shell/BootFailed";
import { Guarded } from "./shell/Guarded";
import { PortalView } from "./shell/PortalView";

export interface IMountPortal {
	element: HTMLElement;
	store: ISessionStore;
	document: ITabDocument;
	window: ITabWindow;
	reload(): void;
}

export interface IMountedPortal {
	runtime: IRuntime<IPortal>;
	host: IPortalHost;
	root: Root;
}

function PortalRoot(props: { host: IPortalHost }) {
	return <PortalView state={useRoot<IPortal>()} host={props.host} />;
}

/** Starts the portal as the Solid build does, and renders it into `element`. Resolves to what it mounted, or null when boot failed. */
export async function mountPortal({ element, store, document, window, reload }: IMountPortal): Promise<IMountedPortal | null> {
	// Each Guarded logs what it catches, as the Solid build's boundaries do.
	const root = createRoot(element, {
		onCaughtError: () => {}
	});
	let mounted: IMountedPortal | null = null;
	await startPortal({
		store,
		document,
		window,
		reload,
		render: (runtime, host) => {
			root.render(
				<StrictMode>
					<TreflexProvider value={runtime}>
						<Guarded
							name="portal view"
							fallback={(retry) => <ViewFailed title="The portal's view failed." onRetry={retry} onReset={() => host.reset()} />}
						>
							<PortalRoot host={host} />
						</Guarded>
					</TreflexProvider>
				</StrictMode>
			);
			mounted = {
				runtime,
				host,
				root
			};
		},
		fail: (reset) => {
			root.render(
				<StrictMode>
					<BootFailed onReset={reset} />
				</StrictMode>
			);
		}
	});
	return mounted;
}
