export const DEV_PORTS = {
	solid: 5173,
	react: 5174
} as const;

export type IBuild = keyof typeof DEV_PORTS;

/** The session card's link to the other build: `VITE_OTHER_BUILD_URL` when set, else the other dev server in dev, else none. */
export function otherBuildUrl(current: IBuild): string | undefined {
	const configured = import.meta.env.VITE_OTHER_BUILD_URL;
	if (configured) {
		return configured;
	}
	if (!import.meta.env.DEV) {
		return undefined;
	}
	return `http://localhost:${DEV_PORTS[current === "solid" ? "react" : "solid"]}/`;
}
