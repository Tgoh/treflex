# Todo

The smallest complete treflex feature: one entity, three actions, a selector, a
component, and the runtime that holds them, all in
[`src/index.tsx`](./src/index.tsx).

```bash
npm install     # optional: the repo root's install serves the demos via workspaces
npm run dev
```

It is a package only so that it runs and gets typechecked. The
[guide](../../docs/guide/01-entities.md) builds a larger app step by step. Two
things here it doesn't use: `generateGuid` for a plain row's id
([effects](../../docs/reference/effects.md#non-determinism)), and
`import.meta.url` as the feature's id
([views](../../docs/reference/views.md#hot-reload-and-the-id)).

At this size the framework is all cost and no benefit. The `$Id`, the generator
syntax and the entity feature are all visible, and none of the capabilities
they pay for have anything to do yet. That is the honest starting point.
[`demos/portal`](../portal/) is where they start earning their keep.
