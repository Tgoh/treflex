# Working on this app

A Solid app on [treflex](https://tgoh.github.io/treflex/docs/). [`README.md`](./README.md) says what's where and how to add a feature. The docs are indexed for agents at [`llms.txt`](https://tgoh.github.io/treflex/docs/llms.txt).

## Rules

- **State is plain data:** objects, arrays, strings, numbers, booleans and `null`. No `Date`, `Map`, `Set` or class instance; store epoch milliseconds, and arrays of entries.
- **Async work goes through effects.** Declare an effect in the feature's `effects.ts`, answer it in the feature's `implementations/` folder, and register the implementation in `setup` in `src/boot.ts`. An action or selector never calls `fetch` or `setTimeout`, and reads the clock or a random number only through an effect. The lint refuses `Date.now()`, `new Date()` and `Math.random()` outside `implementations/`.
- **Call an effect, a treflex operation or a helper generator with `yield*`.** A call without it runs nothing. ESLint reports it as `treflex/no-discarded-generator`.
- **An action holds its entity until it ends,** and other work on that entity queues behind it. To let work in during a wait, wrap the wait in `open(...)`, and leave an action that uses `open` without a return type annotation. `leading(action)` drops a repeat; `latest(action)` replaces the running one.
- **A view reads state and dispatches actions.** It starts no work and cleans nothing up. Busy state is `useInFlight`, not a flag in state, and not a store or signal of the view's own. Data the app needs when it opens is loaded from the boot.
- **A feature's id is a string no other feature uses,** never `import.meta.url`.
- **Every action has a name,** `named(action, "Feature/Action")` after its declaration, because the runtime refuses one without in development; a production build runs it unnamed, and a restore can't say what it was. Run `npx treflex-eslint name` after adding actions to name them; `npm run check` reports one left unnamed. Changing a name afterwards is like renaming a saved field: a save made before the change names the old one.
- **A change to the state's shape raises `APP_VERSION`** in `src/boot.ts`.
- **Tests run on `createTestRuntime`** with a stub for every effect the code yields, `generateGuid: guids("…")` among them when an action makes an entity. Await `settled()` before asserting. The test runtime fails a test on any diag or failure it doesn't allow: list an action that is meant to fail in `allowFailures`, as the function itself, and an expected diag's code in `allowDiags`. Keep `treflex/vitest` in the Vitest config's `setupFiles`, which makes the failing test the one that caused it.

## Before you finish

Run `npm run check`: the typecheck, Biome, ESLint and the tests. It must pass.
