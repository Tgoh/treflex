import { defineEffect, type IEffect } from "treflex";

interface IFeedInfo {}
const fetchFeed = defineEffect<IEffect & { Type: "Reader/FetchFeed"; Url: string }, IFeedInfo | null>("Reader/FetchFeed");

interface IArticle extends IEntity {
	Title: string;
	Link: string;
}
interface IFeed extends IEntity {
	Url: string;
}
declare const fetchFeedImpl: import("treflex").IImplementationTag;
declare function assignFeed(feed: IFeed, info: IFeedInfo): IActionGenerator;
