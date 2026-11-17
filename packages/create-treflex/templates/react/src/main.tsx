import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TreflexProvider } from "treflex-react";
import { AppView } from "./AppView";
import { boot } from "./boot";

// Declare no component here: Fast Refresh would then re-run this module on a
// hot update, and boot a second runtime beside the first.
void boot().then((runtime) => {
	createRoot(document.getElementById("root") as HTMLElement).render(
		<StrictMode>
			<TreflexProvider value={runtime}>
				<AppView />
			</TreflexProvider>
		</StrictMode>,
	);
});
