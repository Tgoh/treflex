# Restart and records

Surviving a restart, and seeing what happened. treflex writes a running runtime to one JSON envelope, and builds a new runtime from it: the state tree with every binding, the data sources, the timer rows and the resource rows come back, and every resource reopens. A running action doesn't, so data about running work goes in a transient, which no snapshot carries ([`state-tree.md`](./state-tree.md#transients)). The record stream is how anything outside the app sees what happened.

## Usage

The guide teaches this in [9. Restore](../guide/09-restore.md).

### Snapshots

Both calls come from `treflex/snapshot`.

```ts
import { createSnapshot } from "treflex/snapshot";

export function save(runtime: IRuntime<IPlatform>, store: (json: string) => void): void {
    store(createSnapshot(runtime));
}
```

**`createSnapshot(runtime)`** returns the envelope as a string, synchronously, without pausing the app. **`TransientState` and `ComponentState` are never saved** ([what a snapshot holds](#what-a-snapshot-holds)).

A good default is to save on tab-hide and unload, plus a debounced save after actions that change saved state ([below](#the-tap)), guarding every storage call.

### Restoring

```ts
import { createRuntime, type IRuntime, type IRuntimeOptions } from "treflex";
import { restoreRuntime, SnapshotRejectedError } from "treflex/snapshot";

const options: IRuntimeOptions = { onError: (error) => console.error(error) };

function setup(runtime: IRuntime<IPlatform>): void {
    runtime.registerReceiver(PlatformReceiver);
}

export async function boot(saved: string | null, seed: IPlatform): Promise<IRuntime<IPlatform>> {
    if (saved) {
        try {
            const { runtime } = await restoreRuntime(saved, { rootId: seed.$Id, options, setup });
            return runtime;
        } catch (error) {
            if (!(error instanceof SnapshotRejectedError)) throw error;
            discardSaved();
        }
    }
    const runtime = createRuntime(seed, options);
    setup(runtime);
    await runtime.dispatch(init, seed.$Id);
    return runtime;
}
```

`SnapshotRejectedError` means the envelope can't become a runtime: discard it and boot fresh. **A restore doesn't run `init`.** What `init` wrote is in the tree, and the tables it filled are loaded.

### A newer build

**A restore loads the saved state, as it was saved, into the code that is running.** Nothing checks the tree against the state's type, and the envelope's own `Version` is treflex's format, not the app's. So when a build changes the shape of state, version the envelope you save, and discard an old one or migrate it before `restoreRuntime`:

```ts
import type { IRuntime } from "treflex";
import { createSnapshot, type ISnapshot } from "treflex/snapshot";

const APP_VERSION = 2;

export function wrap(runtime: IRuntime<IPlatform>): string {
    return JSON.stringify({ AppVersion: APP_VERSION, Snapshot: createSnapshot(runtime) });
}

export function unwrap(stored: string): string | null {
    try {
        const { AppVersion, Snapshot } = JSON.parse(stored);
        if (typeof Snapshot !== "string") return null;
        if (AppVersion === APP_VERSION) return Snapshot;
        if (AppVersion === 1) return migrateFrom1(Snapshot);
    } catch {}
    return null;
}

function migrateFrom1(json: string): string {
    const envelope: ISnapshot = JSON.parse(json);
    const root = envelope.AppState as { Dark?: boolean; Theme?: string };
    root.Theme = root.Dark ? "dark" : "light";
    delete root.Dark;
    return JSON.stringify(envelope);
}
```

A `null` from `unwrap` boots fresh. A migration rewrites `AppState` and keeps every `$Id` and `$Receiver`, since the saved timer, resource and data-source rows name their owners by `$Id` and a binding names its receiver.

### What happens to in-flight work

**Nothing that was running comes back.** A restored runtime has no action running and no ask open.

- **Committed writes stand.** What an action wrote before the snapshot is state. Keep progress in state as the work goes, a step field say, so an interruption is an inconvenience rather than a corruption.
- **A running tick is dropped** like any action, and its timer fires again soon after the load. Every other timer arms for the time it was next due ([ticks](./live-sources.md#ticks)).
- **A resource's own work** is done again by the reopened resource.

### The build and the names

Two questions about saved running work have two answers:

- **Which action was it?** Its [durable name](./actions.md#durable-names), the same in every build. A later build can redo a dropped `"Editor/Save"`.
- **Was it this code?** The runtime's [`build`](./runtime.md#build), which `createSnapshot` writes into the envelope as `Build`, or `null` when the runtime has none.

```ts
const savingOptions: IRuntimeOptions = {
    onError: (error) => console.error(error),
    build: BUILD_ID,
    requireNames: true
};
```

**`build` is not the app's version.** The app's version, the `APP_VERSION` [above](#a-newer-build), changes by hand when the state's shape changes, and a save of another version is migrated or discarded before `restoreRuntime` sees it. The build changes with every build, by itself. A deploy that changes code but not the state's shape keeps `APP_VERSION`, so its users' data loads and their running work is dropped.

**The data loads either way.** A restore's result says whether the save is from the running code: `savedBuild` is the envelope's `Build`, and `sameBuild` is `true` only when it and the runtime's `build` are both strings and equal. In-flight work is dropped on either answer. The repair matches on names:

```ts
import { type IActionGenerator, named } from "treflex";

export function* saveInterrupted(draft: IPlatform): IActionGenerator {
    draft.Notice = "A reload cut a save short. Save again.";
}
named(saveInterrupted, "Editor/SaveInterrupted");

export function restoreRepairing(saved: string, seed: IPlatform) {
    return restoreRuntime(saved, {
        rootId: seed.$Id,
        options: savingOptions,
        setup,
        repair: async (runtime, result) => {
            if (result.dropped.some((d) => d.name === "Editor/Save")) {
                await runtime.dispatch(saveInterrupted, seed.$Id);
            }
        }
    });
}
```

A restore doesn't check that each dropped name exists in this build: a code-split module's actions aren't named until its chunk loads. An app that saves sets [`requireNames`](./runtime.md#requirenames).

## Rules

### What a snapshot holds

The runtime only interleaves at yields, so any moment outside a step is a consistent cut. A section nested deeper than 1,000 levels throws `SnapshotTooDeepError` and writes nothing, since no restore would take it, and a disposed runtime throws `SnapshotOfDisposedRuntimeError`.

The envelope holds a format version, the runtime's `build`, and:

| Saved | Rebuilt at startup |
|---|---|
| `AppState`, each entity's `$Receiver` included | Effect implementations, receivers, resource types |
| Data-source registrations | Runtime services, and [outside values](./derived-reads.md#outside-values), which `setup` provides again |
| Timer rows, each with its next due time | The index over the tree, and the bindings derived from it |
| Resource rows | Record taps and event subscribers |
| The in-flight list: each running action's id, `Name`, `Label`, `Receiver` for a delivery, and entity | Timer handles, armed from rows for their due times |
| | Resource instances, reopened from rows |

Nor is any row or registration saved that an entity in `TransientState` or `ComponentState` owns, nor any action running on one. Actions a resource started are left out of the in-flight list too. A live thing an implementation needs back is a resource ([`live-sources.md`](./live-sources.md)).

The reader takes exactly the sections it knows and ignores the rest. It reads format 8, and 7, the one before, whose in-flight entries carry no durable names: each reads with `name: null` and its old `Name` as the `label`, and the envelope's build as `null`. An envelope of any other format version is rejected, so the app discards it and boots fresh.

### The restore, in order

**`restoreRuntime(json, { rootId, options, setup?, repair? })`** builds a new runtime from an envelope, in this order:

1. **The envelope is checked.** Invalid JSON, another format version, a missing or mis-shaped section, a root that isn't an object with a non-empty string `$Id`, a root other than `rootId`, a section nested deeper than 1,000 levels, or a tree a seed's checks refuse (not plain data, an `$Id` that isn't a non-empty string or sits on two nodes, a malformed `$Receiver`) rejects with `SnapshotRejectedError`. A `json` that isn't a string, or a `rootId` that isn't a non-empty string, rejects with `TypeError`: those are bugs in the boot, not a bad save.
2. **`createRuntime(tree, options)` builds the runtime** over the saved tree, taken as a seed is. Each entity's binding is in its state, so it is bound as it was.
3. **The tables load.** A row whose owner the tree doesn't hold is left out, with [`restore/orphaned-rows`](./troubleshooting.md#restoreorphaned-rows), and a malformed row is dropped, with [`restore/malformed-rows`](./troubleshooting.md#restoremalformed-rows). A failure here rejects with `SnapshotRejectedError`.
4. **`setup(runtime)` registers**: receivers, implementations, resource types, runtime services and taps, and provides outside values with `provideExternal`, the same function a fresh boot calls. None of them is saved, so a `setup` that leaves one out leaves it out of the restored runtime: a key it doesn't provide reads `undefined`, with [`external/unprovided`](./troubleshooting.md#externalunprovided) in development. It must be synchronous: one that returns a promise rejects with `AsyncSetupError`. Nothing else sees the runtime before it returns, and a diag listener it attaches hears the table load's diags.
5. **Bindings and rows naming a receiver this build hasn't registered** are listed in the result and reported with [`restore/unresolved-receiver`](./troubleshooting.md#restoreunresolved-receiver).
6. **The repair runs**, if there is one ([below](#the-repair)).

A rejection disposes the runtime built so far. A failure from the tree's seed check or the table load is the `SnapshotRejectedError`'s `cause`. Any other rejection, an option `createRuntime` refuses or a throw from `setup`, rejects as itself, since a fresh boot would hit it too and it is no reason to discard the save.

The state type comes from a typed `setup`; a restore without one names it, `restoreRuntime<IPlatform>(json, { rootId, options })`. A test restores with [`restoreTestRuntime`](./testing.md#testing-a-restore).

It resolves to `{ runtime, result }`, `result` an `IRestoreOutcome`, which is the `IRestoreResult` the repair receives plus the repair's error:

```ts
interface IRestoreResult {
    dropped: {                                    // the in-flight list
        actionId: string;
        name: string | null;
        label: string | null;
        receiver?: string;
        entityId: string;
    }[];
    unresolved: { ownerId: string; key: string | null; receiverId: string }[];  // a binding's key is null
    sweptOrphanedRows: number;
    savedBuild: string | null;
    sameBuild: boolean;
}

type IRestoreOutcome = IRestoreResult & { repairError?: unknown };
```

An unresolved binding or row stays and delivers nothing until its receiver registers; an app that won't register it unbinds the entity or retracts the row.

**`name` is the key:** the action's durable name, or `null` for an action without one. Match on it. **`label` is a label, never a key.** It is the function's own `name` as the writing build spelled it, or `null` for an anonymous function. Use it in a log or a devtools panel, never as something to match on or show a person. A delivery's entry carries its receiver's id as `receiver`, and no name. An entry with neither a name nor a receiver can be recognised only by its entity.

**Loading a save into a running app** takes a new runtime from `restoreRuntime`, the views mounted again on it, and the old runtime disposed. Component state lives in the runtime and is never saved, so the remount starts it from its factories. In React, key the provider with something that changes per runtime, such as a load counter; in Solid, dispose the render root and render again. Anything that holds the old runtime, a save handler say, moves to the new one. A rejection here means keep the current runtime.

### The repair

`repair(runtime, result)` is for an app that must react to a restore, announce it or re-authenticate, before any live source reconnects. It runs after `setup` with every resource paused: methods and supplies resolve `undefined`, and cells read `pending` with `Waiting: "paused"`. Resources are set up when its promise settles, and `restoreRuntime` resolves after that. A repair that throws doesn't reject the restore: its error rides the result as `repairError`, and resources are set up regardless.

The repair is for the app's own state. Outside-world work after a restore, re-subscribing or telling a server the client is back, belongs in the resource type's setup, which runs at every reopen, or in the receiver handling its first message. Closes belong in the repair's action or a receiver's first step.

### Resources after a restore

Every resource reopens. A type works out what reopening means from its row, the owner's restored state and `r.resumeFrom`: a stream resumes from its cursor, an upload type reopens empty. Without a repair, every row is set up on the manager's first drain after `setup`, and a row whose type or receiver is missing waits until it registers.

### Recovering after a restore

**`dropped` is the recovery hook.** Each entry names the action and its entity. An app either re-derives the work from the restored tree, or has the feature that owned it say what the interruption meant, in its own words. A resource's own work isn't in `dropped`.

The seam for saying what an interruption means is a topic. The bootstrap publishes once, headless, from the repair, before the first render, and any entity bound to a receiver with a case for it reacts:

```ts
import { type IActionGenerator, publish } from "treflex";

declare module "treflex" {
    interface IMessageRegistry {
        "Platform/Restored": { DroppedEntityIds: string[] };
    }
}

export function* announceRestore(_draft: IPlatform, droppedEntityIds: string[]): IActionGenerator {
    yield* publish("Platform/Restored", { DroppedEntityIds: droppedEntityIds });
}

export function restoreAndAnnounce(saved: string, seed: IPlatform) {
    return restoreRuntime(saved, {
        rootId: seed.$Id,
        options,
        setup,
        repair: (runtime, result) =>
            runtime.dispatch(announceRestore, seed.$Id, [...new Set(result.dropped.map((d) => d.entityId))])
    });
}
```

The publisher needs no knowledge of the tree: bindings are saved, and `setup` registered their receivers. Each owner recognises its own entity in the payload and ignores the rest. The announcement's dispatch settles once its receivers are dispatched, not once they finish, so a receiver doing slow recovery holds up neither the first paint nor the resources; it shows its own loading state meanwhile.

What a receiver does with it:

- **Re-derives what the renderer can't**: anything the app projected outside the render tree, such as theme variables on the document root.
- **Says what happened, in the feature's words**, written into its own state, which the UI shows.
- **Restarts work that isn't a live thing.** Whatever `init` does that a snapshot can't carry is a function both `init` and the restore receiver call. A live feed is a resource, whose row reopens by itself.

Receivers run in registration order, each its own action, so recovery across features is concurrent. A feature that must run after another publishes a second topic.

### The record stream

Every moment of the runtime's work is a **record** in one numbered history: an action starting, a step's writes, an effect and its settlement, a delivery, an entity leaving. Beside the records, `runtime.on` carries two events: `diag`, about the runtime itself ([`troubleshooting.md`](./troubleshooting.md)), and `failure`, the throws it caught ([`failure.md`](./failure.md#the-failure-event)).

#### The tap

A **tap** hears the records, `runtime.on("record", handler, { kinds? })`, and every tool is a tap: tracing, devtools, audit, performance monitors.

```ts
import type { IRuntime } from "treflex";

export function audit(runtime: IRuntime<object>, write: (line: string) => void): () => void {
    return runtime.on(
        "record",
        (record, live) => write(`${record.ActionId} ${record.Status} in ${live?.duration ?? 0}ms`),
        { kinds: ["action:end"] }
    );
}
```

**A tap is a tool about the app, never part of it.** It is fire-and-forget, and nothing it does is recorded. If removing a subscriber would change what the app does rather than what you can see, the logic belongs in [messaging](./messaging.md). Observing `action:end` errors is not handling them ([`failure.md`](./failure.md#the-failure-event)).

- **Records arrive synchronously**, as each is appended, in `Seq` order. `Seq` counts from 1 in each runtime, a restored one included.
- **With `kinds`, a tap hears only those**, its records typed by them. Without, it hears every kind.
- **Records are owned data**: written values are copied when the record is made, so a tap can buffer them, send them across a boundary or keep them.
- **`live`, the second argument**, carries display material that is never in a record: an action's `result` or live `error` and `duration` on `action:end`, a settlement's `result` or `error` and `duration` on `response`, and the live `error` on `receiver:error`. A consumer that saves records drops it. A [redacted](./effects.md#options) settlement and an `r.run` action's result are withheld from it.
- **A tap's throw** loses only that call: the tap stays attached, the other taps and the runtime go on, and it is reported as [`runtime/callback-threw`](./troubleshooting.md#runtimecallback-threw).
- It returns the function that removes the tap.

#### What a kind costs

A kind is made only while some tap takes it. Subscribing is the switch: a runtime with no tap makes no records and copies no writes. An action samples its own kinds (`action:start`, `step`, `effect`, `response`, `branch:start`, `branch:end`, `action:end`) once, at its dispatch, so each kind of an action's trace is complete or absent, never partial: attach tools at construction for complete histories. `effect` and `response` are made together for a tap of either, since a response names its effect by `Seq`.

The dear kind is `step`, which copies every written value before and after. The copy is of the written value, not of the tree, so steady small writes are cheap and overwriting a large subtree dominates.

**Saving on change.** Only `AppState` is saved, and a record that can change saved state names its root as `Root`. An autosave counts the `step`, `table` and `entity:dispose` records whose `Root` is `"AppState"`. A step's `Root` is its action's, so a step that wrote only a transient of an `AppState` entity counts too; its `Changes` paths start with `TransientState`.

#### Record kinds

| Kind | One per | Carries |
|---|---|---|
| `action:start` | Action started | `ActionId`, `Name` (the [durable name](./actions.md#durable-names), or `null`), `Label` (the function's `name`, or `null`; a label, as for `dropped`), `Receiver` for a delivery, its receiver's id, `EntityId`, `Path` (the entity's `$Id` path at dispatch, its own last), `Args`, `StartedBy` for a started action, `Origin` (`{ Kind: "resource:deliver" \| "resource:run", Key, OwnerId }`) for a resource's |
| `action:end` | Action ended | `ActionId`, `Status`: `completed`, `cancelled`, `errored`, or `dropped` for work that ran nothing, a `leading` repeat, or a delivery or tick that stopped being wanted while it queued |
| `step` | Step with writes | `ActionId`, `BranchId`, `Changes` (`{ Path, Prev, Value?, Deleted?, Created?, GrewFrom? }`, both sides copies); `Cancelling: true` for a close, one record for the whole close; `InFlightAnswers` when the step resumed from `inFlight` reads, and `ExternalAnswers` when it resumed from `external` reads ([an action's read](./derived-reads.md#an-actions-read)), either one even with no changes |
| `effect` | Effect yielded | `ActionId`, `BranchId`, `Type`, `Descriptor` (a copy of what was yielded, or `Type` only for a redacted type) |
| `response` | Settlement delivered to the fiber | `ForSeq` (the effect's `Seq`), and `Value` or `Error`. An effect with no response is still in flight, or was when its fiber was stopped |
| `branch:start`, `branch:end` | Branch of `parallel` or `parallelSettled` | `ActionId`, `BranchId`, `ParentBranchId`; on the end, `Status` and, when errored, the serialized `Error` |
| `table` | Change to a runtime table | `Table`: `"dataSources"`, `"timers"` or `"resources"` with `Key` and `OwnerId`, or `"asks"` with `AskId`; and the cell's `Prev` and `Value` (`null` for none) |
| `resource:supply` | Supply reaching the manager | `Key`, `OwnerId`; never the value |
| `message:deliver` | Publish, tick, or resource delivery | `Topic`, `PublisherId`, `RecipientIds`, `UnresolvedIds` ([`messaging.md`](./messaging.md#records)) |
| `receiver:error` | Delivery whose receiver threw | `Topic`, `RecipientId`, `PublisherId` |
| `entity:dispose` | Entity that left the tree | `EntityId`, `Path`; depth-first, after its cleanup |
| `ask:answer`, `ask:abandon` | Ask ended | `AskId`, `OwnerId`; on the abandon, `Reason`: `"disposed"` (the owner left) or `"cancelled"` (the asker stopped) |

A binding change is a `step` change at `$Receiver`. Every record carries `Seq`, `T` (`performance.now()`) and `Kind`. An action's records, `entity:dispose`, `resource:supply` and the data-source, timer and resource `table` records carry `Root`; ask and delivery records carry none, since nothing of theirs is saved.

#### Traces

`createTraceAggregator(runtime, onTrace)` rebuilds one `IActionTrace` per action from the stream, `{ actionId, name, label, args, entityId, entries, duration, error?, cancelled?, dropped? }`, `name` and `label` the `action:start` record's, its entries the steps in order and each effect when it settles. A step entry is `{ type: "step", branchId, changes, inFlightAnswers?, externalAnswers? }`; an effect entry is `{ type: "effect", branchId, effect, duration }` with `result` or `error`. An effect still open when the action ended is appended last, with `aborted: true`. It ignores records of actions it didn't see start, so attaching mid-action is clean. It taps every kind, `step` included. It returns the function that stops it.

#### The activity log

`createActivityLog(runtime, { cap? })` taps the kinds `action:start`, `action:end`, `branch:start`, `branch:end`, `entity:dispose` and `message:deliver`, and provides the latest of them, 200 by default, as the [outside value](./derived-reads.md#outside-values) `ActivityLog`, newest first. Call it in `setup`, so a restored runtime gets a new, empty log:

```ts
import { createActivityLog, external, type IActivityLogEntry, type IEntity, type IRuntime, type ISelectorGenerator } from "treflex";

export function setupLog(runtime: IRuntime<IEntity>): void {
    createActivityLog(runtime, { cap: 100 });
}

export function* recentEnds(_draft: IEntity): ISelectorGenerator<readonly IActivityLogEntry[]> {
    const log = yield* external("ActivityLog");
    return log ? log.filter((entry) => entry.Kind === "action:end") : [];
}
```

- **Each entry is `{ Seq, Kind, Time, Data }`,** frozen. `Seq` is the log's own count from 1, `Time` is `Date.now()` when the log took the record, and `Data` is the record. A `branch:end` is kept without its `Error`, an `undefined` argument on an `action:start` is kept as `null`, and the tap extras are never kept.
- **It taps only those kinds,** so on its own it turns on no `step`, `effect` or `response` records and copies no writes ([what a kind costs](#what-a-kind-costs)). An action's read of the log lands on the action's `step` record, which the log doesn't keep.
- **It returns the function that stops it.** The key keeps its last value. A second `createActivityLog` on the runtime replaces the first, whose tap stops, with `external/replaced`, and `runtime.dispose()` stops it.

## Caveats

- **A field in the tree holding a transient entity's `$Id`** dangles after a restore, and so does a data source whose data entity sits in a transient; nothing reports either. Point saved state only at saved entities.
- **A `label` in a production build** is whatever the minifier made of the function's name; a bundler's keep-names option (`keepNames` in esbuild and Vite, `keep_fnames` in terser) keeps it legible.
- **A version 7 envelope's dropped entries** have no names, so a repair that matches on names finds none of them.
- **A repair still unsettled 3 seconds after the load** raises [`resource/still-paused`](./troubleshooting.md#resourcestill-paused).
- **A close made later than the repair's action or a receiver's first step** costs one brief reconnect.
- **A tap of `step` without `action:start`** gets steps whose action it never saw.
- **A tap handler doesn't read the runtime's tables** to learn about a record: a `table` record arrives after its change, and an `entity:dispose` after the cleanup, when `runtime.timers(id)` and `runtime.resources(id)` hold nothing of the entity. A tool that needs what an entity held keeps its own copy from earlier records.
- **While any tap is attached,** an action also checks that each write through a held reference lands where its record says, and warns `draft/stale-path-write` or `draft/orphaned-write` on the console when it doesn't ([`troubleshooting.md`](./troubleshooting.md#console-warnings)).
- **With `parallel` branches, a trace's effect yielded early and settled late** comes after later steps, since each effect is entered when it settles.
