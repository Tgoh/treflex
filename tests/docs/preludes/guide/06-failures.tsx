import { defineEffect, type IEffect, type IEntity } from "treflex";

declare module "treflex" {
	interface IMessageRegistry {
		"Feed/Gone": {};
	}
}

interface IFeedInfo {
	Title: string;
}
const fetchFeed = defineEffect<IEffect & { Type: "Reader/FetchFeed"; Url: string }, IFeedInfo | null>("Reader/FetchFeed");

interface IFeed extends IEntity {
	Url: string;
	Title: string;
	Articles: { $Id: string; Guid: string; Title: string; Link: string; Read: boolean }[];
}
interface IStarred extends IEntity {}
interface IReader extends IEntity {
	Feeds: IFeed[];
	SelectedId: string | null;
	NewUrl: string;
	Notice: string | null;
}
declare function assignFeed(feed: IFeed, info: IFeedInfo): IActionGenerator;
declare const seed: IReader;
declare const StarredReceiver: import("treflex").IReceiver<IStarred>;
