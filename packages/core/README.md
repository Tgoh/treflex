# treflex

Treflex is a runtime for front-end application state and the work that runs on it: requests, timers, live connections and multi-step flows. The work lives in the state tree rather than in components, so it runs whether or not a view shows it, actions on one entity take turns, and the app survives a reload. It works with Solid or React, and runs on [Solid](https://solidjs.com)'s reactivity.

**[See it running](https://tgoh.github.io/treflex/)**, and read [why use it](../../README.md#why-use-it).

```
npm create treflex@latest my-app     # a new app, in React or Solid
npm install treflex                  # an existing app
```

The package has two entries:

- `treflex`: the runtime, effects, and the types an app declares against.
- `treflex/snapshot`: `createSnapshot` and `restoreRuntime`, for saving a running app and building a runtime from the save.

Views render through [`treflex-solid`](../solid/README.md) or [`treflex-react`](../react/README.md). `biome/` holds two Biome plugins for treflex code, set up as [lint setup](../../docs/reference/effects.md#lint-setup) says.

The [guide](../../docs/guide/01-entities.md) builds a first app a step per page, and the [docs index](../../docs/README.md) maps the rest. [Requirements](../../docs/requirements.md) lists what a consumer's build needs.
