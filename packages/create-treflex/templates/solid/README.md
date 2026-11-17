# treflex app

A Solid app on [treflex](https://tgoh.github.io/treflex/docs/): an `App` root entity holding one feature, the [quickstart](https://tgoh.github.io/treflex/docs/quickstart.html)'s counter, with tests, lint, hot reload, and a count that survives a reload.

## What's where

- [`src/app.ts`](./src/app.ts): `IApp`, the root entity, with a field for each feature's entity, and `seed()`, the state a fresh start begins from.
- [`src/AppView.tsx`](./src/AppView.tsx): the root's view, which mounts each feature's view on its entity.
- [`src/boot.ts`](./src/boot.ts): builds the runtime, saves it on `pagehide`, and restores the save at the next load. When a reload cut an increment short, the restore tells the counter, and the view says so.
- [`src/index.tsx`](./src/index.tsx): renders once the boot resolves.
- [`src/counter/`](./src/counter/): the counter feature.
  - [`counter.ts`](./src/counter/counter.ts): the counter entity, the `increment` action, the `clicks` selector, and the feature that gives a view all of them. `named(increment, "Counter/Increment")` gives the action the name a save records it by, which the restore in `boot.ts` matches on. `leading(increment)` drops a second `increment` dispatched while one runs, which the test shows.
  - [`effects.ts`](./src/counter/effects.ts): the `delay` effect that `increment` yields.
  - [`implementations/delay.ts`](./src/counter/implementations/delay.ts): what answers `delay`. Reading the clock or drawing a random number belongs in an `implementations/` folder, the one place the lint allows it.
  - [`CounterView.tsx`](./src/counter/CounterView.tsx): the button, disabled while `useInFlight` says an increment runs.
  - [`counter.test.ts`](./src/counter/counter.test.ts): tests on `createTestRuntime`, with `delay` stubbed.
  - [`CounterView.test.tsx`](./src/counter/CounterView.test.tsx): a component test, as [testing a Solid component](https://tgoh.github.io/treflex/docs/reference/testing.html#testing-a-solid-component) describes.
- [`vitest.config.ts`](./vitest.config.ts): runs tests in Node unless a file selects jsdom, and loads `treflex/vitest`, so that when the test runtime catches a failure or a diag, the test that caused it is the one that fails.
- [`biome.json`](./biome.json): Biome, which formats and lints, with treflex's two lint plugins.
- [`eslint.config.js`](./eslint.config.js): ESLint with `treflex-eslint`'s rules and no others. They read types, so they report a generator the app's own code creates and drops, such as `delay({ Ms: 1000 })` without `yield*`, which Biome's plugins don't see. [Lint setup](https://tgoh.github.io/treflex/docs/reference/effects.html#lint-setup) says what each covers.

## Commands

```sh
npm run dev         # the dev server
npm run build       # typecheck, then a production build in dist/
npm run preview     # serve the production build
npm run typecheck
npm run lint        # Biome, then ESLint
npm test            # Vitest
npm run check       # typecheck, lint and test
```

## Add a feature

A feature, a todo list say, gets a folder of its own beside `src/counter/`:

- **The type, the actions and the selectors** go in `src/todo/todo.ts`, with the feature: `createEntityFeature<ITodo>("Todo")`. The id is a string no other feature uses, never `import.meta.url`, which two features in one file would share.
- **Each action's name:** the runtime refuses an action with no `named(action, "Todo/Add")` mark, since `boot.ts` sets `requireNames`. Run `npx treflex-eslint name` after writing the actions to add the marks; `npm run check` reports an action left without one. The command chooses a name once, and changing it afterwards is like renaming a saved field: a save made before the change names the old one.
- **The effects** go in `src/todo/effects.ts`, and **their implementations** in `src/todo/implementations/`, each registered in `setup` in `src/boot.ts`.
- **The seed:** a `Todo` field on `IApp` in `src/app.ts`, and its starting state, with an `$Id` of its own, in `seed()`. Once that is saved, and before a view is mounted on the new field, raise `APP_VERSION` in `src/boot.ts`. The app saves at every `pagehide`, so a save from before the change restores without `Todo` and breaks that view, and a version raised first is saved in the old shape. A save of another version starts the app fresh from `seed()`.
- **The view** goes in `src/todo/TodoView.tsx`, mounted from `src/AppView.tsx` on `props.app.Todo`.
- **The tests** go in `src/todo/todo.test.ts`, on `createTestRuntime` with the todo list as the root, and `src/todo/TodoView.test.tsx` for the view, which starts with `// @vitest-environment jsdom`, as `CounterView.test.tsx` does. Keep `generateGuid: guids("todo")` among the stubs, as the counter's tests do: an action that makes an entity yields `generateGuid`, which the test runtime refuses unstubbed. The test runtime fails a test on any failure or diag it doesn't allow: a test that expects an action to fail lists it, `allowFailures: [increment]` as the counter's failure test does, and one that expects a diag passes `allowDiags` with its code.
- **Hot reload:** if `src/boot.ts` imports from `src/todo/todo.ts`, to repair a restore or to load data, add `"./todo/todo"` to the list in its `import.meta.hot?.accept`. An edit to a view, an action or a selector then applies in place, with the state kept. An edit to anything else reloads the page, which saves and restores the state.

A load the app needs each time it opens goes in the boot: [load data when the app opens](https://tgoh.github.io/treflex/docs/patterns.html#load-data-when-the-app-opens).

## Saves

Raise `APP_VERSION` for any other change to the state's shape too, a field added to the counter say. [A newer build](https://tgoh.github.io/treflex/docs/reference/restart-and-records.html#a-newer-build) shows migrating an older save instead. A save the restore refuses with `SnapshotRejectedError` is discarded too, with a warning in the console.

`vite.config.ts` writes the time of a production build in as `import.meta.env.VITE_BUILD_ID`, and `boot.ts` passes it as the runtime's `build`, so a save records which code wrote it. Where CI has a commit id, write that in instead. The dev server has none, since its code changes with every edit.

## TypeScript

The app is on TypeScript 6, because `treflex-eslint` runs on typescript-eslint, which doesn't run on TypeScript 7. The template moves to TypeScript 7 when typescript-eslint supports it.

## Next

- [The quickstart](https://tgoh.github.io/treflex/docs/quickstart.html) names each part of the counter.
- [The guide](https://tgoh.github.io/treflex/docs/guide/01-entities.html) builds a larger app, a step per page. [Restore](https://tgoh.github.io/treflex/docs/guide/09-restore.html) is the boot in `src/boot.ts`.
- [Testing](https://tgoh.github.io/treflex/docs/reference/testing.html) has the rest of `createTestRuntime` and `settled`.
