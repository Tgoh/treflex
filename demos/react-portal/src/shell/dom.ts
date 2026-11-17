import type { CSSProperties } from "react";

/** A className from a base and the names whose flag is true, as Solid's `classList` builds it. */
export function cx(base: string, flags: Record<string, boolean>): string {
	const on = Object.keys(flags).filter((name) => flags[name]);
	return [
		base,
		...on
	]
		.filter((name) => name !== "")
		.join(" ");
}

/** A style that sets CSS custom properties, which `CSSProperties` doesn't type. */
export function styled(style: Record<string, string | undefined>): CSSProperties {
	return style as CSSProperties;
}
