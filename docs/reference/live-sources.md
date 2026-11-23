# Live sources

Things that deliver over time: **resources**, the one way treflex holds anything live, and **timers**, recurring work whose publisher is the clock.

## Usage

The guide teaches a poll timer and a push stream in [7. Resources and timers](../guide/07-live-sources.md).

### Resources

A resource is something live outside the state tree that an entity owns: a stream, a socket, a worker, an object URL, a set of picked files.

- An action **opens** it with `openResource`, which writes a plain-data **row**. The row is the intent. It is recorded, closed, replaced, and saved in a snapshot.
- The runtime's **resource manager** sets up a live **instance** from the row, with the implementation registered for the row's **type**.
- The instance reaches the rest of treflex through a small surface: it **emits** messages to the owner's receiver, answers **methods** called from actions, **exposes** one live value to views, and takes live values **supplied** by views.

Live values never reach actions or state: they cross only between a resource and a view. A resource is identified by `(owner, key)`, so several of one kind are one child entity each.

### A stream

`IResourceTypeRegistry` declares what each type takes and produces; `IResourceRegistry` declares each key and its type.

```ts
import type { IActionGenerator, IEntity, IReceiverId } from "treflex";

interface IEvent {
    Seq: number;
    Text: string;
}

declare module "treflex" {
    interface IResourceTypeRegistry {
        sse: { Params: { Endpoint: string }; Message: { Events: IEvent[] } };
    }
    interface IResourceRegistry {
        "Feed/Events": { Type: "sse" };
    }
    interface ITimerRegistry {
        "Feed/Reconnect": {};
    }
}
```

`runtime.registerResourceType(type, implementation, options?)` registers a type. The implementation is called with a copy of the row's params and the surface `r` ([the surface](#the-surface)). This one emits what arrives, reports a reconnect as status, and ends when the server refuses the stream:

```ts
import type { IRuntime } from "treflex";

export function registerTypes(runtime: IRuntime<object>): void {
    runtime.registerResourceType("sse", (params, r) => {
        const source = new EventSource(params.Endpoint);
        source.onopen = () => r.status();
        source.onerror = () => {
            if (source.readyState === EventSource.CLOSED) r.end("refused");
            else r.status("retrying");
        };
        source.onmessage = (event) => {
            void r.emit(JSON.parse(event.data));
        };
        r.signal.addEventListener("abort", () => source.close());
    });
}
```

Register types beside receivers, at startup.

### Opening

`openResource(entity, key, receiver, params)` opens a key that emits. The receiver's case for the key hears each message, and an `$Ended` notice when the instance ends, told apart with `isEnded(e)`:

```ts
import { isEnded, openResource, receiver, startTimer, stopTimer } from "treflex";

interface IFeed extends IEntity {
    readonly $Receiver?: IReceiverId<IFeed>;
    Retries: number;
    Events: IEvent[];
}

function* openEvents(draft: IFeed): IActionGenerator {
    yield* openResource(draft, "Feed/Events", FeedReceiver, { Type: "sse", Endpoint: "/feed/events" });
}

function* reopenLater(draft: IFeed): IActionGenerator {
    draft.Retries++;
    yield* startTimer(draft, "Feed/Reconnect", FeedReceiver, Math.min(30_000, 500 * 2 ** draft.Retries));
}

export const FeedReceiver = receiver<IFeed>("FeedReceiver")({
    *"Feed/Events"(draft, e) {
        if (isEnded(e)) {
            yield* reopenLater(draft);
            return;
        }
        draft.Retries = 0;
        draft.Events.push(...e.Events);
    },
    *"Feed/Reconnect"(draft) {
        yield* stopTimer(draft, "Feed/Reconnect");
        yield* openEvents(draft);
    }
});
```

