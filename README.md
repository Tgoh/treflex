# Treflex

Treflex is a runtime for application state and coordination, built on [Solid](https://solidjs.com). An app's state is one tree of plain data, its work runs as actions on the tree's entities, and views read the tree and dispatch actions.

## What it looks like

An object in the tree with an `$Id` is an **entity**. An action is a generator function that writes the entity it runs on, its draft, and calls effects with `yield*`:

```ts
import { createRuntime, generateGuid, type IActionGenerator, type IEntity } from "treflex";

interface ITodoList extends IEntity {
    Todos: { Id: string; Text: string; Done: boolean }[];
    Draft: string;
}

function* add(draft: ITodoList): IActionGenerator {
    const text = draft.Draft.trim();
    if (!text) return;
    draft.Draft = "";
    draft.Todos.push({ Id: yield* generateGuid(), Text: text, Done: false });
}

const runtime = createRuntime<ITodoList>({ $Id: "TodoList", Todos: [], Draft: "Buy milk" });
await runtime.dispatch(add, "TodoList");
```

`yield*` is where an `async` function would `await`, and the runtime resumes the action after every yield. That lets it hand each effect to an implementation, which a test can stub, stop an action when its entity leaves the tree, and record every step.

[`demos/todo`](./demos/todo/) is a runnable version of this feature, with a view. The [guide](./docs/guide/01-entities.md) builds a larger app a step per page.

## What a restore brings back

`createSnapshot(runtime)`, from `treflex/snapshot`, writes a running app to one JSON string without pausing it, and `restoreRuntime`, from the same entry, builds a new runtime from that string. The state tree comes back, with each entity's receiver binding, and so do the data sources, the timers, each armed for the time it was next due, and the resources, which reopen from their rows.

Running work doesn't come back: a restored runtime has no action running and no ask open. Transients and component state aren't saved. [Restart and records](./docs/reference/restart-and-records.md) has the full contract.

## Documentation

[`docs/README.md`](./docs/README.md) maps the docs:

- [The guide](./docs/guide/01-entities.md) builds one small app, a feed reader, a step per page. Start here.
- [Patterns](./docs/patterns.md) collects the shapes that cross concepts.
- [The reference](./docs/README.md#reference) states every rule, one page per concept, with symptoms and every diag code in [troubleshooting](./docs/reference/troubleshooting.md).
- [The principles](./docs/design/principles.md) are what treflex is built on, and why.

The docs assume working familiarity with Solid. A React app renders through `treflex-react` ([React](./docs/reference/views.md#react)).

## Examples

The live demo is at **[tgoh.github.io/treflex](https://tgoh.github.io/treflex/)**: a trip planner, an aquarium and a team chat that keep running while their views are unmounted, and come back after a reload.

- [`demos/todo/`](./demos/todo/) is one entity in one file, for the syntax: `npm run demo:todo`.
- [`demos/portal/`](./demos/portal/) is the live demo's source, whose README maps each capability onto its files: `npm run demo:portal`.
- [`demos/react-todo/`](./demos/react-todo/) and [`demos/react-portal/`](./demos/react-portal/) are the same apps in React. The live demo's session card switches between its two builds.

## Installing

```bash
npm install treflex treflex-solid solid-js
```

A React app installs `treflex-react` and `react` in place of `treflex-solid`, and keeps `solid-js`, because the runtime runs on Solid's reactivity. The lint rules are in `treflex-eslint`, registered as [its README](./packages/eslint/README.md#registering-it) says.

| Package | Imports | Holds |
| --- | --- | --- |
| `treflex` | `treflex`, `treflex/snapshot` | The runtime, effects and types; snapshots and restore |
| `treflex-solid` | `treflex-solid` | The Solid bindings |
| `treflex-react` | `treflex-react` | The React bindings |
| `treflex-eslint` | `treflex-eslint` | The eslint rules |

Each package is an ES module of ES2022 JavaScript with type declarations. `packages/*/src` is the source of truth for every contract the docs describe.

**TypeScript 5.4 or later** reads the declarations, which use `NoInfer`. TypeScript 6 resolves them with `"moduleResolution"` unset; TypeScript 5 needs `"moduleResolution"` set to `"bundler"` or `"nodenext"`, because its default for `"module": "esnext"` doesn't resolve a package through its `exports`. The declarations name platform types such as `AbortSignal`, so `"lib"` includes `DOM` or the project installs `@types/node`. Turn `strict` on, or at least `strictFunctionTypes`: the id brands' invariance rests on it.

`solid-js` resolves to its browser build, which a Vite app does by default; a test runner or a plain Node process sets the conditions [the Solid build](./docs/reference/runtime.md#the-solid-build) names. Whether the packages run as a [development build](./docs/reference/runtime.md#options) is read when they load, so the app's bundler decides it.

**Emitted output must be ES2018 or later**, set by `build.target` under Vite and by `target` under esbuild or `tsc`. Below it, an async generator reads as a plain object, so a check that refuses one, such as `reconcileRows`' on an async `update`, lets it through without an error.

The **platform baseline is `AbortSignal.any`**: Chrome 116, Firefox 124, Safari 17.4, Node 20.3. `treflex-eslint` and this repository's tooling run on Node 22 or later, the lines CI tests, which their `package.json` files record as `engines`.

## Development

[`CONTRIBUTING.md`](./CONTRIBUTING.md#building-and-testing) lists the commands that build and test this repository.
