import { type IEntity, receiver } from "treflex";

interface IPlatform extends IEntity {
	Notice?: string;
}
declare function init(draft: IPlatform): IActionGenerator;
declare function discardSaved(): void;
declare const BUILD_ID: string | undefined;
const PlatformReceiver = receiver<IPlatform>("PlatformReceiver")({});
