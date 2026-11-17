import type { IApp } from "./app";
import { CounterView } from "./counter/CounterView";

export function AppView(props: { app: IApp }) {
	return <CounterView state={props.app.Counter} />;
}
