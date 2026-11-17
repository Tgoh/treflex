import "../../portal/src/styles/portal.css";
import "../../portal/src/styles/trips.css";
import "../../portal/src/styles/aquarium.css";
import "../../portal/src/styles/chat.css";
import { browserStore } from "../../portal/src/portal/session";
import { mountPortal } from "./mount";

void mountPortal({
	element: document.getElementById("root") as HTMLElement,
	store: browserStore(),
	document,
	window,
	reload: () => location.reload()
});
