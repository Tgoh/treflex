# treflex

Treflex is a runtime for application state and coordination, built on [Solid](https://solidjs.com). An app's state is one tree of plain data, its work runs as actions on the tree's entities, and views read the tree and dispatch actions.

```
npm install treflex solid-js
```

The package has two entries:

- `treflex`: the runtime, effects, and the types an app declares against.
- `treflex/snapshot`: `createSnapshot` and `restoreRuntime`, for saving a running app and building a runtime from the save.

Views render through [`treflex-solid`](../solid/README.md) or [`treflex-react`](../react/README.md). `biome/` holds two Biome plugins for treflex code, set up as [lint setup](../../docs/reference/effects.md#lint-setup) says.

The [guide](../../docs/guide/01-entities.md) builds a first app a step per page, and the [docs index](../../docs/README.md) maps the rest. [The repository README](../../README.md#installing) lists what a consumer's build needs.
