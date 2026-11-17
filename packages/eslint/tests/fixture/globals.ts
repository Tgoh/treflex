// A script, so both are globals in every rule-tester case: the fix must not take this `named` for a
// module's own binding, and this `start`, which has a body, is the app's own and not treflex's.
declare function named(action: unknown, name: string): void;

function start(job: unknown): void {}
