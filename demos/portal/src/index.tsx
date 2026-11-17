import "./styles/portal.css";
import "./styles/trips.css";
import "./styles/aquarium.css";
import "./styles/chat.css";
import type { MountableElement } from "solid-js/web";
import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { TreflexProvider } from "treflex-solid";
import { browserStore } from "./portal/session";
import { BootFailed, ViewFailed } from "./shell/BootFailed";
import { PortalView } from "./shell/PortalView";
import { startPortal } from "./shell/start";

const root = document.getElementById("root") as MountableElement;

void startPortal({
	store: browserStore(),
	document,
	window,
	reload: () => location.reload(),
	render: (runtime, host) => {
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
			root
		);
	},
	fail: (reset) => {
		(root as HTMLElement).textContent = "";
		render(() => <BootFailed onReset={reset} />, root);
	}
});
