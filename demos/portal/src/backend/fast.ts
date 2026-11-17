/** Whether `?fast` was in the address at boot, on a dev server: the scripted chat and the fake backend run on short delays. */
export const FAST: boolean = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("fast");

/** `ms`, cut to a seventh while FAST. */
export function paced(ms: number): number {
	return FAST ? Math.ceil(ms / 7) : ms;
}
