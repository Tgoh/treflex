import { defineEffect, entity, type IActionGenerator, type IEffect, type IEntity, implementation, open } from "treflex";

interface IFeedInfo {
	Title: string;
}
const fetchFeed = defineEffect<IEffect & { Type: "Reader/FetchFeed"; Url: string }, IFeedInfo | null>("Reader/FetchFeed");
const fetchFeedImpl = implementation(fetchFeed, async () => null);

interface IFeed extends IEntity {
	Url: string;
	Title: string;
}
interface IReader extends IEntity {
	Feeds: IFeed[];
	SelectedId: string | null;
	NewUrl: string;
}
function* refresh(draft: IFeed): IActionGenerator {
	const info = yield* fetchFeed({ Url: draft.Url });
	if (info === null) return;
	draft.Title = info.Title;
}
function* setNewUrl(draft: IReader, url: string): IActionGenerator {
	draft.NewUrl = url;
}
function* selectFeed(draft: IReader, feedId: string): IActionGenerator {
	draft.SelectedId = feedId;
}
function* addFeed(draft: IReader) {
	const url = draft.NewUrl.trim();
	const info = yield* open(fetchFeed({ Url: url }));
	if (info === null) return;
	draft.Feeds.push(yield* entity<IFeed>({ Url: url, Title: info.Title }));
}
