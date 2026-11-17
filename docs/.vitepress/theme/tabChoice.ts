export const TAB_KEY = "treflex-docs-tab";
// Each group's first tab, which the built page shows before a choice is applied.
export const DEFAULT_TAB = "React";

// The config inlines this function's source into each page's head, so its body uses nothing from outside itself.
export function showTab(tab: string): void {
	for (const group of document.querySelectorAll(".vp-code-group")) {
		const labels = [
			...group.querySelectorAll<HTMLLabelElement>(":scope > .tabs > label")
		];
		const at = labels.findIndex((label) => label.dataset.title === tab);
		if (at < 0) {
			continue;
		}
		const input = document.getElementById(labels[at].htmlFor);
		if (input instanceof HTMLInputElement) {
			input.checked = true;
		}
		group.querySelectorAll(":scope > .blocks > *").forEach((block, i) => {
			block.classList.toggle("active", i === at);
		});
	}
}

/**
 * Shows the stored tab as soon as the page is parsed, before the browser jumps to the URL's hash or restores a
 * reload's scroll position, so neither lands on a layout the switch then changes.
 */
export const headScript = `document.addEventListener("DOMContentLoaded",function(){var tab;try{tab=localStorage.getItem(${JSON.stringify(TAB_KEY)})}catch(e){}if(tab&&tab!==${JSON.stringify(DEFAULT_TAB)})(${showTab.toString()})(tab)})`;
