interface ITestList {
	list: MediaQueryList;
	matched: boolean;
}

const lists: ITestList[] = [];
let matcher: (query: string) => boolean = () => false;

/** Gives jsdom, which has none, a matchMedia whose queries match what `setMedia` last said. */
export function installMedia(): void {
	window.matchMedia = (query: string): MediaQueryList => {
		const list = new EventTarget() as MediaQueryList;
		Object.defineProperties(list, {
			matches: {
				get: () => matcher(query)
			},
			media: {
				value: query
			}
		});
		lists.push({
			list,
			matched: matcher(query)
		});
		return list;
	};
}

/** Sets which queries match, and fires `change` on each list whose answer changed, as a resize would. */
export function setMedia(match: (query: string) => boolean): void {
	matcher = match;
	for (const each of lists) {
		const matched = match(each.list.media);
		if (matched === each.matched) continue;
		each.matched = matched;
		each.list.dispatchEvent(
			Object.assign(new Event("change"), {
				matches: matched,
				media: each.list.media
			})
		);
	}
}

export function resetMedia(): void {
	matcher = () => false;
	lists.length = 0;
}
