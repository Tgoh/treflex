import type { IRendererSwap } from "./host";

export const DEV_PORTS = {
	solid: 5173,
	react: 5174,
	swap: 5175
} as const;

export type IBuild = "solid" | "react";

const OTHER_BUILD: Record<IBuild, IBuild> = {
	solid: "react",
	react: "solid"
};

const LABELS: Record<IBuild, string> = {
	solid: "Solid",
	react: "React"
};

/** The session card's link to the other build: `VITE_OTHER_BUILD_URL` when set, else the other dev server in dev, else none. */
function otherBuildUrl(current: IBuild): string | undefined {
	const configured = import.meta.env.VITE_OTHER_BUILD_URL;
	if (configured) {
		return configured;
	}
	if (!import.meta.env.DEV) {
		return undefined;
	}
	return `http://localhost:${DEV_PORTS[OTHER_BUILD[current]]}/`;
}

export type IOtherBuild =
	| {
			kind: "swap";
			swap: IRendererSwap;
	  }
	| {
			kind: "link";
			href: string;
	  }
	| {
			kind: "none";
	  };

/** How the session card reaches the other build: in place when the host can swap renderers, else by `otherBuildUrl`'s link, else not at all. */
export function otherBuild(current: IBuild, swap: IRendererSwap | undefined): IOtherBuild {
	if (swap) {
		return {
			kind: "swap",
			swap
		};
	}
	const href = otherBuildUrl(current);
	return href
		? {
				kind: "link",
				href
			}
		: {
				kind: "none"
			};
}

export interface ISwapButton {
	Build: IBuild;
	Label: string;
	Pressed: boolean;
	Busy: boolean;
}

/** The swap build's renderer buttons, for the card mounted in `current`'s view while a swap loads `pending`. */
export function swapButtons(current: IBuild, pending: IBuild | null): ISwapButton[] {
	return (Object.keys(LABELS) as IBuild[]).map((build) => ({
		Build: build,
		Label: LABELS[build],
		Pressed: build === current,
		Busy: build !== current && build === pending
	}));
}
