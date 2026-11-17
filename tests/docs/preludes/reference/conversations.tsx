type IRenameResult = { Name: string };
declare const api: { rename(id: string, name: string): IActionGenerator<IRenameResult> };
declare class ApiError extends Error {}
