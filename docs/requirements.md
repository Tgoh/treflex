# Requirements

What an app needs to use treflex: the packages, the TypeScript and React versions, the build setup, and the platforms it runs on. An app made by `npm create treflex@latest` ([the quickstart](./quickstart.md)) meets all of it.

## Packages

| Package | Imports | Holds |
| --- | --- | --- |
| `treflex` | `treflex`, `treflex/snapshot`, `treflex/vitest` | The runtime, effects and types; snapshots and restore; the Vitest setup entry, for `vitest` 3.0 or later, an optional peer |
| `treflex-solid` | `treflex-solid` | The Solid bindings |
| `treflex-react` | `treflex-react` | The React bindings |
| `treflex-eslint` | `treflex-eslint` | The eslint rules, registered as [its README](../packages/eslint/README.md#registering-it) says |
| `create-treflex` | Run as `npm create treflex@latest` | A new app in React or Solid, from [a template](../packages/create-treflex/README.md) |

`treflex`, the bindings and `treflex-eslint` are ES modules of ES2022 JavaScript with type declarations. `packages/*/src` is the source of truth for every contract the docs describe. All five share one version.

## TypeScript

**TypeScript 5.4 through 7** reads the declarations, which use `NoInfer`. TypeScript 6 and 7 resolve them with `"moduleResolution"` unset; TypeScript 5 needs `"moduleResolution"` set to `"bundler"` or `"nodenext"`, because its default for `"module": "esnext"` doesn't resolve a package through its `exports`. A Solid app on TypeScript before 5.7 needs `skipLibCheck`, which Vite's templates set, because `@solidjs/web`'s types use a DOM type that 5.4's lib lacks and a generic `Uint8Array` that TypeScript before 5.7 lacks; treflex's own declarations check on 5.4 without it. The declarations name platform types such as `AbortSignal`, so `"lib"` includes `DOM`, or the project installs `@types/node` and lists `"node"` in `"types"`. TypeScript 6 and 7 load no `@types` package that `"types"` doesn't name.

**Turn `strict` on,** or at least `strictFunctionTypes`: the id brands' invariance rests on it. TypeScript 6 and 7 turn it on by default; 5 doesn't.

**The lint plugin needs TypeScript 6 or earlier,** because typescript-eslint doesn't run on 7; [its README](../packages/eslint/README.md#registering-it) has the range.

## React and Solid

The React versions `treflex-react` runs on are in [React](./reference/views.md#react).

`treflex-solid` runs on Solid 2: it peers `solid-js` and `@solidjs/web` `^2.0.3`. A Solid app compiles its JSX with `@solidjs/vite-plugin` and sets `"jsxImportSource"` to `"@solidjs/web"`, and its components run on the copy of `solid-js` that `treflex-solid` imports ([one copy of solid-js](./reference/views.md#one-copy-of-solid-js)). A React app installs no Solid package.

`@solidjs/web` resolves to its browser build, which a Vite app does by default; a component test under Vitest's `"node"` environment adds the `"browser"` condition ([testing a Solid component](./reference/testing.md#testing-a-solid-component)). Whether the packages run as a [development build](./reference/runtime.md#options) is read when they load, so the app's bundler decides it.

## Build output

**Emitted output must be ES2018 or later**, set by `build.target` under Vite and by `target` under esbuild or `tsc`. Below it, an async generator reads as a plain object, so a check that refuses one, such as `reconcileRows`' on an async `update`, lets it through without an error.

## Platforms

The **platform baseline is `AbortSignal.any`**: Chrome 116, Firefox 124, Safari 17.4, and Node 22 or later, the lines CI tests. `treflex-eslint` and `create-treflex` record Node 22.13 as `engines`. A Solid app's build and tests need Node 22.12 or later, the floor `solid-js` and `@solidjs/vite-plugin` declare. An app `create-treflex` makes needs Node 22.13 or later on the 22 line, or Node 24 or later, the floor its ESLint and jsdom declare. What building this repository needs is in [`CONTRIBUTING.md`](../CONTRIBUTING.md#building-and-testing).
