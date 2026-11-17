import type { Theme } from "vitepress";
import { inBrowser, onContentUpdated } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { DEFAULT_TAB, showTab, TAB_KEY } from "./tabChoice";

function chosen(): string {
	try {
		return localStorage.getItem(TAB_KEY) ?? DEFAULT_TAB;
	} catch {
		return DEFAULT_TAB;
	}
}

function remember(tab: string): void {
	try {
		localStorage.setItem(TAB_KEY, tab);
	} catch {}
}

export default {
	extends: DefaultTheme,
	enhanceApp() {
		if (!inBrowser) {
			return;
		}
		window.addEventListener("click", (event) => {
			const input = event.target;
			if (!(input instanceof HTMLInputElement) || !input.matches(".vp-code-group > .tabs > input")) {
				return;
			}
			const group = input.closest(".vp-code-group")!;
			const tab = group.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)?.dataset.title;
			if (!tab) {
				return;
			}
			remember(tab);
			// Groups above the clicked one change height, so hold the clicked one where it was on screen.
			const top = group.getBoundingClientRect().top;
			showTab(tab);
			window.scrollBy(0, group.getBoundingClientRect().top - top);
		});
	},
	setup() {
		// VitePress resets every group to its first tab when content updates in dev, so show the choice after that.
		onContentUpdated(() => queueMicrotask(() => showTab(chosen())));
	}
} satisfies Theme;
