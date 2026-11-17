import { DRAWER_MEDIA, focusAfterRecords, RECORDS_REPLACE_MEDIA } from "./responsive";

export const DRAWER_ID = "portal-drawer";

/** Whether a tap on `target` inside the sidebar, while it is a drawer, closes it. */
export function closesDrawer(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("button, a") !== null;
}

/** Calls `close` on Escape, and when the window leaves the drawer layout. Returns the unsubscribe. */
export function watchDrawer(close: () => void): () => void {
	const media = matchMedia(DRAWER_MEDIA);
	const onMedia = (): void => {
		if (!media.matches) close();
	};
	const onKey = (event: KeyboardEvent): void => {
		if (event.key === "Escape") close();
	};
	media.addEventListener("change", onMedia);
	document.addEventListener("keydown", onKey);
	return () => {
		media.removeEventListener("change", onMedia);
		document.removeEventListener("keydown", onKey);
	};
}

/** After the drawer opens or closes: makes the rest of the portal inert while it is open, and moves focus to its first app, or back to the menu button. */
export function syncDrawer(portal: HTMLElement, open: boolean): void {
	for (const child of portal.children) {
		if (child instanceof HTMLElement) child.toggleAttribute("inert", open && !child.matches(".side, .scrim"));
	}
	portal.querySelector<HTMLElement>(open ? ".side .app" : ".mobilebar .menu")?.focus();
}

/** After the record panel opens: focuses its close button, which shows only where the panel replaces the main view. */
export function focusRecords(portal: HTMLElement): void {
	// The Solid build can run this before it mounts the panel.
	requestAnimationFrame(() => portal.querySelector<HTMLElement>(".rclose")?.focus());
}

/** Closes the record panel with `close`, and when focus was in the panel, which closing unmounts, returns it to what opened it. */
export function closeRecords(portal: HTMLElement, close: () => void): void {
	const inside = portal.querySelector(".records")?.contains(document.activeElement) === true;
	close();
	if (inside) requestAnimationFrame(() => focusAfterRecords(portal));
}

/** Whether a tap on `target` leaves the record panel behind where it replaces the main view: opening an app, a trip or a notice's link. */
export function closesRecords(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest(".side .app, .side .trip, .side .newtrip, .toast .link") !== null &&
		matchMedia(RECORDS_REPLACE_MEDIA).matches
	);
}
