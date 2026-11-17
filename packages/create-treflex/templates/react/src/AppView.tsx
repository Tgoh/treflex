import { useRoot } from "treflex-react";
import type { IApp } from "./app";
import { CounterView } from "./counter/CounterView";

export function AppView() {
	const app = useRoot<IApp>();
	return <CounterView state={app.Counter} />;
}
