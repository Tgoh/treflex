import type { IFail, IMount } from "../swap";
import { createRoot, ErrorBoundary } from "solid-js";
import { insert, render } from "solid-js/web";
import { TreflexProvider } from "treflex-solid";
import { BootFailed, ViewFailed } from "../../../portal/src/shell/BootFailed";
import { PortalView } from "../../../portal/src/shell/PortalView";

// render() would do, but when its insert throws it never hands back the dispose, and the view's timers and listeners live on.
export const mount: IMount = (element, runtime, host) =>
	createRoot((dispose) => {
		try {
			insert(
				element,
				<TreflexProvider value={runtime}>
					<ErrorBoundary
						fallback={(error, retry) => {
							console.error("[portal] the portal view failed:", error);
							return <ViewFailed title="The portal's view failed." onRetry={retry} onReset={() => host.reset()} />;
						}}
					>
						<PortalView state={runtime.state} host={host} />
					</ErrorBoundary>
				</TreflexProvider>
			);
		} catch (error) {
			dispose();
			throw error;
		}
		return () => {
			dispose();
			element.textContent = "";
		};
	});

export const fail: IFail = (element, reset) => render(() => <BootFailed onReset={reset} />, element);
