// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { headScript, TAB_KEY } from "../../docs/.vitepress/theme/tabChoice";

// Node's own `localStorage` global, undefined without --localstorage-file, hides jsdom's.
Object.defineProperty(globalThis, "localStorage", {
	value: (
		globalThis as unknown as {
			jsdom: {
				window: Window;
			};
		}
	).jsdom.window.localStorage,
	configurable: true
});

const GROUP = `<div class="vp-code-group"><div class="tabs"><input type="radio" name="group-a" id="tab-react" checked><label data-title="React" for="tab-react">React</label><input type="radio" name="group-a" id="tab-solid"><label data-title="Solid" for="tab-solid">Solid</label></div><div class="blocks"><div class="language-tsx active"></div><div class="language-tsx"></div></div></div>`;

function load(stored: string | null): {
	checked: string | undefined;
	active: number[];
	errors: unknown[];
} {
	document.body.innerHTML = GROUP;
	localStorage.clear();
	if (stored !== null) {
		localStorage.setItem(TAB_KEY, stored);
	}
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent): void => {
		errors.push(event.error);
	};
	window.addEventListener("error", onError);
	// The page runs the script from its head, where only browser globals are in scope.
	new Function(headScript)();
	document.dispatchEvent(new Event("DOMContentLoaded"));
	window.removeEventListener("error", onError);
	return {
		checked: document.querySelector<HTMLInputElement>("input:checked")?.id,
		active: [
			...document.querySelectorAll(".blocks > *")
		].flatMap((block, i) =>
			block.classList.contains("active")
				? [
						i
					]
				: []
		),
		errors
	};
}

describe("the head script", () => {
	afterEach(() => {
		document.body.innerHTML = "";
		localStorage.clear();
	});

	it("shows the stored tab once the page is parsed", () => {
		expect(load("Solid")).toEqual({
			checked: "tab-solid",
			active: [
				1
			],
			errors: []
		});
	});

	it("leaves the first tab with nothing stored", () => {
		expect(load(null)).toEqual({
			checked: "tab-react",
			active: [
				0
			],
			errors: []
		});
	});
});
