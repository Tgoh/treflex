import type { IFail, IMount } from "../swap";
import { render } from "@solidjs/web";
import { Errored } from "solid-js";
import { TreflexProvider } from "treflex-solid";
import { BootFailed, ViewFailed } from "../../../portal/src/shell/BootFailed";
import { PortalView } from "../../../portal/src/shell/PortalView";

export const mount: IMount = (element, runtime, host) =>
	render(
		() => (
			<TreflexProvider value={runtime}>
				<Errored
					fallback={(error, retry) => {
						console.error("[portal] the portal view failed:", error());
						return <ViewFailed title="The portal's view failed." onRetry={retry} onReset={() => host.reset()} />;
					}}
				>
					<PortalView state={runtime.state} host={host} />
				</Errored>
			</TreflexProvider>
		),
		element
	);

export const fail: IFail = (element, reset) => {
	render(() => <BootFailed onReset={reset} />, element);
};
