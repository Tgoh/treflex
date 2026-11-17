import { describe, expect, it } from "vitest";
import aquariumCss from "../styles/aquarium.css?raw";
import chatCss from "../styles/chat.css?raw";
import portalCss from "../styles/portal.css?raw";
import tripsCss from "../styles/trips.css?raw";
import { DRAWER_MEDIA, PHONE_MEDIA, RECORDS_REPLACE_MEDIA as REPLACE_MEDIA } from "./responsive";

const STYLES: Record<string, string> = {
	"portal.css": portalCss,
	"trips.css": tripsCss,
	"chat.css": chatCss,
	"aquarium.css": aquariumCss
};

interface IMediaBlock {
	file: string;
	query: string;
	body: string;
}

function mediaBlocks(): IMediaBlock[] {
	const blocks: IMediaBlock[] = [];
	for (const [file, css] of Object.entries(STYLES)) {
		for (let at = css.indexOf("@media"); at !== -1; at = css.indexOf("@media", at + 1)) {
			const open = css.indexOf("{", at);
			let depth = 1;
			let end = open + 1;
			for (; depth > 0; end++) {
				if (css[end] === "{") depth++;
				else if (css[end] === "}") depth--;
			}
			blocks.push({
				file,
				query: css.slice(at + "@media".length, open).trim(),
				body: css.slice(open + 1, end - 1)
			});
		}
	}
	return blocks;
}

describe("the layout media queries", () => {
	const blocks = mediaBlocks();

	it("are only the phone, drawer, touch and record panel queries, with a phone block in every stylesheet", () => {
		const known = new Set([
			PHONE_MEDIA,
			DRAWER_MEDIA,
			"(max-width: 900px), (pointer: coarse)",
			REPLACE_MEDIA
		]);
		const strays = blocks.filter((block) => /max-(width|height)/.test(block.query) && !known.has(block.query));
		expect(strays.map((block) => `${block.file}: @media ${block.query}`)).toEqual([]);
		for (const file of Object.keys(STYLES)) expect(blocks.some((block) => block.file === file && block.query === PHONE_MEDIA)).toBe(true);
	});

	it("show the menu bar in the drawer layout", () => {
		const shown = blocks.filter((block) => /\.mobilebar \{[^}]*display: flex/.test(block.body));
		expect(shown.map((block) => block.query)).toEqual([
			DRAWER_MEDIA
		]);
	});

	it("put the record panel in main's place, and its close button on screen, wherever the drawer layout applies", () => {
		const replace = blocks.find((block) => block.query === REPLACE_MEDIA)!;
		expect(replace.body).toMatch(/\.portal\.with-records main \{\s*display: contents;/);
		expect(replace.body).toMatch(/\.portal\.with-records main > :not\(\.toast\) \{\s*display: none;/);
		expect(replace.body).toMatch(/\.rclose \{\s*display: grid;/);
		for (const query of DRAWER_MEDIA.split(", ")) expect(REPLACE_MEDIA.split(", ")).toContain(query);
	});
});
