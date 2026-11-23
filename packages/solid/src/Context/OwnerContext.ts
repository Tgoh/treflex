import { createContext, useContext } from "solid-js";

export const OwnerContext = createContext<(() => string | undefined) | null>(null);

export const useOwner = (): (() => string | undefined) | undefined => useContext(OwnerContext) ?? undefined;
