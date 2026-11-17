# Lookup

A **data source** lets one entity hand a value to every entity below it, with no import, prop or provider. A registration has an **owner**, the entity that scopes it, a typed **key**, and a **data** entity whose state readers get. `getData(from, key)` walks up from `from` and answers with the nearest owner's data. Resolution walks the state tree, not the render tree, so where a component renders changes nothing.

To tell other entities that something happened, publish a message instead ([`messaging.md`](./messaging.md)).

## Usage

### Keys

A key is declared in `IDataSourceRegistry`, mapped to the state shape readers get:

```ts
import type { IEntity } from "treflex";

export interface ITheme extends IEntity {
    PrimaryHue: number;
}

declare module "treflex" {
    interface IDataSourceRegistry {
        Theme: ITheme;
    }
}
```

`ActivityLog` is declared by treflex for [the activity log](#the-activity-log).

### Registering

`registerDataSource` and `unregisterDataSource` are yielded from an action:

```ts
import { type IActionGenerator, type IEntity, registerDataSource, unregisterDataSource } from "treflex";

interface IPlatform extends IEntity {
    Theme: ITheme;
}

export function* init(draft: IPlatform): IActionGenerator {
    yield* registerDataSource(draft, "Theme", draft.Theme);    // the platform owns it, its Theme child is the data
}

export function* registerSelf(draft: ITheme): IActionGenerator {
    yield* registerDataSource(draft, "Theme");                 // owner and data are the entity itself
}

export function* stopServing(draft: IPlatform): IActionGenerator {
    yield* unregisterDataSource(draft, "Theme");
}
```

- **The owner decides who sees it, and its lifetime.** The registration goes when the owner leaves the tree. Register from the draft the action was given or an entity under it.
- **The data is held by `$Id` and read at each read.** While no entity has that `$Id`, readers get `undefined`. When one is added again, readers get it again with no re-registration.

### Reading

`getData` and `getDataGlobal` are reads, yielded from an action or a selector ([`derived-reads.md`](./derived-reads.md#the-reads)):

```ts
import { getData, getDataGlobal, type ISelectorGenerator } from "treflex";

interface IAppWindow extends IEntity {
    Title: string;
}

export function* hue(draft: IAppWindow): ISelectorGenerator<number> {
    const theme = yield* getData(draft, "Theme");
    return theme?.PrimaryHue ?? 0;
}

export function* rootHue(_draft: IAppWindow): ISelectorGenerator<number> {
    const theme = yield* getDataGlobal("Theme");
    return theme?.PrimaryHue ?? 0;
}
```

**`getData(from, key)`** walks `from`'s path from `from` itself up to the root, and answers with the data of the first owner it meets, so a self-registration answers before any ancestor's. It never looks at a sibling branch.

**Reach for `getData` first.** While a key has one registration both answer the same, so a global read that should have been scoped looks correct until a second owner appears, and then answers with the wrong owner's data rather than failing.

### When not to use a data source

- **One feature's own value** stays on that feature's state.
- **Infrastructure only effect implementations read**, a cache or a loader map, is a runtime service ([`runtime.md`](./runtime.md#runtime-services)).
- **News that something happened** is a message ([`messaging.md`](./messaging.md)), not a value someone polls.

## Rules

### Registrations

- **An owner holds a key once.** Different owners registering one key at different depths is how per-instance values work: each reader gets the nearest one on its own lineage.
- `unregisterDataSource(owner, key)` removes one registration while the owner stays.

Registrations are saved in a snapshot when the owner is in `AppState` ([`restart-and-records.md`](./restart-and-records.md#snapshots)), and each change lands a `table` record with `Table: "dataSources"`.

### What a read answers

`getData`'s `from` is an entity whose `$Id` the tree holds: the draft, an entity under it, or a copy carrying such an `$Id`.

**`getDataGlobal(key)`** answers with the owner nearest the root, the shortest path. When no owner in the tree serves the key, `getDataGlobal` asks the [external sources](#external-sources). `getData` never does.

What a read returns:

- **In a selector**, the data entity's live state, read-only, and the selector re-runs when the nearest owner changes or the data changes. No callback or notification code is needed.
- **In an action**, a frozen copy of it, as every read in an action is ([`derived-reads.md`](./derived-reads.md#reads-in-an-action)).

### getDataPath

`getDataPath(from, key)` runs `getData`'s walk and answers `{ value, ancestors }`: the value, and the `$Id`s walked, nearest first, up to and including the owner that answered. A miss answers `value: undefined` and the whole walk. It is for devtools and audit views; application logic uses `getData`, so it stays independent of where the registration sits. It has no memo of its own, and runs inside the calling selector's.

### External sources

An **external source** is a participant outside the state tree, registered with `runtime.registerExternalSource(source)`, usually at startup. It answers `getDataGlobal` for the keys it declares and receives the `publish` topics it declares. It has no path, so `getData`, `publishToNearest` and the dispose cascade never reach it.

```ts
interface IExternalSource {
    readonly Id: string;
    readonly DataSourceKeys?: readonly string[];
    readonly Topics?: readonly string[];
    getData?(key: string): unknown;
    receivePublish?(data: Record<string, unknown>, ctx: IMessageContext): void | Promise<void>;
    dispose?(): void;
}
```

- **What it serves is fixed at registration.** There is no unregistration.
- **`getData` reads through a reactive store** (`createStore` from `solid-js/store`), so the memo of a reader tracks it.
- **`receivePublish`** is called during the publishing action's `publish` yield, before any entity receiver starts. A source that declares a topic and has no `receivePublish` raises [`receiver/unresolved`](./troubleshooting.md#receiverunresolved).
- **It never initiates.** Something that pushes events of its own into state, a socket or a worker, is a [resource](./live-sources.md).
- `runtime.dispose()` calls each source's `dispose` in registration order. A throw from it is a [`runtime/callback-threw`](./troubleshooting.md#runtimecallback-threw) diag.

#### The activity log

`createRuntime(state, { activityLog: true })`, or `{ activityLog: { cap: N } }`, registers a source with `Id` `"treflex/ActivityLog"` serving the key `"ActivityLog"`, read with `getDataGlobal("ActivityLog")` (`getData` doesn't accept the key). It keeps the latest records, 200 by default, of the kinds `action:start`, `action:end`, `branch:start`, `branch:end`, `entity:dispose` and `message:deliver`:

```ts
import type { IActivityLogEntry } from "treflex";

export function* recentEnds(_draft: IAppWindow): ISelectorGenerator<readonly IActivityLogEntry[]> {
    const log = yield* getDataGlobal("ActivityLog");
    return log ? log.Entries.filter((entry) => entry.Kind === "action:end") : [];
}
```

`Entries` is newest first. Each entry is `{ Seq, Kind, Time, Data }`: `Seq` is the log's own count, `Time` is `Date.now()` at capture, and `Data` is the record. A `branch:end` is kept without its `Error`, and the tap extras are never kept. It taps only those kinds, so on its own it turns on no `step`, `effect` or `response` records and copies no writes ([`restart-and-records.md`](./restart-and-records.md#what-a-kind-costs)).

## Caveats

- **An owner whose `$Id` the tree doesn't hold** is registered anyway, with a console warning, and nothing ever removes it. Register from the draft or an entity under it.
- **Registering the same key on the same owner again** replaces the data, with a console warning.
- **A `getData` from anything but an entity the tree holds** answers `undefined` with a console warning, whether or not the key has a registration.
- **Between owners at equal depth,** `getDataGlobal`'s winner is the first in the registration table's key order: integer-like `$Id`s first, ascending, then the rest in registration order. A key whose owners can sit at equal depth wants `getData`.
- **A copy of more than 10,000 objects and arrays** in an action raises [`action/large-read-copy`](./troubleshooting.md#actionlarge-read-copy) in a development build.
- **Cost.** Each `(key, from)` pair is memoized, and its memo re-runs only when a registration on its walk or the data changes. A scoped memo is freed with its `from` entity. A `getDataGlobal` memo is one per key and lives until the runtime is disposed.
- **An external source's second registration:** a second source with a registered `Id` is ignored with a console warning, and so is a key another source already serves: the first wins.
- **An external source answering from a plain object** never re-runs its readers. Answer from a `createStore` store.
- **An external source's `receivePublish` throw or rejection** lands a `receiver:error` record and nothing else: it takes no failure route and fires no `failure` event. Catch and report inside it.
