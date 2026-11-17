declare const api: { save(form: { Title: string }): IActionGenerator<{ Version: number }> };
declare class ConflictError extends Error {}
declare const ctx: { openMapPending(): Promise<{ PeriodId: string } | undefined> };
declare const dialog: { show(value: { PeriodId: string }): void };
