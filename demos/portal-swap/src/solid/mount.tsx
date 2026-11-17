import type { IFail, IMount } from "../swap";
import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { TreflexProvider } from "treflex-solid";
import { BootFailed, ViewFailed } from "../../../portal/src/shell/BootFailed";
import { PortalView } from "../../../portal/src/shell/PortalView";

export const mount: IMount = (element, runtime, host) =>
	render(
		() => (
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
		),
		element
	);

export const fail: IFail = (element, reset) => {
	render(() => <BootFailed onReset={reset} />, element);
};
