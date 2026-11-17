# Troubleshooting

What goes wrong in treflex apps, by symptom, and then every code the runtime reports.

## Symptoms

- **A hang: an action never ends, or a dispatch, receiver, tick or error boundary runs long after it should.** The work is queued behind a hold. Either the holder waits on work that needs its own entity or one above it, which never ends, or a long wait holds when it should let others in. `action/long-hold` names the holder, what it waits on and what is queued ([below](#actionlong-hold)). Make the wait point down, put it inside `open(...)`, or move the queued work onto a child entity ([waits point down](./actions.md#waits-point-down)). A dialog nobody can answer is the same shape ([a stuck dialog](./conversations.md#what-ends-an-ask)).
- **A button stays live while its click is queued, or a repeat runs twice.** It is bound to a flag the action sets in its first step, and the click queued behind another hold, so the flag isn't set yet; a guard on the flag doesn't stop a repeat, which runs after the first has cleared it. Disable from `useInFlight`, which counts queued work, and mark the action `leading` to drop a repeat ([busy state](./views.md#busy-state), [arrival marks](./actions.md#arrival-marks)).
- **An action finds its entity's fields changed after a wait it didn't open.** An action on an entity above it wrote into the entity while this one held it; in development that reports `entity/written-while-held` ([below](#entitywritten-while-held)). Send the write to the entity as work, `yield* start(applyEvent, doc, event)` ([writing into a child entity](./actions.md#writing-into-a-child-entity)).
- **A blank page at load, while tests and typecheck pass.** An import cycle reads an export before the export exists, such as a `const save = leading(function* ...)` reached before its line runs. Vitest's module loader answers `undefined` for that read instead of throwing, so only a built bundle shows it. Keep one test that loads the production bundle ([check the app loads](./testing.md#check-the-app-loads)), and mark actions with a statement after a declaration ([marking a function](./actions.md#marking-a-function)).
- **A failure is reported twice.** The app logs from the `failure` event and has no `onError`, so every failure nothing else takes is reported by the logger and again as an unhandled rejection. Keep `onError: () => {}` beside the logger ([`onError`](./failure.md#onerror)).
- **A receiver case doesn't fire.** The receiver isn't registered, the entity isn't bound to it, the binding landed after the publish, a `publishToNearest` went to the wrong entities, or a test asserted before the receiver ran. Work through [when a receiver doesn't fire](./messaging.md#when-a-receiver-doesnt-fire).
- **`inFlight` doesn't count a receiver's work.** A delivery counts as its matched case. A case that calls the action with `yield*` counts as itself, not as the action: write the case bare, `"Content/Saved": refresh`, so it counts as `refresh` and as `refresh`'s work tags. Work on a child entity doesn't count for its parent ([what `inFlight` counts](./actions.md#what-inflight-counts)).

## Diags

A **diag** is the runtime telling you something about itself: a rule it refused, a mistake it caught, a cost it noticed. Each one goes to the console, `console.warn` or `console.info` by severity, and to `runtime.on("diag", handler)` as `{ severity, code, message, data? }`. `code` is the stable name a tool matches on; `message` is for people and may change.

```ts
import type { IRuntime } from "treflex";

export function forwardDiags(runtime: IRuntime<object>, send: (code: string, data: unknown) => void): () => void {
    return runtime.on("diag", (event) => {
        if (event.severity === "warn") send(event.code, event.data);
    });
}
```

- A diag subscriber's own throw goes to the console only.
- The diags of a restore's table load are held until `setup` has run, so a listener `setup` attaches hears them ([`restart-and-records.md`](./restart-and-records.md#restoring)).
- [`state/view-write`](#stateview-write) comes from a view, which carries no runtime, so every live runtime's listeners hear it.
- "Once per" below means once for the runtime's life, unless an entry says what clears it.
- A development build is defined in [`runtime.md`](./runtime.md#options).

What an action throws is not a diag: it is a failure, heard through the `failure` event ([`failure.md`](./failure.md)).

## Every code

| Code | Severity | Builds | About |
|---|---|---|---|
| [`action/large-read-copy`](#actionlarge-read-copy) | warn | development | [Reads](./derived-reads.md#reads-in-an-action) |
| [`action/long-hold`](#actionlong-hold) | warn | all | [Holds](./actions.md#a-long-hold-warns) |
| [`action/refusal-loop`](#actionrefusal-loop) | warn | all | [The tree rule](./state-tree.md#the-tree-rule) |
| [`action/refusal-swallowed`](#actionrefusal-swallowed) | warn | development | [Refusals](./failure.md#refusals) |
| [`action/unrouted-throw`](#actionunrouted-throw) | warn | all | [Failure](./failure.md#a-stopped-actions-failure) |
| [`cancel/finally-yield`](#cancelfinally-yield) | warn | all | [The close](./fibers.md#the-close) |
| [`cancel/finally-yield-limit`](#cancelfinally-yield-limit) | warn | all | [The close](./fibers.md#the-close) |
| [`dispatch/node-mismatch`](#dispatchnode-mismatch) | warn | all | [Dispatch](./runtime.md#dispatch) |
| [`dispatch/unresolved-entity`](#dispatchunresolved-entity) | warn | all | [Dispatch](./runtime.md#dispatch), [`start`](./actions.md#start) |
| [`effect/sync-promise-rejected`](#effectsync-promise-rejected) | warn | all | [Sync effects](./effects.md#sync-effects) |
| [`effect/sync-returned-promise`](#effectsync-returned-promise) | warn | all | [Sync effects](./effects.md#sync-effects) |
| [`entity/replaced-by-plain-data`](#entityreplaced-by-plain-data) | warn | all | [The write path](./write-path.md#refreshing-rows) |
| [`entity/written-while-held`](#entitywritten-while-held) | info | development | [Holds](./actions.md#writing-into-a-child-entity) |
| [`receiver/id-collision`](#receiverid-collision) | warn | production | [Receivers](./messaging.md#receivers) |
| [`receiver/unresolved`](#receiverunresolved) | warn | all | [Messaging](./messaging.md#a-receiver-that-isnt-registered) |
| [`resource/ended`](#resourceended) | warn | all | [Resources](./live-sources.md#ending) |
| [`resource/invalid-message`](#resourceinvalid-message) | warn | all | [Emit](./live-sources.md#emit) |
| [`resource/not-open`](#resourcenot-open) | warn | all | [Methods](./live-sources.md#methods) |
| [`resource/queue-depth`](#resourcequeue-depth) | warn | all | [Emit](./live-sources.md#emit) |
| [`resource/receiver-waiting`](#resourcereceiver-waiting) | warn | all | [Emit](./live-sources.md#emit) |
| [`resource/still-paused`](#resourcestill-paused) | warn | all | [The repair](./restart-and-records.md#the-repair) |
| [`resource/supply-dropped`](#resourcesupply-dropped) | warn | all | [Supply](./live-sources.md#supply-and-expose) |
| [`resource/unknown-method`](#resourceunknown-method) | warn | all | [Methods](./live-sources.md#methods) |
| [`resource/unregistered-type`](#resourceunregistered-type) | warn | all | [Opening](./live-sources.md#opening) |
| [`resource/used-after-end`](#resourceused-after-end) | warn | all | [Methods](./live-sources.md#methods) |
| [`restore/malformed-rows`](#restoremalformed-rows) | warn | all | [Restoring](./restart-and-records.md#restoring) |
| [`restore/orphaned-rows`](#restoreorphaned-rows) | info | all | [Restoring](./restart-and-records.md#restoring) |
| [`restore/unresolved-receiver`](#restoreunresolved-receiver) | warn | all | [Restoring](./restart-and-records.md#restoring) |
| [`runtime/callback-threw`](#runtimecallback-threw) | warn | all | [Failure](./failure.md#the-failure-event) |
| [`selector/many-tracked-reads`](#selectormany-tracked-reads) | warn | development | [Selectors](./derived-reads.md#memos) |
| [`state/outside-action-write`](#stateoutside-action-write) | warn | all | [The write path](./write-path.md#who-can-write) |
| [`state/view-write`](#stateview-write) | warn | all | [The write path](./write-path.md#who-can-write) |

## Actions

### `action/large-read-copy`

One read in an action copied more than 10,000 objects and arrays out of state. A read in an action is a frozen copy of everything it returns; a `transient` and `pendingAsks` are exempt. Once per action name. Data: `{ actionName, type, copied }`, `type` being the read. **Do:** read only what the action needs, with a narrow `select`.

### `action/long-hold`

An action holding its entity has had work queued behind it for over a second, counted from when work first queued behind this hold, or from the hold's start if work was already waiting when it began. Checked every second while that lasts, and reported once per hold for each set of effect types the holder is found waiting on, so a loop around one wait reports once; a new hold reports afresh. Data: `{ entityId, holder, holderId, waitingOn, queued }`, the queued work by name. **Do:** if other work should run during the wait, write `yield* open(...)` around it; if the queued work belongs to a part with a life of its own, make that part a child entity; if the wait is on work queued behind the holder's own hold, it never ends, since waits point down ([`actions.md`](./actions.md#waits-point-down)).

The symptom: a dispatch, a receiver, a timer tick or an error boundary's delivery runs later than expected, after another action on the same entity finished.

### `action/refusal-loop`

An action was refused 100 times running at its yields for writes that broke the tree rule, each step undone and the refusal thrown back in, with no step passing between, so the next refusal ended the action. Data: `{ actionName, branchId, error }`, the refusal serialized. **Do:** a `catch` around a yield that retries the same writes meets the same refusal: rethrow it, or change the writes.

### `action/refusal-swallowed`

An action caught a refusal its own code was refused with, and ended without rethrowing it, so the broken rule went unheard. Judged when the action and all its branches have ended. Once per action run. Data: `{ actionName, actionId, entityId, refusal, count }`: the first refusal serialized, and how many there were. **Do:** `if (isRefusal(error)) throw error;` in a `catch` that can meet one ([`failure.md`](./failure.md#refusals)).

### `action/unrouted-throw`

An action's code threw, the runtime caught it, and nothing routes it: a close throw after the one failure the action routes, a close throw in an action that ended another way, or what stopped work on an entity that left the tree threw on its way out. Once per throw. The same throw reaches the `failure` event with `Taken: false`. Data: `{ actionName, entityId, close, error }`, the error serialized. A routed failure nothing took raises no diag: it is an unhandled rejection already.

### `entity/written-while-held`

An action wrote into an entity another action holds, so the holder can find what it read changed after its wait. Once per pair of writer and holder functions. Data: `{ writer, holder, entityId, path, slot? }`, `slot` naming the transient when the write went into one. **Do:** send the write to the entity as work, with `yield* start(...)` ([`actions.md`](./actions.md#writing-into-a-child-entity)).

### `cancel/finally-yield`

A `finally` yielded while its generator was being closed. Nothing can run an effect during a close, so the rest of that `finally` block was skipped; outer ones still run. Every such yield. Data: `{ actionName, branchId, yieldedType }`. **Do:** keep `finally` to synchronous writes; effectful cleanup on the stop path belongs to something that survives the stop ([`fibers.md`](./fibers.md#cleanup-belongs-to-the-survivors)). The `treflex/no-yield-in-finally` lint rule reports it before it runs.

### `cancel/finally-yield-limit`

A close yielded more than 100 times, so the generator was abandoned with the rest of its `finally` blocks unrun. Data: `{ actionName, branchId }`.

## Dispatch

### `dispatch/unresolved-entity`

Two producers. **`runtime.dispatch`**, or a feature's action, named an `$Id` the tree doesn't hold: unknown, removed, component state whose component unmounted, or a root with no `$Id`. The dispatch rejects with `EntityGoneError` before the action starts. Once per `$Id`, cleared when that `$Id` next dispatches; the rejection recurs on every call. Data: `{ entityId, cause: "unresolved" }`. **Do:** give the root a `$Id`; gate a view on a slot that holds nothing yet.

**`start`** named an entity the tree doesn't hold, so the action wasn't started and the starting action went on. Every time. Data: `{ entityId }`. **Do:** start it once the entity is in state.

### `dispatch/node-mismatch`

A dispatch's or a `start`'s target was a node, and not the one the tree holds under its `$Id`. A dispatch rejects before the action starts; a `start` throws at its yield. Once per refused node and cause, until that node is accepted as a target again; dispatches by its `$Id` or with other nodes don't clear it. Data: `{ entityId, cause }`. **`"superseded"`**: the node was this tree's and has left it; read the entity from the tree again. **`"foreign"`**: a copy or other plain value carrying the `$Id`, such as a spread or an action's returned value, or another runtime's node; dispatch by the `$Id`, or with the tree's own node.

## Effects

### `effect/sync-returned-promise`

A `settles: "sync"` effect's implementation returned a promise, and the yield threw `SyncEffectPromiseError`. Once per effect type, whether or not the action caught the error. Data: `{ effectType }`. Usually an `async` implementation, a test stub or a lazy loader. **Do:** return the value directly, or drop `settles: "sync"` ([`effects.md`](./effects.md#sync-effects)).

### `effect/sync-promise-rejected`

The promise behind `effect/sync-returned-promise` later rejected. Every rejection. Data: `{ effectType, cause }`, `cause` being the implementation's real failure; a redacted type has no `cause`.

## State

### `state/outside-action-write`

A write reached the state tree outside a step of the action that owns it, from a timer, a promise callback or another action's body, and threw a `TreflexRefusal`. Every time. Data: `{ path }`. **Do:** dispatch an action and write through its draft in its own steps; an external system pushing state in is a [resource](./live-sources.md).

### `state/view-write`

A write went through a read-only state view, `runtime.state`, a view's state, or a selector's argument, and threw a `TreflexRefusal`. Every time. Data: `{ key, verb }`. **Do:** dispatch an action.

### `entity/replaced-by-plain-data`

A write replaced entities with plain data carrying no `$Id`, and something was attached to them, which has ended: a binding, timers, resources, running actions. A replaced entity with nothing attached reports nothing. It refuses nothing. Once per container per write. Data: `{ at, entities }`, up to ten entities, each with its `id` and attachments. **Do:** for a refresh, use `reconcileRows`, which keeps the rows that match and what is attached to them; to load one entity, write its fields; to make a new one, use `entity()` ([`write-path.md`](./write-path.md#refreshing-rows)).

### `selector/many-tracked-reads`

One run of a selector tracked more than 50,000 reads, so a change to any of them re-runs all of it. Once per selector function. Data: `{ selector, trackedReads }`, `selector` being the function's name. **Do:** read less per run, or derive per row with a selector on each row, memoized per entity ([`derived-reads.md`](./derived-reads.md#memos)).

## Receivers

### `receiver/unresolved`

Something names a receiver that isn't registered, or claims a topic it can't serve, so nothing ran for it. Nothing is removed, and registering the receiver heals it. `data.kind` tells the producers apart:

| `kind` | When | Once per | Data |
|---|---|---|---|
| `"binding"` | Entities are bound to an unregistered receiver; a microtask after the binding lands | Receiver id | `{ receiverId, ownerIds, count }`, up to ten owners |
| `"publish"` | A `publishToNearest` walk stopped at an ancestor bound to an unregistered receiver | Topic, stopping entity and receiver | `{ topic, ownerId, receiverId, shadowedId }`, `shadowedId` the nearest handler above it, or `null` |
| `"timer"` | A tick found its receiver unregistered, skipped, and re-armed | Key, owner and receiver, cleared by a tick that reaches it | `{ key, ownerId, receiverId }` |
| `"resource"` | A resource row's receiver is unregistered; the resource waits unconnected | Key, owner and receiver | `{ key, ownerId, receiverId }` |
| `"source"` | An external source declares the topic and has no `receivePublish` | Topic and source | `{ topic, ownerId, receiverId }`, both the source's `Id` |

**Do:** register the receiver at startup with `runtime.registerReceiver(Receiver)`.

For a receiver that doesn't fire, see [`messaging.md`](./messaging.md#when-a-receiver-doesnt-fire).

### `receiver/id-collision`

A receiver id was registered again with a different handle, in a production build, where it means two modules claim one id; a development build stays silent, since there it is a hot reload. The later registration wins, and every entity bound to the id and every timer row naming it dispatch into it from then on. Every such registration. Data: `{ id }`. **Do:** check the receiver exports and the glob that registers them.

## Resources

Each names the key and the owner.

### `resource/unregistered-type`

A row names a type no `registerResourceType` has registered. The row is recorded and waits, `pending` on `"type"`, until the type registers. Once per type, key and owner. Data: `{ type, key, ownerId }`.

### `resource/ended`

An instance ended by itself because its setup threw, its implementation rejected, or an `onIdle` callback threw. The receiver gets `$Ended` with `Reason: "failed"` and the error. Every time. Data: `{ key, ownerId, error }`, `error` the serialized throw, as `$Ended` carries it.

### `resource/invalid-message`

`r.emit` was given a message that isn't plain data, is an array, or carries `Type` or a top-level `$`-prefixed field. It wasn't delivered. Every time. Data: `{ key, ownerId }`. **Do:** wrap it, `{ Event: wire }`, or encode it.

### `resource/queue-depth`

More than 100 emits are queued behind the receiver. Once per instance. Data: `{ key, ownerId, depth }`. **Do:** batch what arrives and emit it from `r.onIdle`, or make the receiver quicker.

### `resource/receiver-waiting`

A receiver a resource delivered to waited on a resource method or an ask, so every later delivery to the cell waits behind it. Once per key, owner and effect type. Data: `{ key, ownerId, effectType }`. **Do:** run that work in an action the receiver starts, `yield* start(...)`.

### `resource/not-open`

A method found no row for its key and owner, and resolved `undefined`. Once per key and owner. Data: `{ key, ownerId }`. **Do:** check that `openResource` ran, and the key and owner.

### `resource/used-after-end`

A method found the resource ended, and resolved `undefined`. Once per key and owner. Data: `{ key, ownerId }`. **Do:** reopen it to use it again.

### `resource/unknown-method`

A method the type didn't register was called, and resolved `undefined`. Once per key and method. Data: `{ key, method, type }`.

### `resource/supply-dropped`

A supplied value had no taker and was dropped; the supply resolved `undefined`, and the view still holds the value. Every time. Data: `{ key, ownerId, reason }`, `reason` one of `"no owner"` (a `useResource` owner accessor answered `undefined`), `"no open resource"`, `"paused"`, `"no live instance"`, `"retired before setup"` or `"no onSupply registered"`.

### `resource/still-paused`

A restore's repair hasn't settled 3 seconds after the load, and every resource stays paused until it does. Never under a permanent pause. Once per restore. Data: `{ repair }`, the repair function's name or `null`.

## Restore

### `restore/malformed-rows`

The restore dropped malformed rows from the envelope's tables or in-flight list, and loaded the rest. Once per restore. Data: `{ droppedRows }`.

### `restore/orphaned-rows`

The restore left out table rows whose owners aren't in the restored tree, counted in the result's `sweptOrphanedRows`. Once per restore. Data: `{ count }`.

### `restore/unresolved-receiver`

Restored bindings, timer rows or resource rows name receivers this build hasn't registered, typically one renamed between deploys. They stay, and deliver nothing until registered; the result's `unresolved` lists them. Once per restore. Data: `{ count, receiverIds, sample }`, up to ten of each. **Do:** register the receivers in `setup`, or unbind the entities and retract the rows.

## The runtime

### `runtime/callback-threw`

Code the runtime calls outside any action threw. Only that call is lost: a tap or subscriber stays attached, and the runtime goes on. The code: a record tap, a `runtime.on` subscriber, a cached read's dispose, a resource's release of an exposed value, a resource manager task, a dispose callback, an `onDrained` listener, a React view's store listener, a view reading `inFlight` or `pendingAsks`, or an external source's `dispose`. Every throw. Data: `{ source, error }`, the live error, with `kind`, `entityId`, `ownerId`, `key` or `sourceId` where there is one.

## Console warnings

These go to the console only, with no code and no `diag` event:

| Warning | When |
|---|---|
| `registerDataSource(...)` owner not in the state tree | The owner's `$Id` isn't in the tree, so nothing will remove the registration |
| `registerDataSource(...)` owner already owns the key | A second registration of a key on one owner, which replaces the data |
| `getData(...)` or `getDataPath(...)` called from an entity not in the state tree | `from`'s `$Id` isn't in the tree; the read answers `undefined` |
| `startTimer` called from an entity not in the state tree | The row is written, and its first tick removes it |
| `publishToNearest` called from an entity not in the state tree | Nothing is delivered, and no record lands |
| External source already registered, or a key already served | The second registration, or that key of it, is ignored |
| Implementation for an effect being overwritten | `registerImplementation` for a type that has one |
| Effect declared again with different options | `defineEffect` for a type declared with other options, which replaces them |
| `draft/stale-path-write`, `draft/stale-path-delete` | With a record tap attached: a write through a held reference to a node that has since moved, so its record names a path another node holds. Once per node |
| `draft/orphaned-write`, `draft/orphaned-delete` | With a record tap attached: a write through a held reference to a node that left the tree in this step, which lands on the detached node unseen. Once per node |
| A non-`Error` throw doesn't survive JSON serialization | A thrown value with no faithful JSON form; its records and `Action/Error` payload carry a different value |

For a registration warning, register from the draft the action was given or an entity under it. For a draft warning, write through a reference found again from the draft after whatever moved or replaced the node ([`actions.md`](./actions.md#held-references)).
