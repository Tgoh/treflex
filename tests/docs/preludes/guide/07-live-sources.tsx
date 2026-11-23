import { defineEffect, type IEffect, type IEntity } from "treflex";

declare module "treflex" {
	interface IMessageRegistry {
		"Feed/Gone": {};
	}
}

interface IFeedInfo {}
declare function loadFeed(url: string): IActionGenerator<IFeedInfo | null>;

interface IArticle extends IEntity {}
interface IReader extends IEntity {
	Feeds: IFeed[];
	SelectedId: string | null;
	Notice: string | null;
}
declare function assignFeed(feed: IFeed, info: IFeedInfo): IActionGenerator;
function* refresh(draft: IFeed): IActionGenerator {
	const info = yield* loadFeed(draft.Url);
	if (info === null) return;
	yield* assignFeed(draft, info);
}
