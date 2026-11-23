import type { JSX } from "@solidjs/web";
import { createEffect, Errored } from "solid-js";

export function Guarded(props: {
	name: string;
	retryOn: () => unknown;
	fallback: (retry: () => void) => JSX.Element;
	children: JSX.Element;
}) {
	return (
		<Errored
			fallback={(error, retry) => {
				console.error(`[portal] the ${props.name} failed:`, error());
				createEffect(
					() => props.retryOn(),
					() => retry(),
					{
						defer: true
					}
				);
				return props.fallback(retry);
			}}
		>
			{props.children}
		</Errored>
	);
}