**Back off before reopening** wherever an ending can repeat: wait on a [timer row](#timers), as above.

### Closing

**Close a resource where the thing that ends it is handled.** When that thing is its owner leaving, the removal is the close and nothing else is written. Otherwise, sign-out or a cancel say, write `closeResource(entity, key)` there. The dispose cascade is the backstop: a resource never outlives its owner. Don't make an entity only so its removal closes a resource: when the end is some other event, write `closeResource` there. A resource that lives exactly as long as one component shows it, such as a subscription only that view reads, is owned by the component's state: the unmount is the thing that ends it, and [component state](./views.md#component-states-lifetime) is that lifetime in the tree.

### Timers

**A timer is a message to self whose publisher is the clock.** It is one row of owner, receiver, key, interval and payload. Each tick dispatches the row's receiver on the owner as a new action. Between ticks nothing runs. Recurring work is a timer row, never an action looping on a delay effect: an action is a finite transition, and a loop holds a generator open for the entity's whole life.

```ts
declare module "treflex" {
    interface ITimerRegistry {
        "Clock/Tick": { Label: string };
    }
}

interface IClock extends IEntity {
    readonly $Receiver?: IReceiverId<IClock>;
    Ticks: number;
}

export const ClockReceiver = receiver<IClock>("ClockReceiver")({
    *"Clock/Tick"(draft, tick) {
        draft.Ticks++;
        if (tick.Label === "once") yield* stopTimer(draft, "Clock/Tick");
    }
});

export function* startClock(draft: IClock): IActionGenerator {
    yield* startTimer(draft, "Clock/Tick", ClockReceiver, 1_000, { Label: "every second" });
}
```

- **`startTimer(entity, key, receiver, intervalMs, payload?)`** writes one `(key, entity)` row. Starting it again with another interval, receiver or payload replaces the row and restarts the interval, which is how an interval changes; starting it again with the same row changes nothing, and the running interval stands. `payload` is required only when the key declares fields. A timer key is in `ITimerRegistry`, not `IMessageRegistry`, so nothing can publish it.
- **`stopTimer(entity, key)`** removes the row. The owner leaving removes every row it started.

**Measure elapsed time with a deadline, never a tick count.** A countdown, a hold or an expiry stores its deadline in state, read from a clock effect the app declares `settles: "sync"` ([sync effects](./effects.md#sync-effects)), and its timer ticks only to check whether the deadline has passed. Counting ticks loses time whenever the tab is suspended or reloaded. A view that redraws as time passes, such as a countdown's display, reads a [display clock](./derived-reads.md#an-outside-value-or-the-tree), not a timer.

## Rules

### Choosing a resource

| Need | Use |
|---|---|
| Something live that outlives one effect call | A resource |
| One-shot I/O, even "fetch, make a URL, download, revoke" inside one implementation | An [effect](./effects.md) |
| A value from outside the tree that selectors derive from, whose change starts no work and that a restore should read fresh | An [outside value](./derived-reads.md#an-outside-value-or-the-tree) |

| Case | Shape |
|---|---|
| A stream | Open it with a receiver; the type emits |
| A URL a view shows | The type exposes it |
| A worker the app asks things | The type answers methods |
| A file from a picker | A view supplies it; methods use it |

The row is `{ Key, OwnerId, Params, ReceiverId, ResumeFrom }`.

### Registries

The other shapes, declared beside the stream above:

```ts
declare module "treflex" {
    interface IResourceTypeRegistry {
        blob: { Params: { Url: string }; Value: string };
        worker: { Params: { Script: string }; Methods: { render(points: number[]): string } };
        picker: { Supply: readonly File[]; SupplyResponse: { Id: string; Name: string }[]; Methods: { upload(id: string): string } };
    }
    interface IResourceRegistry {
        "Viewer/Preview": { Type: "blob" };
        "Chart/Worker": { Type: "worker" };
        "Upload/Files": { Type: "picker" };
    }
}
```

| Type field | Declares | Omitted |
|---|---|---|
| `Params` | Settings handed to the implementation, beside `Type` | `{}` |
| `Message` | What it emits | `never` |
| `Value` | What it exposes | `never` |
| `Methods` | Named methods, with plain-data arguments and results | `never` |
| `Supply`, `SupplyResponse` | The live value a view supplies, and the plain data that comes back | `never` |
| `ResumeFrom: "required"` | It can't work without a cursor, so every open names one | optional |

A key's entry names its `Type`, and may refine it: its `Params` are intersected with the type's, which is where identity inputs the generic type never reads go, and its `Message` replaces the type's.

**Params are plain data, carry `Type`, and carry no credentials**, since rows are recorded and saved. The compiler checks `Type` against the key's type, and an open whose params aren't a plain object with a string `Type` throws a `TreflexRefusal`.

**The message rule.** A message is spread into the receiver's argument beside `Type`, so `Message` must be a plain, non-array object with no `Type` field and no top-level `$`-prefixed field. A key whose `Message` breaks it can't be opened: its params argument is typed `{ $MessageMustBePlainObjectWithoutType: K }`, so every open fails to compile. `unknown` and `never` are exempt. Wrap anything else, `{ Event: wire }`.

**Receivers.** A key that emits joins the receiver cases, and its case receives `{ Type: key, ...Message }` or the end notice `{ Type: key, $Ended: { Reason, Error? } }`, told apart with `isEnded(e)`. A key whose type never emits takes a receiver only to hear `$Ended`. A key whose `Message` is `never` over a type that emits takes no receiver.

Functions that open a resource and the receiver that reopens it refer to each other, so they declare their return type, as `openEvents` and `reopenLater` do; without it the cycle doesn't compile.

### Implementing a type

```ts
export function registerOtherTypes(runtime: IRuntime<object>): void {
    runtime.registerResourceType("blob", async (params, r) => {
        const response = await fetch(params.Url, { signal: r.signal });
        r.expose(URL.createObjectURL(await response.blob()), (url) => URL.revokeObjectURL(url));
    });

    runtime.registerResourceType("worker", (params, r) => {
        const worker = new Worker(params.Script);
        r.signal.addEventListener("abort", () => worker.terminate());
        r.methods({
            render: (ctx, points) => callWorker(worker, points, ctx.signal)
        });
    });
}
```

The one option, `{ endOnReceiverFailure: true }`, is under [emit](#emit).

### What an open checks

`openResource(entity, key, ...rest)` takes its arguments by what the key declares: `(receiver, params, options?)` for a key that emits, `(params, options?)` for one that takes no receiver, and either form for a type that never emits. `options` is `{ ResumeFrom }`, required when the type declares `ResumeFrom: "required"`.

- **An equal open is a no-op** while the instance is live or being set up, so an opener that runs again can't stack instances. Equal means the same `Params`, `ReceiverId` and `ResumeFrom`. An equal open with no current instance, none yet or ended, sets one up.
- **Any difference replaces.** The old instance retires as `"replaced"` and the new one is set up after the old one's abort. Whatever the old instance held goes with it, supplied values included.
- **The identity rule.** Put every non-secret input whose change must force a reconnect, such as the signed-in user's id, in `Params`. An input left out can't cause one. An opener whose identity changes also resets the `ResumeFrom` field in the same step, so the new stream doesn't resume from the old one's cursor.
- **The owner must be in the tree.** `openResource` on an entity the tree doesn't hold throws `EntityGoneError` before any row is written. Any entity can own one, in a transient or component state as in `AppState`, and only an `AppState` owner's rows are saved.
- **`ResumeFrom` names a top-level scalar field of the owner**, read when an instance is set up and handed over as `r.resumeFrom`. The receiver applies what arrives and then stores the cursor, so the field always names what state has applied.
- **An unregistered type** isn't refused: the row is recorded, the status is pending, [`resource/unregistered-type`](./troubleshooting.md#resourceunregistered-type) fires, and the instance is set up when the type registers. **A missing receiver** waits the same way, with [`receiver/unresolved`](./troubleshooting.md#receiverunresolved).
- **Re-registering a type**, as a hot reload does, replaces every instance of it.

Each row change lands a `table` record with `Table: "resources"`.

### The surface

| Member | |
|---|---|
| `r.emit(message)` | Queues a message for the owner's receiver. Resolves once queued, never on delivery |
| `r.onIdle(callback)` | Calls back once, from the manager's drain, when none of the instance's messages is queued or being delivered |
| `r.methods(handlers)` | Registers the type's methods. During setup only |
| `r.onSupply(handler)` | Registers the supply handler. During setup only |
| `r.expose(value, release?)` | Sets the cell's one live value |
| `r.run(effect)` | Runs an effect generator as an action on the owner |
| `r.status(detail?)` | A display detail on `"live"`, such as `"retrying"`; no argument clears it. Called during setup it applies when setup returns; after, from the manager's next drain, so a status read in the same tick still shows the old one |
| `r.resumeFrom` | The owner's `ResumeFrom` field at setup, or `undefined` |
| `r.end(reason?)` | Ends this instance, with `reason` or `"ended"` |
| `r.signal` | Aborts when the instance retires, its reason an `AbortError` naming the retirement ([below](#ending)) |
| `r.ownerId`, `r.key` | The cell |

**Setup** is the synchronous part of the implementation, up to its first `await` or its return. `r.methods` or `r.onSupply` after it throws an error whose `name` is `"ResourceSetupError"`. The cell reads `live` once setup returns with the instance still current; a type still connecting says so with `r.status`.

### Ending

An instance **ends by itself** four ways: `r.end(reason?)`, a rejection of the implementation's promise, a throw from setup, or a throw from an `onIdle` callback. The last three also raise [`resource/ended`](./troubleshooting.md#resourceended), and end it with `Reason: "failed"` and the throw serialized as `Error`. Any other return means nothing, and the manager never restarts an instance: a type owns its own retries.

**An ending flushes, notifies, then retracts.** Emits queued before the end are delivered in order. Then a receiver, if the row has one, gets `{ Type: key, $Ended: { Reason, Error? } }`. When that has settled, the row is removed. A type's own end reasons are its contract with its receivers; leave `"failed"` to the runtime. The instance itself is retired as `"ended"` straight away: its `r.signal` aborts, with `message` `"ended"` whatever `Reason` the `$Ended` carries, on the manager's drain, not inside `r.end`.

**The app acting during an ending wins.** An open, reopen or close of the key before the `$Ended` delivery settles, the `$Ended` case's own included, stands: the ending removes nothing, its remaining emits are dropped, and an `$Ended` not yet sent isn't. An equal reopen from the `$Ended` case sets up a new instance, which is how a receiver reconnects. Waiting on a timer row before reopening, as the stream above does, settles the delivery at once and survives a restart. Whatever closes the resource stops that timer in the same place.

**Every other retirement** is the app's doing and sends no `$Ended`: close (`"closed"`), replace (`"replaced"`) and the owner leaving (`"disposed"`). It drops the queue, and deliveries already waiting behind a hold on the owner end `dropped`, unrun. A retired instance is dead: `emit`, `onIdle`, `status` and `end` do nothing, `expose` releases its value at once, and `run` rejects. `r.signal` aborts with an `AbortError` whose `message` is the reason, so `fetch(url, { signal: r.signal })` and an `error.name === "AbortError"` check behave as anywhere else. A method's `ctx.signal` and a rejected `run` carry the same error object.

### Status

The manager keeps a status per cell, for display. App logic learns of an end from `$Ended`, not from status.

| `State` | When |
|---|---|
| `"none"` | No row, and no end kept |
| `"pending"` | `Waiting` says on what: `"setup"`, `"paused"`, `"type"` or `"receiver"` |
| `"live"` | Setup returned with the instance current, with the type's `Detail` if it set one |
| `"ended"` | With `Reason` and `Error`, kept after the row is removed, until a reopen, a close or the owner leaving |

### Emit

- **Checked, copied and frozen in one walk**, in every build. A message that isn't plain data all the way down, is an array, or carries `Type` or a top-level `$`-prefixed field isn't delivered, and [`resource/invalid-message`](./troubleshooting.md#resourceinvalid-message) fires.
- **Delivered from the manager's drain**, never inside `r.emit`, as a new action on the owner whose `action:start` carries `Origin: { Kind: "resource:deliver", Key, OwnerId }`. A key opened without a receiver delivers nothing.
- **Queued behind a hold**, like any dispatch: it waits while an action [holds](./actions.md#holds) the owner.
- **One at a time per cell.** Delivery N+1 starts after N settles, so every later delivery waits on the current one. The queue isn't bounded.
- **An accepted message is delivered, or its instance retires first.** A type keeps its own cursor, advanced as each emit is accepted, and reconnects within the instance from it. The owner's `ResumeFrom` field lags it while deliveries queue, and is what a new instance reads. A receiver for a resumable type still skips what it has applied.
- **A receiver that throws** fails that delivery's action, routed like any failure ([`failure.md`](./failure.md#the-route)), and the next message is delivered. A type registered with `{ endOnReceiverFailure: true }` ends instead, with `"receiver-failed"`, dropping what was queued behind it: the right policy for a resumable stream, whose receiver would fail the same batch on every reconnect.
- **Batch with `r.onIdle`.** A type that can't pause its source accumulates what arrives, registers the callback with the first item of a batch, and emits the batch from it, so a receiver kept waiting by a hold gets one message for everything that arrived meanwhile. A method never waits on `onIdle`.
- **A replacement waits** for its cell's delivery in progress before its setup runs, so the owner's cursor reflects everything delivered.

**Receivers stay quick.** A receiver that calls a resource method, or asks, waits inside the delivery and holds up every later one: [`resource/receiver-waiting`](./troubleshooting.md#resourcereceiver-waiting) names it. Do that work in an action the receiver starts with `yield* start(...)` ([`actions.md`](./actions.md#start)).

### Methods

```ts
import { resource } from "treflex";

interface IChart extends IEntity {
    Points: number[];
    Svg: string;
}

export function* draw(draft: IChart): IActionGenerator {
    const svg = yield* resource(draft, "Chart/Worker").render(draft.Points);
    if (svg === undefined) return;      // nothing could answer
    draft.Svg = svg;
}
```

- **Any owner.** `resource(owner, key)` takes any entity or `$Id`, so a child calls a resource its parent owns by keeping the parent's id on the child.
- **A call doesn't queue behind the owner's hold.** It runs as part of the calling action, and its `ctx.signal` aborts when that action is stopped, so removing the calling child cancels its call.
- **A call waits** until the handler settles. Calls made during setup wait for it.
- **Arguments and results are plain data**, copied. A non-plain argument throws `NonPlainDataError` and nothing is sent; so does a non-plain result.
- **A handler's throw reaches the caller as a copy** of its native error type, as an effect's rejection does ([effects](./effects.md#a-rejection-crosses-as-a-copy)), unless the instance retired first. A failure the caller branches on is part of the method's result.
- **A call resolves `undefined` when nothing can answer**: no row, a type or receiver not registered, a restore's [repair pause](./restart-and-records.md#the-repair), an instance that retired or ended before answering, or a method the type didn't register. With no row it raises [`resource/not-open`](./troubleshooting.md#resourcenot-open), on an ended cell [`resource/used-after-end`](./troubleshooting.md#resourceused-after-end), and for an unregistered method [`resource/unknown-method`](./troubleshooting.md#resourceunknown-method).
- **Calls can run at once.** A type that must not do one piece of work twice keeps an in-flight map and hands a second caller the first promise. Shared work runs on `r.signal`, never on one caller's `ctx.signal`, which aborts when the instance retires or the calling fiber is [stopped](./fibers.md#stopping).

### Supply and expose

A view reaches a resource with `useResource(owner, key)`, from `treflex-solid` or `treflex-react`. The owner is an entity, an `$Id`, or a function returning either or `undefined`. In Solid it answers accessors, `value()` and `status()`; in React, values, re-rendering on change. Both answer `supply(value)`.

```tsx
import { useDispatch, useResource } from "treflex-solid";

interface IDialog extends IEntity {
    Picked: { Id: string; Name: string }[];
}

function* attach(draft: IDialog, picked: { Id: string; Name: string }[]): IActionGenerator {
    draft.Picked.push(...picked);
}

export function Picker(props: { dialog: IDialog }) {
    const files = useResource(() => props.dialog, "Upload/Files");
    const dispatch = useDispatch();
    return (
        <input
            type="file"
            multiple
            disabled={files.status().State !== "live"}
            onChange={async (event) => {
                const picked = await files.supply(Array.from(event.currentTarget.files ?? []));
                if (picked) void dispatch(attach, props.dialog, picked);
            }}
        />
    );
}
```

**Supply** hands a live value to the type's `onSupply` handler, from the manager's drain, never inside the call. The value is passed as it is: never copied, recorded or put in state. The handler's answer is checked and copied as plain data, and a throw from the handler rejects the supply. A supply made during setup waits for it. `runtime.supplyResource(owner, key, value)` does the same from outside a view. Supply carries live values and at most a correlation tag; commands go through actions and methods.

A supply nothing takes resolves `undefined` and raises [`resource/supply-dropped`](./troubleshooting.md#resourcesupply-dropped): no owner, no row, a pause, no live instance, an instance retired before setup, or no `onSupply`. A screen with a picker opens its resource before its first wait and keeps the picker disabled until the status is `live`. Each supply that reaches the manager lands a `resource:supply` record naming the key and owner, never the value.

**Expose** sets the cell's one live value, read by `useResource` and nothing else; code that needs what a resource holds calls a method. Replacing the value runs the previous one's `release`. On retirement the value is cleared and released before `r.signal` aborts, so no view renders a revoked URL. A type that needs several values uses one child entity per value.

### r.run

`r.run(effect)` runs an effect generator as a new action on the owner, its signal linked to the instance's, its `action:start` carrying `Origin: { Kind: "resource:run", Key, OwnerId }`. A streaming type gets its credentials this way, from an application effect declared `redact: true` ([`effects.md`](./effects.md#options)) and run on every connect, so neither its record nor a tap sees the headers. An `r.run` action's result is withheld from the tap extras as well.

- **The result is a lossy plain-data copy**: a class instance, such as a `Blob`, comes back `undefined`. A type that needs one owns its `fetch`.
- **A failure rejects** the `r.run` promise and lands in the terminal record. It takes no failure route: no error boundary, no `onError`, no `failure` event. The resource holding the promise handles it.
- **A run in flight rejects** with the retirement's `AbortError` if the instance retires before it settles, and `r.run` on a retired instance rejects at once.
- **It refuses** `start`, `openResource`, `closeResource`, `startTimer` and `ask`, and reaches methods only on the owner's strict ancestors, each with a `TreflexRefusal` (an `AskRefusedError` for `ask`).

Actions a resource started, deliveries and runs alike, are left out of a snapshot's in-flight list.

### Restore and tests

Every resource reopens after a restore, from its row, the owner's restored state and `r.resumeFrom` ([`restart-and-records.md`](./restart-and-records.md#resources-after-a-restore)). `createTestRuntime` pauses the manager for good and answers from stubs ([`testing.md`](./testing.md#resources)). **`createRuntime`'s `pauseResources: true`** pauses the manager for good, without stubs: rows are written, closed and removed with their owner as always, nothing connects, restored rows included, cells read `pending` with `Waiting: "paused"`, and methods and supplies resolve `undefined`.

### Ticks

- **Send-to-self.** A tick reaches the row's receiver on the row's owner, nothing else. The only entity a timer can aim at is the one started from.
- **Fixed delay.** The next interval starts when the tick's action settles, so ticks never overlap.
- **Queued behind a hold.** A tick waits while an action holds the owner.
- **The tick is `{ Type: key, ...payload }`**, the payload a frozen copy taken at `startTimer`. A receiver that needs the time yields an effect for it.
- Start a timer from the draft or an entity under it.

Each tick lands a `message:deliver` record with the key as `Topic`, and each row change a `table` record with `Table: "timers"`.

**A snapshot saves each running timer's next due time, and a restore arms the timer for then.** A due time already past fires once, soon, so the timers that came due during a long close all fire together on the restore. One more than an interval ahead, from a clock set back, waits one interval. A row saved without one, by an older build or a paused runtime, waits a full interval from the load. Due times are best effort: a crash leaves the last save's, and a clock change or a long suspension ends in a prompt tick, never an exact schedule. The due time rides only the snapshot, never the row, its `table` records or `runtime.timers()`.

`createRuntime`'s `pauseTimers: true`, which `createTestRuntime` sets, records rows and fires nothing ([`testing.md`](./testing.md#timers-and-resources-in-tests)).

## Caveats

- **A reopen from `$Ended` with no wait** against a type that fails at once loops in microtasks and starves the page. Back off on a timer.
- **A rejection after the instance retired** raises nothing.
- **An emit made just before the end** may start its delivery before the abort; the rest of the queue and the `$Ended` notice come after it.
- **Past 100 queued deliveries,** [`resource/queue-depth`](./troubleshooting.md#resourcequeue-depth) fires once. Batch with `r.onIdle`.
- **An `onIdle` callback registered from inside one** runs after the next delivery settles.
- **Every retirement, `r.end` included, drops pending `onIdle` callbacks,** so flush before ending.
- **A receiver that reopens its own key and calls the new instance's method directly** throws a `TreflexRefusal`: that setup waits for this delivery to end. Call it from an action the receiver starts.
- **A type can't tell that a message was applied.** A protocol that acknowledges after applying acks from the receiver, through an action it starts that calls the type's ack method.
- **A dropped supply leaves the value with the view,** so anything it must stop, a media track say, is the view's to stop.
- **A tab suspended for an hour** wakes to one tick.
- **A `stopTimer` that lands before a queued tick starts** drops it unrun.
- **A timer whose receiver isn't registered** skips the tick and re-arms, raising [`receiver/unresolved`](./troubleshooting.md#receiverunresolved) once until a tick reaches it.
- **A timer owner the tree doesn't hold** gets its row with a console warning, and the first tick removes it.
