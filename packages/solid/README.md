# treflex-solid

The Solid bindings for [treflex](../core/README.md): `TreflexProvider`, features, and the hooks a view reads the runtime through.

```
npm install treflex treflex-solid solid-js @solidjs/web
```

treflex-solid runs on Solid 2 ([its peer range](../../docs/requirements.md#react-and-solid)), and the app's components and treflex-solid must load one copy of `solid-js` between them ([one copy of solid-js](../../docs/reference/views.md#one-copy-of-solid-js)). Importing treflex-solid is what lets Solid views hear the runtime's writes: a Solid app that reads `runtime.state` without it never updates.

[Views](../../docs/guide/03-views.md) in the guide builds the first view, and the [views reference](../../docs/reference/views.md) holds every rule.
