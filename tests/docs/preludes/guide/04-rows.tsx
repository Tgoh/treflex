import { defineEffect, type IEffect } from "treflex";

interface IFeedItem {
	Guid: string;
	Title: string;
	Link: string;
}
interface IFeedInfo {
	Title: string;
	Items: IFeedItem[];
}
const fetchFeed = defineEffect<IEffect & { Type: "Reader/FetchFeed"; Url: string }, IFeedInfo | null>("Reader/FetchFeed");

interface IReader extends IEntity {
	Feeds: IFeed[];
	NewUrl: string;
}
