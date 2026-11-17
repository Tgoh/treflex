import type { JSX } from "solid-js";
import { createEffect, ErrorBoundary, on } from "solid-js";

export function Guarded(props: {
	name: string;
	retryOn: () => unknown;
	fallback: (retry: () => void) => JSX.Element;
	children: JSX.Element;
}) {
	return (
		<ErrorBoundary
			fallback={(error, retry) => {
				console.error(`[portal] the ${props.name} failed:`, error);
				createEffect(
					on(props.retryOn, retry, {
						defer: true
					})
				);
				return props.fallback(retry);
			}}
		>
			{props.children}
		</ErrorBoundary>
	);
}
