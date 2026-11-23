import "./styles.css";
import { BUILD } from "virtual:build-id";
import { render } from "@solidjs/web";
import { TreflexProvider } from "treflex-solid";
import { autosave, boot, browserStore, pageWait, SERVER_KEY, SESSION_KEY, storedServer } from "./session";
import { ORDER_ID, readServer } from "./shop/shop";
import { ShopView } from "./views/ShopView";

const session = browserStore(SESSION_KEY);
const serverStore = browserStore(SERVER_KEY);
const { server, onChange } = storedServer(serverStore);

const { runtime } = await boot(session, server, pageWait, {
	onError: (error) => console.error("[checkout]", error),
	requireNames: true,
	build: BUILD,
	resume: true
});

const saving = autosave(runtime, session);
window.addEventListener("pagehide", saving.save);
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") saving.save();
});

onChange(() => void runtime.dispatch(readServer, ORDER_ID));
void runtime.dispatch(readServer, ORDER_ID);

const reset = (): void => {
	saving.stop();
	session.clear();
	serverStore.clear();
	location.reload();
};

render(
	() => (
		<TreflexProvider value={runtime}>
			<ShopView shop={runtime.state} onReset={reset} />
		</TreflexProvider>
	),
	document.getElementById("root") as HTMLElement
);
