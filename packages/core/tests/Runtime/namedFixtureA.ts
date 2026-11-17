import { named } from "../../src/Runtime/named";

export const nameInA = (action: unknown, name: string): unknown => named(action as never, name);
