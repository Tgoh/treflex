# Restart and records

Surviving a restart, and seeing what happened. treflex writes a running runtime to one JSON envelope, and builds a new runtime from it: the state tree with every binding, the data sources, the timer rows and the resource rows come back, and every resource reopens. A running action doesn't, unless [resume](#resume) brings it back, so data about running work goes in a transient, which no snapshot carries ([`state-tree.md`](./state-tree.md#transients)). The record stream is how anything outside the app sees what happened.

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

**Nothing that was running comes back, except what [resume](#resume) brings back.** On a runtime without the `resume` option, a restored runtime has no action running and no ask open. With it, an action marked `resumable` and saved by the same build can come back to the wait the snapshot caught it at, and everything else is dropped.

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

**The data loads either way.** A restore's result says whether the save is from the running code: `savedBuild` is the envelope's `Build`, and `sameBuild` is `true` only when it and the runtime's `build` are both strings and equal. Without [resume](#resume), in-flight work is dropped on either answer; with it, only a same-build save resumes anything. The repair matches on names:

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

### Resuming a flow

A flow that asks several questions across several waits can keep its progress two ways, and each is right for the behaviour an app wants:

- **Rows in state** survive any restore, a deploy included: each step writes what it learned into the tree, and the next step reads it from there ([the durable conversation](./conversations.md#the-durable-conversation)).
- **Answers in locals, with resume,** survive a reload of the same build, and after a deploy the repair starts the flow again. The flow is one action that holds its answers in local variables across its waits, marked `resumable`, on a runtime with `resume` on and a `build`:

```ts
import { ask, defineEffect, type IEffect, type IEntity, type IOpenGenerator, named, open, resumable } from "treflex";

interface IOrder extends IEntity {
    Total: number;
    Receipt: string;
}

interface IQuoteRequest extends IEffect {
    Type: "Shop/Quote";
    Postcode: string;
}

interface IPayRequest extends IEffect {
    Type: "Shop/Pay";
    Total: number;
}

const quote = defineEffect<IQuoteRequest, number>("Shop/Quote", { idempotent: true });
const pay = defineEffect<IPayRequest, string>("Shop/Pay");

export function* checkout(draft: IOrder): IOpenGenerator {
    const postcode = yield* open(ask<string>(draft, { Path: "Shop/Postcode" }));
    if (!postcode) return;
    const total = yield* open(quote({ Postcode: postcode }));
    const confirmed = yield* open(ask<boolean>(draft, { Path: "Shop/Confirm", Total: total }));
    if (!confirmed) return;
    draft.Total = total;
    draft.Receipt = yield* pay({ Total: total });
}
named(checkout, "Shop/Checkout");
resumable(checkout);

const resumeOptions: IRuntimeOptions = {
    onError: (error) => console.error(error),
    build: BUILD_ID,
    requireNames: true,
    resume: true
};
```

A restore into the same build brings `checkout` back to the wait the snapshot caught it at, with `postcode` and `total` in its locals: an open question is asked again, and a quote is sent again, since `Shop/Quote` is declared [`idempotent`](./effects.md#options). Caught at the payment, which isn't, it drops, and the repair finds out from the server what became of it. The repair acts on what dropped, and on nothing a resumed action is doing:

```ts
import type { IActionGenerator } from "treflex";

export function* checkoutInterrupted(draft: IOrder): IActionGenerator {
    draft.Receipt = "checking";
}
named(checkoutInterrupted, "Shop/CheckoutInterrupted");

export function restoreResuming(saved: string, seed: IPlatform) {
    return restoreRuntime(saved, {
        rootId: seed.$Id,
        options: resumeOptions,
        setup,
        repair: async (runtime, result) => {
            for (const entry of result.dropped) {
                if (entry.name === "Shop/Checkout") await runtime.dispatch(checkoutInterrupted, entry.entityId);
            }
        }
    });
}
```

What resumes and what drops, and why, is in [resume](#resume).

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
| The in-flight list: each action that has arrived on an entity and whose code hasn't finished, by its id, `Name`, `Label`, `Receiver` for a delivery, the entity it is gated on, its `State`, and its `Place` while it waits | Timer handles, armed from rows for their due times |
| With [resume](#resume) on, `Histories`: what a restore needs to bring each in-flight `resumable` action back ([what a save holds](#what-a-save-holds-with-resume)) | Resource instances, reopened from rows |

An entry's entity is the one whose hold the action takes: for a form over part of an entity, the entity above it. Its `State` is what the action was doing at the cut:

| `State` | The action |
|---|---|
| `"holding"` | Had started, and held its entity |
| `"open"` | Had started, and was parked inside `open(...)` with its entity let go |
| `"regaining"` | Had its `open` wait answered, and was in its entity's line to take the hold back |
| `"queued"` | Had arrived and not started, and was in its entity's line |
| `"stopping"` | Had already been stopped by the runtime, by a `latest` replacement, and its close hadn't ended; whatever it was doing, it would not have gone on |

A `"queued"` or `"regaining"` entry carries `Place`, its place in its entity's line from 0, counted among the entries listed for that entity, so sorting an entity's waiting entries by `Place` gives the order the runtime would have let them in. An entity's waiting entries don't imply a `"holding"` entry for it: an action whose code has finished is left out, and the work behind it is let in a moment later.

Nor is any row or registration saved that an entity in `TransientState` or `ComponentState` owns, nor any action running on one. Actions a resource started are left out of the in-flight list too, and so is work on a node under no entity. A live thing an implementation needs back is a resource ([`live-sources.md`](./live-sources.md)).

The reader takes exactly the sections it knows and ignores the rest. It reads format 8, and 7, the one before. `State` and `Place` are optional fields of format 8: the in-flight entries of a save treflex 0.2.0 wrote have neither, so each reads with no `state` or `place`. treflex 0.2.0 reads a save this treflex writes, and ignores the two fields and `Histories`, which a runtime without resume ignores too. Format 7, which treflex 0.1 writes, has no durable names: each entry reads with `name: null`, its old `Name` as the `label`, and no `state` or `place`, and the envelope's build as `null`. An envelope of any other format version is rejected, so the app discards it and boots fresh.

### The restore, in order

**`restoreRuntime(json, { rootId, options, setup?, repair? })`** builds a new runtime from an envelope, in this order:

1. **The envelope is checked.** Invalid JSON, another format version, a missing or mis-shaped section, a root that isn't an object with a non-empty string `$Id`, a root other than `rootId`, a section nested deeper than 1,000 levels, or a tree a seed's checks refuse (not plain data, an `$Id` that isn't a non-empty string or sits on two nodes, a malformed `$Receiver`) rejects with `SnapshotRejectedError`. A `json` that isn't a string, or a `rootId` that isn't a non-empty string, rejects with `TypeError`: those are bugs in the boot, not a bad save.
2. **`createRuntime(tree, options)` builds the runtime** over the saved tree, taken as a seed is. Each entity's binding is in its state, so it is bound as it was.
3. **The tables load.** A row whose owner the tree doesn't hold is left out, with [`restore/orphaned-rows`](./troubleshooting.md#restoreorphaned-rows), and a malformed row is dropped, with [`restore/malformed-rows`](./troubleshooting.md#restoremalformed-rows): in a format 8 envelope, that includes an in-flight entry with a `State` that isn't one of the five, a `Place` that isn't a whole number from 0, a `Place` on an entry whose `State` is absent or isn't `"queued"` or `"regaining"`, or no `Place` on a `"queued"` or `"regaining"` entry; and in any envelope, an in-flight entry whose `ActionId` an earlier entry has, the first being kept. A failure here rejects with `SnapshotRejectedError`.
4. **`setup(runtime)` registers**: receivers, implementations, resource types, runtime services and taps, and provides outside values with `provideExternal`, the same function a fresh boot calls. None of them is saved, so a `setup` that leaves one out leaves it out of the restored runtime: a key it doesn't provide reads `undefined`, with [`external/unprovided`](./troubleshooting.md#externalunprovided) in development. It must be synchronous: one that returns a promise rejects with `AsyncSetupError`. Nothing else sees the runtime before it returns, and a diag listener it attaches hears the table load's diags.
5. **Bindings and rows naming a receiver this build hasn't registered** are listed in the result and reported with [`restore/unresolved-receiver`](./troubleshooting.md#restoreunresolved-receiver).
6. **On a runtime with [resume](#resume), every in-flight action is resumed or dropped,** synchronously and before anything live: each resumed one is parked at the wait the snapshot caught it at, with that wait not yet sent, or put back in its entity's line. It follows `setup` because `setup` registers what a resumed action needs the moment it goes live. Without `resume`, every in-flight action is dropped, with the reason `"resume-off"`.
7. **The repair runs**, if there is one ([below](#the-repair)), with `result.resumed` and `result.dropped` complete.
8. **The held waits are sent, and then resources are set up,** when the repair settles or throws. With no repair, the held waits are sent at once after step 6, before `restoreRuntime` resolves, and resources are set up on the manager's first drain after that.

Timers are armed when the tables load, so a tick can fire during an asynchronous repair: the repair runs before a resource opens or a held wait is sent, not before everything.

Steps 2 to 6 run untracked, as a dispatch does, so `restoreRuntime` can be called inside an effect or a memo, as a Solid app boots from `createMemo`: what the restore reads doesn't subscribe the caller, and an effect or memo `setup` creates still tracks its own reads.

A rejection disposes the runtime built so far, which ends every resumed action with its held wait unsent. A failure from the tree's seed check or the table load is the `SnapshotRejectedError`'s `cause`. Any other rejection, an option `createRuntime` refuses or a throw from `setup`, rejects as itself, since a fresh boot would hit it too and it is no reason to discard the save.

The state type comes from a typed `setup`; a restore without one names it, `restoreRuntime<IPlatform>(json, { rootId, options })`. A test restores with [`restoreTestRuntime`](./testing.md#testing-a-restore).

It resolves to `{ runtime, result }`, `result` an `IRestoreOutcome`, which is the `IRestoreResult` the repair receives plus the repair's error:

```ts
import type { IDropReason } from "treflex/snapshot";

interface IRestoreResult {
    resumed: IRestoreResumed[];                   // empty without resume (below)
    dropped: {                                    // the rest of the in-flight list
        actionId: string;
        name: string | null;
        label: string | null;
        receiver?: string;
        entityId: string;
        state?: "holding" | "open" | "regaining" | "queued" | "stopping";  // absent from a save of treflex 0.2.0 or format 7
        place?: number;                           // on "queued" and "regaining"
        reason: IDropReason;                      // "resume-off" without resume
        detail?: string;
        wait?: string;                            // on "not-idempotent"
    }[];
    unresolved: { ownerId: string; key: string | null; receiverId: string }[];  // a binding's key is null
    sweptOrphanedRows: number;
    savedBuild: string | null;
    sameBuild: boolean;
}

type IRestoreOutcome = IRestoreResult & { repairError?: unknown };
```

`resumed`, `reason`, `detail` and `wait` are [resume](#what-a-restore-reports)'s.

An unresolved binding or row stays and delivers nothing until its receiver registers; an app that won't register it unbinds the entity or retracts the row.

**`name` is the key:** the action's durable name, or `null` for an action without one. Match on it. **`label` is a label, never a key.** It is the function's own `name` as the writing build spelled it, or `null` for an anonymous function. Use it in a log or a devtools panel, never as something to match on or show a person. A delivery's entry carries its receiver's id as `receiver`, and no name. An entry with neither a name nor a receiver can be recognised only by its entity.

**`state` says what redoing the work would mean.** Work that was `"queued"` ran nothing, so dispatching it again does it exactly once. A dropped entry carries no arguments, so a repair that dispatches it again takes them from state. Work that was queued is not always work the runtime would have run: a timer tick or a delivery that stopped being wanted while it waited, such as a tick whose timer the action holding the entity stopped, is dropped when its turn comes. So a repair redoes queued work only if the state still calls for it. Work that had started, `"holding"`, `"open"` or `"regaining"`, may have written part of what it does before the cut. Work that was `"stopping"` was already being ended by the app, by a `latest` replacement, so a repair leaves it. `place` orders an entity's waiting work as the runtime would have let it in. A save of treflex 0.2.0 or format 7 gives no `state`, so treat its entries as started.

**Loading a save into a running app** takes a new runtime from `restoreRuntime`, the views mounted again on it, and the old runtime disposed. Component state lives in the runtime and is never saved, so the remount starts it from its factories. In React, key the provider with something that changes per runtime, such as a load counter; in Solid, dispose the render root and render again. Anything that holds the old runtime, a save handler say, moves to the new one. A rejection here means keep the current runtime.

### The repair

`repair(runtime, result)` is for an app that must react to a restore, announce it or re-authenticate, before any live source reconnects. It runs after `setup` with every resource paused: methods and supplies resolve `undefined`, and cells read `pending` with `Waiting: "paused"`. When its promise settles, the [resumed](#resume) actions' held waits are sent and then resources are set up, and `restoreRuntime` resolves after that. A repair that throws doesn't reject the restore: its error rides the result as `repairError`, and the waits are sent and resources set up regardless.

The repair is for the app's own state. Outside-world work after a restore, re-subscribing or telling a server the client is back, belongs in the resource type's setup, which runs at every reopen, or in the receiver handling its first message. Closes belong in the repair's action or a receiver's first step.

### Resources after a restore

Every resource reopens. A type works out what reopening means from its row, the owner's restored state and `r.resumeFrom`: a stream resumes from its cursor, an upload type reopens empty. Without a repair, every row is set up on the manager's first drain after `setup`, and a row whose type or receiver is missing waits until it registers.

### Recovering after a restore

**`dropped` is the recovery hook.** Each entry names the action and its entity. An app either re-derives the work from the restored tree, or has the feature that owned it say what the interruption meant, in its own words. A resource's own work isn't in `dropped`. With resume on, re-deriving from the tree alone can do again what a resumed action is doing ([upgrading a repair](#upgrading-a-repair)).

Its `state` lets a repair redo work that never started and report work that did. The repair's action starts each piece of work rather than waiting for it, so a slow save holds up neither the restore nor the resources:

```ts
import { start } from "treflex";
import type { IRestoreDrop } from "treflex/snapshot";

export function* redoSaves(_draft: IPlatform, dropped: IRestoreDrop[]): IActionGenerator {
    for (const entry of dropped) {
        if (entry.name !== "Editor/Save" || entry.state === "stopping") continue;
        if (entry.state === "queued") yield* start(saveDocument, entry.entityId);
        else yield* start(saveInterrupted, entry.entityId);
    }
}

export function restoreRedoingQueued(saved: string, seed: IPlatform) {
    return restoreRuntime(saved, {
        rootId: seed.$Id,
        options: savingOptions,
        setup,
        repair: (runtime, result) => runtime.dispatch(redoSaves, seed.$Id, result.dropped)
    });
}
```

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

**A test checks the recovery at every point a reload could land** with [`differentialRestore`](./testing.md#testing-every-restore-point). It restores a script's run wherever work was in flight, through the app's own `setup` and repair, and reports each point that ends differently from the run that wasn't interrupted.

### Resume

Resume is experimental: its surface may change in a minor version. It brings an in-flight action back to the wait a snapshot caught it at. The restore runs the action's code again from its start, on its real draft, answering each yield from what the save recorded, and stops at that wait, which it sends again once the repair has settled. Anything it can't run again exactly drops, as every in-flight action drops without resume. It takes three things: the [`resumable`](./actions.md#the-resumable-mark) mark on the action, the [`resume`](./runtime.md#options) option on the runtime that saves and on the one that restores, and the same [`build`](./runtime.md#build) on both, so a save from another build never resumes. The [repair](#the-repair) stays: resume changes how often it has work, never whether it is needed.

#### The option

**`resume: true`, or `{ budget, total }`; `false` leaves it off.** `budget` is the bytes of one action's history as JSON, 64KB by default, and `total` the bytes across one snapshot's histories, 512KB by default; each given must be a positive finite number, or `createRuntime` throws `TypeError`. A history past its budget is left out of the save and no longer kept, and so is the largest past the total, then the next, until the rest fit. A history also stops being kept past 10,000 entries. A restore drops such a run with `over-budget`, and [`resume/over-budget`](./troubleshooting.md#resumeover-budget) reports it when it happens.

**What it costs.** The runtime taps the records it needs from its construction, so every action of a runtime with `resume` on makes its `action:start`, `step`, `effect`, `response` and `action:end` records, its arguments copied into its start, with [`Landing`](#where-a-write-landed) on every step change, and every tap of those kinds hears them. Keeping a history is paid only while a marked action is in flight, and with none in flight a save is byte for byte the one a runtime without the option writes. Without the option a mark does nothing and no history is kept.

#### What a save holds with resume

Wherever the app keeps its saves, they hold more than state with `resume` on:

- **each in-flight marked action's arguments,** and the answer each of its yields received;
- **both sides of every change on its entity and below it while it is in flight,** its own and every other writer's, so a value written and later deleted there is in each save until the action ends;
- **what in-flight work the in-flight list doesn't name was doing** on its entity, above it and below it.

[`redact`](./effects.md#options) keeps an effect's descriptor and answer out, and an action that waited on a redacted effect drops. It covers effects, not an action's arguments or its writes to state. Pass an action a handle to a secret, such as a key into a runtime service, never the secret. Where no handle fits, [`redactArgs`](./actions.md#the-redactargs-mark) keeps an action's arguments out.

#### What is resumable

An action resumes only when everything in its history is on this list, and drops otherwise.

- **Its steps** read and write its draft and the entities below it, may catch a refusal of [the tree rule](./state-tree.md#the-tree-rule) or `DraftInsideOpenError`, and may read `inFlight` and `external`. They are deterministic, as [every action's are](./effects.md#non-determinism): a replayed step whose writes or read answers differ from the recorded ones drops the action with `diverged`, and a difference that reaches only a local is not seen until a later write.
- **The waits answered before the save,** inside `open(...)` or not: a plain effect that resolved or rejected, an effect that settles in the step, such as `generateGuid` and those inside `reconcileRows`, and `ask`, `answer`, `publish`, `publishToNearest`, `startTimer` and `stopTimer`, which are answered from the save and not run again.
- **The wait the save caught:** an `ask`, which asks again under a new id since no ask is saved, or an effect of an [`idempotent`](./effects.md#options) type, which is sent again.
- **What it was doing:** holding its entity, waiting inside `open(...)`, or arrived and not started in a line whose holder resumed and whose rows ahead of it came back, which is put back in its place. It may have been resumed before.
- **Other writers' changes** to its entity and below it while it waited, and a resource's delivery in flight beside it.

Off the list, and so dropped: a child made with `entity()`; `start`, `parallel`, `parallelSettled` or a resource operation; a redacted or `returns: "module"` effect; any other kind of caught wait; an action the runtime had stopped, or one in the line to take its hold back; arguments with an `undefined` before a set argument; and an entity the restored tree doesn't hold. These drop with `off-list`, or the reason the table below gives. Found only when the step runs again, and so dropped with `diverged`: any other read in a step (`select`, `getData`, `getDataGlobal`, `getDataPath`, `transient`, `pendingAsks`); `runtime.dispatch` from step code; an entity another writer moved out of the action's entity; and an entity another writer took out of it, by moving it elsewhere or deleting it, and put back while the action waited. An action whose entity, or anything below it, `setup` changed drops with `diverged` too, before it runs again. A live run of the action's own function on its entity when the restore runs, such as one `setup` dispatched, drops the saved run, marked or not: with `diverged` when it would run again, and with `off-list` when it stood in a line. Only one action is run again across an entity, its ancestors and its descendants, the first the in-flight list gives, and the others there that would run again drop. Work that is in neither the in-flight list nor a resource's delivery, holding the entity, an ancestor or a descendant or standing in its line, drops every action there with `unlisted`.

#### What a restore reports

`result.resumed` lists each in-flight action that came back, and `result.dropped` the rest: each in-flight action is in exactly one of them.

```ts
interface IRestoreResumed {
    actionId: string;                                  // its id in the save
    name: string;
    entityId: string;
    wait?: string;                                     // the Type of the wait it is parked on; absent when put back in a line
    resourceWork: { key: string; ownerId: string }[];
}
```

A dropped entry's **`reason` is a key** to match on, from an open set, so a match keeps a default: a new reason can arrive in a minor version. **`detail` is text for a log**; nothing should match on it.

| `reason` | The action |
|---|---|
| `"not-marked"` | Has no `resumable` mark, or is a delivery |
| `"resume-off"` | Was restored by a runtime without `resume` |
| `"other-build"` | Is in a save whose `sameBuild` is `false`: from another build, or the save or the restoring runtime has none |
| `"no-history"` | Has no usable history in the save: none was kept, it wasn't kept whole, or it can't be read |
| `"over-budget"` | Passed a [budget](#the-option) before the save |
| `"unknown-name"` | Has a name no one function in this build carries: its module hasn't loaded, or two claim it. An action in a code-split chunk resumes only if the app imports the chunk before it calls `restoreRuntime` |
| `"not-idempotent"` | Was caught at a wait whose type isn't declared `idempotent`, which `wait` names |
| `"behind"` | Stood in a line behind work that didn't come back |
| `"unlisted"` | Had work the in-flight list can't name on its entity, an ancestor or a descendant |
| `"watched"` | Would have run while a reactive scope watched the tree ([a watched tree](#a-watched-tree)) |
| `"off-list"` | Did something else [off the list](#what-is-resumable) that the save shows, or stood in a line on an entity a live run of its function is on |
| `"diverged"` | Ran again and didn't do what the save recorded, did something off the list that only running again shows, such as a `select` or a dispatch from step code, has a history the restore couldn't apply again, such as another writer taking an entity out of its entity, would run again on an entity a live run of its function is on, or on one `setup` changed |

- **A drop is data, not a diag.** A drop is the designed outcome for anything off the list. In development, [`resume/never-resumes`](./troubleshooting.md#resumenever-resumes) reports once per action name a marked action dropped for what it does itself.
- **A resumed action may carry on beside dropped work** on its entity, an ancestor or a descendant, which can leave its entity as neither run would. A repair finds that work in `dropped` by `entityId`.
- **`resourceWork` names each resource with a delivery in flight** on its entity, an ancestor or a descendant when the save was written. It is for a log: the reopened resource does that work again as its type decides, the resumed action carries on from a tree that may hold part of the delivery's writes, and a repair can't stop either.
- **The resumed actions' starts are heard once the report is complete,** each before any other record of its action.
- **A resumed action's `action:start` record** carries `ResumedFrom`, its `actionId` in the save. A restored runtime numbers its actions afresh, so its own `ActionId` may differ, and may be one another action had in the save: match a resumed action by `ResumedFrom`.

#### The window before the release

From step 6 of [the restore](#the-restore-in-order) until the held waits are sent, `runtime.dispatch` and `processAction` reject two dispatches with `UnreleasedResumeError`, before the action starts:

- **one that would wait behind a resumed action's hold.** That action's wait isn't sent until the repair settles, so a repair that waited on it would never settle;
- **one of a function onto an entity where the restore resumed that function,** held or not. It would do the work a second time.

**A `start` of a function onto an entity where the restore resumed that function** throws `UnreleasedResumeError` into the action that started it, at its `yield* start(...)`, held or not, whichever action started it: the repair's own, one that action started, or any other. Nothing arrives, so a `leading` or `latest` mark on the function doesn't act and the resumed action carries on. Catch it there to go on without the second run; uncaught, it fails the starting action as any throw does.

The error's `actionName`, `actionId` and `entityId` name the resumed action, `actionId` as `result.resumed` gives it. Other work the window meets isn't refused: a timer's tick, a delivery, and a `start` of any other function line up as live work does, and run once the hold they wait behind ends. A resumed action parked inside `open(...)` holds nothing, so the repair writes its entity as any other writer does. With no repair the window closes before `restoreRuntime` resolves.

#### Upgrading a repair

Turning `resume` on changes what a repair's work means. A repair that reads the tree, finds a flow half done and starts it again doubles a flow that resumed. A repair acts on `dropped`, never on the tree alone: it restarts or reports what `dropped` lists, and leaves the entities in `resumed` to the actions running on them.

#### A watched tree

A replay rewinds an entity and runs its steps again, so a computation reading the tree would see the entity go back in time and could act on what it saw. When anything an app made reactive, an effect, a memo, or a view's memoized read of a selector, has read the tree, its index or an entity's `inFlight` before step 6, every action that would run again drops with `watched`, and a development build raises [`resume/tree-watched`](./troubleshooting.md#resumetree-watched). A computation counts once it has read, disposed or not; plain reads, `processSelector`, taps and diag listeners don't. Create effects and memos over the tree once `restoreRuntime` resolves, and mount the views on the runtime it resolves to. A queued action put back in its line runs nothing again, and is put back either way.

#### A development build id

A development server passes no `build`, so a runtime there with `resume` resumes nothing and raises [`resume/no-build`](./troubleshooting.md#resumeno-build). To resume there, give it an id that changes whenever the code does: a random value drawn when the server starts, joined to a count of the source changes it has watched since, served as a module the app imports and passes as `build`. A save made before an edit or a restart then carries another id and drops with `other-build`, and a reload with nothing between them resumes. It errs toward dropping, and a file the server doesn't watch can change with the id unchanged.

#### Two restores of one save

Each restore is a runtime of its own, and each sends its resumed actions' held waits. Two tabs restoring one save each resume the flow, each ask its open question again, and each send its caught request, so the server sees it twice; that is what `idempotent` promises the server tolerates, and an app that wants one tab to own a save settles that before restoring. Under React's strict mode a restore started from an effect runs twice in development, and both runs send the held waits: start the restore once, outside the components, as [the boot](#restoring) does.

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
- **A step's record arrives once the step has ended**, its writes judged by [the tree rule](./state-tree.md#the-tree-rule) and any refusal decided, and before the reactive effects its writes trigger run. So records arrive in the order the writes were made, work an effect dispatches included. The listener runs inside the step's host batch: a signal it writes, and a memo over that signal, read back the new value at once, and the effects they trigger run with the step's, after it returns. Work it dispatches starts before those effects, so where it and an effect write one field, the effect's write lands last; a dispatch on the entity the stepping action holds waits for the hold to end.
- **With `kinds`, a tap hears only those**, its records typed by them. Without, it hears every kind.
- **Records are owned data**: written values are copied when the record is made, so a tap can buffer them, send them across a boundary or keep them.
- **`live`, the second argument**, carries display material that is never in a record: an action's `result` or live `error` and `duration` on `action:end`, a settlement's `result` or `error` and `duration` on `response`, and the live `error` on `receiver:error`. For an implementation's rejection, a `response`'s `error` is the [copy](./effects.md#a-rejection-crosses-as-a-copy) the action was thrown, not what the implementation rejected with, and so is the action's `error` when it ended with that copy. A consumer that saves records drops it. A [redacted](./effects.md#options) settlement and an `r.run` action's result are withheld from it.
- **A tap's throw** loses only that call: the tap stays attached, the other taps and the runtime go on, and it is reported as [`runtime/callback-threw`](./troubleshooting.md#runtimecallback-threw).
- It returns the function that removes the tap.

#### What a kind costs

A kind is made only while some tap takes it. Subscribing is the switch: a runtime with no tap makes no records and copies no writes. An action samples its own kinds (`action:start`, `step`, `effect`, `response`, `branch:start`, `branch:end`, `action:end`) once, at its dispatch, so each kind of an action's trace is complete or absent, never partial: attach tools at construction for complete histories. `effect` and `response` are made together for a tap of either, since a response names its effect by `Seq`.

The dear kind is `step`, which copies every written value before and after. The copy is of the written value, not of the tree, so steady small writes are cheap and overwriting a large subtree dominates.

While no tap asks for [`Landing`](#where-a-write-landed), nothing is found or paid for it. While one asks, the runtime finds it for every recorded change. It is found by a walk down the change's path that reads each node's `$Id` and the next key, one step per key above the written one: none for a write into an entity's own field or a child entity's, six for a write six plain nodes below the acting entity. A write through a reference held across a move searches the step's writes instead. The step's searches together read each of its writes once, and a node moved to a new place before each search costs them work in proportion to its moves. Timed against the same do-nothing `step` tap not asking, a tap that asked took 34 to 61% longer on writes six plain nodes below the acting entity, 30 to 48% longer on writes through a reference held across a reorder, 16 to 29% longer on writes of the acting entity's own primitive fields, 2 to 19% longer on pushes and splices on an array of entities and 1 to 14% longer on a parent's writes into its child entities, and writes of large values took no measurable time more. `Landing` adds the entity's `$Id` and a path to each change, which made step records about a fifth to two fifths larger as JSON on the flows measured.

**Saving on change.** Only `AppState` is saved, and a record that can change saved state names its root as `Root`. An autosave counts the `step`, `table` and `entity:dispose` records whose `Root` is `"AppState"`. A step's `Root` is its action's, so a step that wrote only a transient of an `AppState` entity counts too; its `Changes` paths start with `TransientState`.

#### Record kinds

| Kind | One per | Carries |
|---|---|---|
| `action:start` | Action started | `ActionId`, `Name` (the [durable name](./actions.md#durable-names), or `null`), `Label` (the function's `name`, or `null`; a label, as for `dropped`), `Receiver` for a delivery, its receiver's id, `EntityId`, `Path` (the entity's `$Id` path at dispatch, its own last), `Args`, or `[]` with `ArgsRedacted: true` for an action marked [`redactArgs`](./actions.md#the-redactargs-mark), `StartedBy` for a started action, `Origin` (`{ Kind: "resource:deliver" \| "resource:run", Key, OwnerId }`) for a resource's, `ResumedFrom` for an action a restore [resumed](#what-a-restore-reports), its id in the save |
| `action:end` | Action ended | `ActionId`, `Status`: `completed`, `cancelled`, `errored`, or `dropped` for work that ran nothing, a `leading` repeat, or a delivery or tick that stopped being wanted while it queued |
| `step` | Step with writes | `ActionId`, `BranchId`, `Changes` (`{ Path, Prev, Value?, Deleted?, Created?, GrewFrom?, Landing? }`, both sides copies; `Deleted` when the write removed the key, `Created` when it added one, `GrewFrom` the array's length before a write that grew it; `Path` from the acting entity, or from `TransientState` for a transient's write, and [`Landing`](#where-a-write-landed), when asked for, the entity the write landed in); `Cancelling: true` for a close, one record for the whole close; `InFlightAnswers` when the step resumed from `inFlight` reads, and `ExternalAnswers` when it resumed from `external` reads ([an action's read](./derived-reads.md#an-actions-read)), either one even with no changes |
| `effect` | Effect yielded | `ActionId`, `BranchId`, `Type`, `Descriptor` (a copy of what was yielded, or `Type` only for a redacted type; a `start` of an action marked [`redactArgs`](./actions.md#the-redactargs-mark) carries `Args: []` and `ArgsRedacted: true`) |
| `response` | Settlement delivered to the fiber | `ForSeq` (the effect's `Seq`), and `Value` or `Error`. `Error` is the [serialized form](./failure.md#the-actionerror-payload) of what the action was thrown, or `{ Thrown: "redacted" }` for a [redacted](./effects.md#options) type; for an implementation's rejection, the action was thrown a copy [rebuilt](./effects.md#a-rejection-crosses-as-a-copy) from this same form. An effect with no response is still in flight, or was when its fiber was stopped |
| `branch:start`, `branch:end` | Branch of `parallel` or `parallelSettled` | `ActionId`, `BranchId`, `ParentBranchId`; on the end, `Status` and, when errored, the serialized `Error` |
| `table` | Change to a runtime table | `Table`: `"dataSources"`, `"timers"` or `"resources"` with `Key` and `OwnerId`, or `"asks"` with `AskId`; and the cell's `Prev` and `Value` (`null` for none) |
| `resource:supply` | Supply reaching the manager | `Key`, `OwnerId`; never the value |
| `message:deliver` | Publish, tick, or resource delivery | `Topic`, `PublisherId`, `RecipientIds`, `UnresolvedIds` ([`messaging.md`](./messaging.md#records)) |
| `receiver:error` | Delivery whose receiver threw | `Topic`, `RecipientId`, `PublisherId` |
| `entity:dispose` | Entity that left the tree | `EntityId`, `Path`; depth-first, after its cleanup |
| `ask:answer`, `ask:abandon` | Ask ended | `AskId`, `OwnerId`; on the abandon, `Reason`: `"disposed"` (the owner left) or `"cancelled"` (the asker stopped) |

A binding change is a `step` change at `$Receiver`. Every record carries `Seq`, `T` (`performance.now()`) and `Kind`. An action's records, `entity:dispose`, `resource:supply` and the data-source, timer and resource `table` records carry `Root`; ask and delivery records carry none, since nothing of theirs is saved.

#### Where a write landed

A change's `Path` is a position counted from the acting entity. Positions move: once a list is reordered, `Items.0.Score` names whichever row sits first, and a write through a [held reference](./actions.md#held-references) made after a move is recorded at the position the reference was taken at, which another node may hold. **`Landing`**, `{ EntityId, Path }` typed `IRecordLanding`, names where the write went instead: the nearest entity at or above the written place as the tree stood when the write was made, and the keys from that entity down to the place. To find what a write changed, look the entity up by `$Id` and follow `Landing.Path`, without knowing who acted. Read `Path` for where the acting entity reached; read `Landing` to attribute a write to an entity, or to save or rebuild by entity.

A tap asks for `Landing` with `landing: true` beside `kinds`, and only a tap that takes `step` asks:

```ts
import type { IRecordChange, IRuntime } from "treflex";

export function fileByEntity(runtime: IRuntime<object>, file: (changes: IRecordChange[]) => void): () => void {
    return runtime.on("record", (record) => file(record.Changes), { kinds: ["step"], landing: true });
}
```

While a tap asks, the changes of every step that begins then carry `Landing` where an entity holds the written place, for every tap and every [trace](#traces) ([what it costs](#what-a-kind-costs)). A step that begins while none asks has no `Landing` key on any change. The ask is read when a step begins, so a tap hears `Landing` from the first step that begins after it attaches, and a tap attached or removed by code a step runs doesn't change that step. A change with no `Landing` reads the same whether no entity holds the place or no tap was asking when its step began, so a tap that reads `Landing` is attached when the runtime is constructed, or in a restore's `setup`, as for [the kinds](#what-a-kind-costs). A runtime with [`resume`](#resume) on asks from its construction, so every tap's step changes carry `Landing` there.

- **A write into a child lands in the child:** a parent's write at `Items.0.Score` lands as `{ EntityId: <that row>, Path: ["Score"] }`, and one into a plain node inside it as `["Notes", "Text"]`.
- **An entity's own slot belongs to its parent.** Adding, replacing or removing a child, and setting `length`, land in the parent, as `["Items", "2"]`. A write into the added entity later in the same step lands in it.
- **Component state's root is an entity,** so its writes land in it. A transient's own fields are under no entity, so their changes carry no `Landing`; their `Path` starts `TransientState`, the owner's `$Id` and the name. A write there through a reference held across a reorder leaves a stale `Path` and nothing to correct it. An entity inside a transient is an entity like any other.
- **A write through a reference to a node the same step removed** (`draft/orphaned-write`) names the entity it went into, which a lookup no longer finds, or carries no `Landing` when no removed entity holds the node. A close's writes into an entity that has left name it the same way.
- **`Path` is no substitute for a missing `Landing`.** `Landing?.Path ?? Path` reads naturally and is wrong: for a plain node swapped by hand mid-step, `Path` names the position the reference was taken at, inside the entity the other node now sits in.
- **Replayed by `Landing`** onto `AppState`, a step's changes rebuild the tree after the step from the tree before it, and undone in reverse give the tree before back, setting each place to `Prev`, deleting a `Created` key and setting a grown array's length back to `GrewFrom`. A move is recorded as a removal and an addition carrying a copy, so the replay holds a copy of what moved. When a lookup by `$Id` finds the landing entity in more than one place, as after a step adds an entity before it removes it from where it was, apply the change at each. A replayer skips a change whose entity a lookup doesn't find at that point, and one with no `Landing`. An entity inside a transient or in component state is one a lookup in `AppState` doesn't find, so its changes are skipped the same way.
- **A node written while it sits in no place,** as when it is taken out, written, and put back elsewhere, is reproduced by that skipping: an entity's change names an entity a lookup doesn't find at that point, and a plain node's change has no `Landing`. Skipping the change is right, because the change that puts the node back carries a copy that already has the write.
- **A step that writes a plain node while it sits in two places is not reproduced** by replaying its changes, as when a move adds the node before it removes it: `to.Note = note; note.Text = "x"; from.Note = other`. `Landing` names the reference's own route when its `Path` still reaches the node, and otherwise the place the node was put most recently. The replay writes into the copy at the place `Landing` names, so the forward replay fails when the step keeps the place `Landing` didn't name, and the undo fails when a place `Landing` didn't name held the node before the step.

The record doesn't mark a plain node written in two places, and a reader can't detect one.

#### Traces

`createTraceAggregator(runtime, onTrace)` rebuilds one `IActionTrace` per action from the stream, `{ actionId, name, label, args, argsRedacted?, entityId, entries, duration, error?, cancelled?, dropped? }`, `name`, `label` and `argsRedacted` the `action:start` record's `Name`, `Label` and `ArgsRedacted`, its entries the steps in order and each effect when it settles. A step entry is `{ type: "step", branchId, changes, inFlightAnswers?, externalAnswers? }`, `changes` the step record's `Changes`, [`Landing`](#where-a-write-landed) as the record has it; an effect entry is `{ type: "effect", branchId, effect, duration }` with `result` or `error`. An effect still open when the action ended is appended last, with `aborted: true`. It ignores records of actions it didn't see start, so attaching mid-action is clean. It taps every kind, `step` included ([what a kind costs](#what-a-kind-costs)). It returns the function that stops it.

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
- **A format 7 envelope's dropped entries** have no names, so a repair that matches on names finds none of them.
- **A repair still unsettled 3 seconds after the load** raises [`resource/still-paused`](./troubleshooting.md#resourcestill-paused).
- **A close made later than the repair's action or a receiver's first step** costs one brief reconnect.
- **A tap of `step` without `action:start`** gets steps whose action it never saw.
- **A tap handler doesn't read the runtime's tables** to learn about a record: a `table` record arrives after its change, and an `entity:dispose` after the cleanup, when `runtime.timers(id)` and `runtime.resources(id)` hold nothing of the entity. A tool that needs what an entity held keeps its own copy from earlier records.
- **While any tap is attached,** an action also checks that each write through a held reference lands where its record's `Path` says, and warns `draft/stale-path-write` or `draft/orphaned-write` on the console when it doesn't ([`troubleshooting.md`](./troubleshooting.md#console-warnings), [where a write landed](#where-a-write-landed)).
- **With `parallel` branches, a trace's effect yielded early and settled late** comes after later steps, since each effect is entered when it settles.
