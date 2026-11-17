# The runtime

`createRuntime(initialState, options?)` returns an `IRuntime<T>`: the handle that owns the state tree, runs actions, holds what was registered, and carries the record stream. Each runtime is isolated, with its own state, registrations, services, record stream and ids, so use one per logical context: one per page, one per test.

## Usage

The guide boots a runtime in [1. An entity and its state](../guide/01-entities.md) and renders it in [3. Views](../guide/03-views.md).

### Constructing

```ts
import { createRuntime, type IActionGenerator, type IEntity } from "treflex";

interface IPlatform extends IEntity {
    Ready: boolean;
}

function* init(draft: IPlatform): IActionGenerator {
    draft.Ready = true;
}

export async function start(): Promise<void> {
    const runtime = createRuntime<IPlatform>({ $Id: "Platform", Ready: false }, {
        onError: (error) => console.error("Action failed:", error)
    });
    runtime.registerReceiver(PlatformReceiver);
    await runtime.dispatch(init, "Platform");
}
```

**The initial state** is a plain object, the root of `AppState`, copied and checked as a seed ([`state-tree.md`](./state-tree.md#rules-on-an-id)). Give it a `$Id`: only an entity takes a dispatch, and a root without one can't. It is complete at construction, so setup that needs effects is an `init` action the boot dispatches.

**The boot order** is: construct; register implementations, receivers, resource types, services and taps; dispatch the root's `init`; then steady state. A restore follows the same order with the snapshot in place of `init` ([`restart-and-records.md`](./restart-and-records.md#restoring)).

### Runtime services

`runtime.set(key, value)` stores a value at startup, and an effect implementation reads it during dispatch with `action.get(key)` on its `IActionContext` ([`effects.md`](./effects.md#the-action-context)). Keys are typed through `IRuntimeServiceRegistry`.

```ts
declare module "treflex" {
    interface IRuntimeServiceRegistry {
        "app/fetchCache": Map<string, unknown>;
    }
}

export function registerServices(runtime: IRuntime<object>): void {
    runtime.set("app/fetchCache", new Map());
}
```

**Who reads it decides where it goes.** What actions, selectors or receivers read belongs in the tree, as state or a [data source](./lookup.md), or in a transient. What only effect implementations read belongs here: caches, in-flight trackers, loader maps, telemetry buffers. Services are never saved, so registration rebuilds them at every boot.

## Rules

### The Solid build

Construction throws `SolidServerBuildError`, in every build, when `solid-js` resolved to its server build, where a memo never re-runs and every selector would keep its first value. Resolve `solid-js` with the `solid` and `browser` conditions: `resolve.conditions: ["solid", "browser"]` in a Vite or vitest config, with `ssr.resolve.conditions` too under vitest, or `node --conditions=browser` for a plain Node process.

### Options

| Option | |
|---|---|
| `onError` | An `IErrorHandler`, `(error: unknown, context: IErrorContext) => void`: takes a failure no error boundary took ([`failure.md`](./failure.md#onerror)) |
| `activityLog` | `true` or `{ cap }`: registers the activity log, 200 entries by default ([`lookup.md`](./lookup.md#the-activity-log)). Off by default |
| `verifyIndex` | The index consistency walk, which checks the `$Id` index against a fresh walk of the tree and throws when a write bypassed the write path. `true` or `"always"` walks on every reconciliation, `false` or `"off"` never, `"budgeted"` at an interval scaled by tree size. Omitted, it is `"budgeted"` in a development build and `"off"` otherwise, and the `TREFLEX_VERIFY_INDEX` environment variable (`always`, `budgeted` or `off`) overrides that default |
| `implementations` | Effect implementations by `Type`, registered at construction. Entries are untyped, and a runtime operation's or a read's name throws |
| `pauseTimers` | `true`: timer rows record and nothing ticks, for good ([`live-sources.md`](./live-sources.md#timers)) |
| `pauseResources` | `true` pauses the resource manager for good ([`live-sources.md`](./live-sources.md#restore-and-tests)) |

A **development build** is one where `import.meta.env.DEV` is true, or, where that isn't defined, `process.env.NODE_ENV` isn't `"production"`, or, where neither is, always. Several diagnostics run only there ([`troubleshooting.md`](./troubleshooting.md)).

### IRuntime

| Member | |
|---|---|
| `state` | The `AppState` root as a reactive, read-only view. A write through it throws ([`write-path.md`](./write-path.md#who-can-write)) |
| `dispatch(action, target, ...args)` | Runs an action on an entity in any root ([below](#dispatch)) |
| `locate(node)` | Where a node of this tree stands, as the entity a dispatch reaches it through and the path from there ([`views.md`](./views.md#a-form-over-part-of-an-entity)) |
| `processSelector(selector, getState, accessor?)` | Runs a selector, itself unmemoized, for code outside the views: `runtime.processSelector(total, () => runtime.state)` |
| `processAction(action, getState, setState, idAccessor, ...args)` | The general dispatcher over a state slice and an owning id. Applications use `dispatch` |
| `registerImplementation(tag)`, `registerImplementation(type, fn)` | Sets the implementation of an effect type ([`effects.md`](./effects.md#implementations)). One per type: registering again replaces it, with a console warning. A runtime operation's or a read's name throws |
| `registerReceiver(receiver)` | Registers a receiver whole ([`messaging.md`](./messaging.md#receivers)) |
| `registerResourceType(type, implementation, options?)` | Registers a resource type; registering again replaces its instances ([`live-sources.md`](./live-sources.md#implementing-a-type)) |
| `resources(owner?)`, `timers(owner?)` | Copies of the resource or timer rows, every one or one owner's |
| `supplyResource(owner, key, value)` | What `useResource`'s `supply` does, from outside a view |
| `registerExternalSource(source)` | Registers an [external source](./lookup.md#external-sources) |
| `set(key, value)` | Stores a runtime service ([above](#runtime-services)) |
| `on(event, handler, options?)` | `"record"` taps the record stream, with `{ kinds }` to narrow it ([`restart-and-records.md`](./restart-and-records.md#the-tap)); `"diag"` hears [diagnostics](./troubleshooting.md); `"failure"` hears [caught throws](./failure.md#the-failure-event). Returns the function that unsubscribes |
| `dispose()` | Stops the timers and resources, disposes the external sources, then runs the dispose cascade over every entity in all three roots: running actions stop, asks end, rows and registrations go |

Nothing registered can be unregistered: registering again replaces, or for an external source is ignored. For fresh registrations, construct a new runtime. Snapshot and restore are not on the runtime: they come from `treflex/snapshot`, and a restored runtime is a new one. The views reach the runtime through `TreflexProvider` ([`views.md`](./views.md#treflexprovider)).

### dispatch

`runtime.dispatch(action, target, ...args)` runs `action` on the entity `target` names, in any of the three roots, and returns its promise, `Promise<R | undefined>`, which settles as [`actions.md`](./actions.md#a-dispatchs-result) lists. The target is the entity's `$Id`, or its live node in this tree: a view, or the raw node. Arguments cross as frozen copies ([`write-path.md`](./write-path.md#what-crosses-into-an-action)). Dispatch never subscribes the calling reactive scope to anything it reads.

What it refuses, each a rejected promise, never a synchronous throw, and before the action starts:

- **A target that isn't an entity**, a non-object or an object with no `$Id`: `TypeError`. For part of an entity, dispatch on the entity and pass where `locate(node)` puts the part as an argument.
- **An `$Id` the tree doesn't hold**, unknown, removed, or a root's that has none: `EntityGoneError`, and [`dispatch/unresolved-entity`](./troubleshooting.md#dispatchunresolved-entity).
- **A node that isn't the one the tree holds under its `$Id`**: an `Error`, and [`dispatch/node-mismatch`](./troubleshooting.md#dispatchnode-mismatch). It is a node that has left the tree, or a copy, an action's returned value, or another runtime's node. Pass `.$Id` for those.

A component dispatches through its feature, or `useDispatch()` for an entity it has no feature for.

### Service keys

A key nothing set throws at the read, naming the key. `set` takes the value itself, not a factory, and `IActionContext` has no `set`, so an implementation can't paper over a missing registration.

**The `runtime/` prefix is reserved.** treflex keeps its own stores under it: `runtime/diag`, `runtime/journal`, `runtime/effects`, `runtime/bindings`, `runtime/receivers`, `runtime/dataSources`, `runtime/timers`, `runtime/timerSchedule`, `runtime/resourceTable`, `runtime/resources`, `runtime/resolveOwner`, `runtime/asks`, `runtime/inFlightStub`, `runtime/inFlightActions`, `runtime/stateIdLookup`, `runtime/externalSources` and `runtime/writeGateway`. Their shapes are internal. Namespace application keys with a prefix of your own.

## Caveats

- **Awaiting the `init` dispatch before the first render** holds the first paint until `init` ends; to show a spinner instead, render first, or have `init` `start` the load.
- **A `worker` condition picks Solid's server build** even beside `browser`.
- **An `implementations` entry for `generateGuid`** replaces the built-in without the overwrite warning.
- **A refused dispatch's rejection recurs on every call;** the diag doesn't ([`troubleshooting.md`](./troubleshooting.md#dispatchunresolved-entity)). Handle the promise, not the diag.
- **`set` doesn't refuse `runtime/` keys,** and writing one replaces the runtime's own store, so don't.
