import type { ReactNode } from "react";
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

/**
 * Renders `node` into a new root before returning, as Solid does, so swap.ts can move focus into it at once. React 19 hands
 * an error no boundary caught to `onUncaughtError` instead of throwing it, so one from the mount is thrown from here, where
 * swap.ts recovers; one after the mount is reported as React would. Returns the unmount.
 */
export function mountNow(element: HTMLElement, node: ReactNode): () => void {
	let mounting = true;
	let failure:
		| {
				error: unknown;
		  }
		| undefined;
	const root = createRoot(element, {
		...quiet,
		onUncaughtError: (error) => {
			if (mounting)
				failure ??= {
					error
				};
			else if (typeof reportError === "function") reportError(error);
			else console.error(error);
		}
	});
	try {
		flushSync(() => root.render(node));
	} catch (error) {
		failure ??= {
			error
		};
	} finally {
		mounting = false;
	}
	if (failure) {
		try {
			root.unmount();
		} catch (error) {
			console.error("[portal] unmounting the failed React view failed too:", error);
		}
		throw failure.error;
	}
	return () => root.unmount();
}

export const mount: IMount = (element, runtime, host) =>
	mountNow(
		element,
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

export const fail: IFail = (element, reset) => {
	const root = createRoot(element, quiet);
	root.render(
		<StrictMode>
			<BootFailed onReset={reset} />
		</StrictMode>
	);
	return () => root.unmount();
};
