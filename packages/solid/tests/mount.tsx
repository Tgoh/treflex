import type { JSX } from "@solidjs/web";
import { render } from "@solidjs/web";

export interface IMounted {
	container: HTMLDivElement;
	dispose: () => void;
}

// A provider's children run only when something reads them, so a test renders rather than creating a view bare.
export function mount(view: () => JSX.Element): IMounted {
	const container = document.createElement("div");
	const dispose = render(view, container);
	return {
		container,
		dispose
	};
}
