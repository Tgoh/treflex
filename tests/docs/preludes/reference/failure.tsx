import type { IActionGenerator } from "treflex";

declare const ctx: { openMapPending(): Promise<{ PeriodId: string } | undefined> };
declare const dialog: { show(value: { PeriodId: string }): void };
declare class ConflictError extends Error {}
declare function save(body: { Title: string }): IActionGenerator<number>;
