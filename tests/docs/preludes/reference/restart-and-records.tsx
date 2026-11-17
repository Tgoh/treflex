import { type IEntity, receiver } from "treflex";

interface IPlatform extends IEntity {}
declare function init(draft: IPlatform): IActionGenerator;
declare function discardSaved(): void;
const PlatformReceiver = receiver<IPlatform>("PlatformReceiver")({});
