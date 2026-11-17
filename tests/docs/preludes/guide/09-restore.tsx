import { defineEffect, type IActionGenerator, type IEffect, type IEntity, implementation, receiver } from "treflex";

interface IFeedInfo {
	Title: string;
}
const fetchFeed = defineEffect<IEffect & { Type: "Reader/FetchFeed"; Url: string }, IFeedInfo | null>("Reader/FetchFeed");
const fetchFeedImpl = implementation(fetchFeed, async () => null);

interface IFeed extends IEntity {
	Url: string;
	Title: string;
	Articles: { $Id: string; Guid: string; Title: string; Link: string; Read: boolean }[];
}
interface IReader extends IEntity {
	Feeds: IFeed[];
}
const FeedReceiver = receiver<IFeed>("FeedReceiver")({});
const ReaderReceiver = receiver<IReader>("ReaderReceiver")({});
const StarredReceiver = receiver<IEntity>("StarredReceiver")({});
declare function initFeed(draft: IFeed, info: IFeedInfo): IActionGenerator;
declare function init(draft: IReader): IActionGenerator;
declare function registerPush(runtime: import("treflex").IRuntime<IReader>): void;
declare const seed: IReader;
