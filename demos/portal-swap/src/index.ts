import "../../portal/src/styles/portal.css";
import "../../portal/src/styles/trips.css";
import "../../portal/src/styles/aquarium.css";
import "../../portal/src/styles/chat.css";
import { browserStore } from "../../portal/src/portal/session";
import { RENDERERS } from "./renderers";
import { startSwap } from "./swap";

void startSwap({
	element: document.getElementById("root") as HTMLElement,
	renderers: RENDERERS,
	store: browserStore(),
	document,
	window,
	reload: () => location.reload()
});
