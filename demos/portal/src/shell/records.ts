import type { IResolvedLine } from "../portal/monitor";
import { LANE_ORDER } from "../portal/Portal";

/** How many of the monitor's latest lines the record stream panel shows. */
export const SHOWN_LINES = 40;

/** A line's time of day, as 09:41:07. */
export function lineTime(at: number): string {
	const d = new Date(at);
	return [
		d.getHours(),
		d.getMinutes(),
		d.getSeconds()
	]
		.map((n) => String(n).padStart(2, "0"))
		.join(":");
}

/** The lanes the lines touch, as [lane, its name], in `LANE_ORDER`. */
export function lanesOf(lines: readonly IResolvedLine[]): [
	string,
	string
][] {
	const seen = new Map<string, string>();
	for (const line of lines) seen.set(line.Lane, line.LaneName);
	return [
		...seen
	].sort(([a], [b]) => LANE_ORDER.indexOf(a) - LANE_ORDER.indexOf(b));
}
