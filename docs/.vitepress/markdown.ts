import type { MarkdownRenderer } from "vitepress";

type IToken = ReturnType<MarkdownRenderer["parse"]>[number];

interface IEnv {
	path: string;
	realPath?: string;
}

const OPEN = "<!-- tabs -->";
const CLOSE = "<!-- /tabs -->";

const fileOf = (env: IEnv): string => env.realPath ?? env.path;

/**
 * Turns each tab group, a run of bold label paragraphs each followed by a fence between `<!-- tabs -->` and
 * `<!-- /tabs -->`, into the tokens VitePress's `::: code-group` container makes, so its renderer draws the tabs.
 */
export function tabs(md: MarkdownRenderer): void {
	md.core.ruler.after("block", "treflex-tabs", (state) => {
		const out: IToken[] = [];
		const tokens = state.tokens;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token.type !== "html_block" || token.content.trim() !== OPEN) {
				out.push(token);
				continue;
			}
			const line = (token.map?.[0] ?? 0) + 1;
			const fail = (why: string): Error => new Error(`${fileOf(state.env)}:${line}: a tab group ${why}`);
			const group: IToken[] = [];
			let j = i + 1;
			for (; j < tokens.length && !(tokens[j].type === "html_block" && tokens[j].content.trim() === CLOSE); j += 4) {
				const [open, inline, close, fence] = tokens.slice(j, j + 4);
				const label = inline?.type === "inline" ? /^\*\*([^*]+)\*\*$/.exec(inline.content.trim())?.[1] : undefined;
				if (open?.type !== "paragraph_open" || !label || close?.type !== "paragraph_close" || fence?.type !== "fence") {
					throw fail("holds only a bold label line before each fence");
				}
				fence.info = `${fence.info} [${label}]`;
				group.push(fence);
			}
			if (j === tokens.length) {
				throw fail(`has no ${CLOSE}`);
			}
			if (group.length === 0) {
				throw fail("is empty");
			}
			const groupOpen = new state.Token("container_code-group_open", "div", 1);
			const groupClose = new state.Token("container_code-group_close", "div", -1);
			for (const marker of [
				groupOpen,
				groupClose
			]) {
				marker.block = true;
				marker.markup = ":::";
				marker.info = "code-group";
			}
			out.push(groupOpen, ...group, groupClose);
			i = j;
		}
		state.tokens = out;
	});
}

export function links(md: MarkdownRenderer, rewrite: (href: string, page: string) => string): void {
	const render = md.renderer.rules.link_open!;
	md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
		const href = tokens[idx].attrGet("href");
		if (href !== null) {
			tokens[idx].attrSet("href", rewrite(href, fileOf(env)));
		}
		return render(tokens, idx, options, env, self);
	};
}
