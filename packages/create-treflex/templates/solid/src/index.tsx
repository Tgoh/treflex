import { render } from "@solidjs/web";
import { Errored } from "solid-js";
import { TreflexProvider } from "treflex-solid";
import { AppView } from "./AppView";
import { boot } from "./boot";

// Declare no component here: Solid's hot refresh would then re-run this module
// on a hot update, and boot a second runtime beside the first.
void boot().then((runtime) => {
	render(
		() => (
			<Errored
				fallback={(error) => (
					<p role="alert">Something went wrong: {String(error())}</p>
				)}
			>
				<TreflexProvider value={runtime}>
					<AppView app={runtime.state} />
				</TreflexProvider>
			</Errored>
		),
		document.getElementById("root") as HTMLElement,
	);
});
