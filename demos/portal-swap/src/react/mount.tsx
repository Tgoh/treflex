import type { IPortal } from "../../../portal/src/portal/Portal";
import type { IPortalHost } from "../../../portal/src/shell/host";
import type { IFail, IMount } from "../swap";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { TreflexProvider, useRoot } from "treflex-react";
import { BootFailed, ViewFailed } from "../../../react-portal/src/shell/BootFailed";
import { Guarded } from "../../../react-portal/src/shell/Guarded";
import { PortalView } from "../../../react-portal/src/shell/PortalView";

function PortalRoot(props: { host: IPortalHost }) {
	return <PortalView state={useRoot<IPortal>()} host={props.host} />;
}

// Each Guarded logs what it catches, as the Solid view's boundaries do.
const quiet = {
	onCaughtError: () => {}
};

export const mount: IMount = (element, runtime, host) => {
	const root = createRoot(element, quiet);
	// Rendered before returning, as Solid's is, so swap.ts can move focus into it.
	flushSync(() =>
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
		)
	);
	return () => root.unmount();
};

export const fail: IFail = (element, reset) => {
	createRoot(element, quiet).render(
		<StrictMode>
			<BootFailed onReset={reset} />
		</StrictMode>
	);
};
