import { type IEntity } from "treflex";

interface IFeed extends IEntity {
	Title: string;
}
interface IReader extends IEntity {
	Feeds: IFeed[];
	SelectedId: string | null;
	NewUrl: string;
}
declare function setNewUrl(draft: IReader, url: string): IActionGenerator;
declare function selectFeed(draft: IReader, feedId: string): IActionGenerator;
declare function refreshAll(draft: IReader): IActionGenerator;
declare function dismissNotice(draft: IReader): IActionGenerator;
declare function selected(draft: IReader): ISelectorGenerator<IFeed | undefined>;
function* addFeed(draft: IReader) {
	draft.NewUrl = "";
}
