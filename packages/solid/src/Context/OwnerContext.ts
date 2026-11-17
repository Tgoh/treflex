import { createContext } from "solid-js";

export const OwnerContext = createContext<() => string | undefined>();
