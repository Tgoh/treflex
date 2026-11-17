import { render } from "solid-js/web";
import { TreflexProvider } from "treflex-solid";
import { AppView } from "./AppView";
import { boot } from "./boot";

// Declare no component here: solid-refresh would then re-run this module on a
// hot update, and boot a second runtime beside the first.
void boot().then((runtime) => {
	render(
		() => (
			<TreflexProvider value={runtime}>
				<AppView app={runtime.state} />
			</TreflexProvider>
		),
		document.getElementById("root") as HTMLElement,
	);
});
