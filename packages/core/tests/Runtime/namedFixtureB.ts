import { named } from "../../src/Runtime/named";

export const nameInB = (action: unknown, name: string): unknown => named(action as never, name);
