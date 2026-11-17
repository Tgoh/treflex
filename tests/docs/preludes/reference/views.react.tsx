import { createRoot } from "react-dom/client";
import { createRuntime, type IEntity } from "treflex";
import { createEntityFeature, TreflexProvider, useRoot } from "treflex-react";

interface ITodoList extends IEntity {
	Draft: string;
	Todos: { Text: string }[];
}
const App = createEntityFeature<ITodoList>("react-root")({}).provider(() => null);
