import { defineEffect, type IEffect, type IEntity } from "treflex";

declare module "treflex" {
	interface IMessageRegistry {
		"Feed/Gone": {};
	}
}

interface IFeedInfo {}
const fetchFeed = defineEffect<IEffect & { Type: "Reader/FetchFeed"; Url: string }, IFeedInfo | null>("Reader/FetchFeed");

interface IArticle extends IEntity {}
interface IReader extends IEntity {
	Feeds: IFeed[];
	SelectedId: string | null;
	Notice: string | null;
}
declare function assignFeed(feed: IFeed, info: IFeedInfo): IActionGenerator;
function* refresh(draft: IFeed): IActionGenerator {
	const info = yield* fetchFeed({ Url: draft.Url });
	if (info === null) return;
	yield* assignFeed(draft, info);
}
