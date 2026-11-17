/** The phone layout's media query. The phone blocks in styles/portal.css, trips.css, chat.css and aquarium.css repeat it. */
export const PHONE_MEDIA = "(max-width: 600px), (max-height: 500px) and (pointer: coarse)";

/** The drawer layout's media query. The drawer block in styles/portal.css repeats it. */
export const DRAWER_MEDIA = "(max-width: 900px), (max-height: 500px) and (pointer: coarse)";

/** Where the record panel replaces the main view instead of sitting beside it. The record panel block in styles/portal.css repeats it. */
export const RECORDS_REPLACE_MEDIA =
	"(max-width: 900px), (max-width: 1100px) and (pointer: coarse), (max-height: 500px) and (pointer: coarse)";

/** On a phone, where chat shows its list or its pane, focuses the half just shown: the pane's title, or the list's open row. */
export function focusChatHalf(chat: HTMLElement, pane: boolean): void {
	if (!matchMedia(PHONE_MEDIA).matches) return;
	requestAnimationFrame(() => {
		const target = pane
			? chat.querySelector<HTMLElement>(".ptitle")
			: (chat.querySelector<HTMLElement>(".ch.on") ?? chat.querySelector<HTMLElement>(".ch"));
		target?.focus();
	});
}

/** Focuses the Record stream toggle that opened the record panel, or in the drawer layout, where the toggle is in the closed drawer, the menu button. */
export function focusAfterRecords(portal: HTMLElement): void {
	const target = matchMedia(DRAWER_MEDIA).matches ? ".mobilebar .menu" : ".session .toggle";
	portal.querySelector<HTMLElement>(target)?.focus();
}
