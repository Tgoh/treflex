# Failure

What happens when an action throws, who hears it, and what stays. A fiber [told to end](./fibers.md#stopping) has not failed: a stop skips `catch`, and only a throw its close makes is heard ([below](#a-stopped-actions-failure)).

## Usage

The guide teaches this in [6. Failures](../guide/06-failures.md). The pattern [catch only what you expect](../patterns.md#catch-only-what-you-expect) builds on it.

### When an action throws

**A failure is handled by the first thing that takes it.** Inside the action, that is a `catch`, which sees the action's own throws and its effects' rejections, each rejection [as a copy](./effects.md#a-rejection-crosses-as-a-copy). A throw that leaves the action takes [the route](#the-route) to one taker: the nearest error boundary, or `onError` at the top. Its dispatch promise rejects with it, and the [`failure` event](#the-failure-event) reports it. Writes made before the throw stay. The route, `onError`, the `failure` event and the dispatch promise carry what the action ended with, the object and not its serialized form: for a rejection nobody converted, that is the copy. What the tap extras carry is in [the tap](./restart-and-records.md#the-tap).

Handling meant for one call is a `catch` inside the action, which rethrows anything it doesn't expect, a [refusal](#refusals) included. The failure it expects is part of the effect's answer, and a helper throws it as the app's class. Here `save` is that helper and `ConflictError` its class, both from the [example in effects](./effects.md#a-failure-the-app-handles):

```ts
import type { IActionGenerator, IEntity } from "treflex";

interface IEditor extends IEntity {
    Form: { Title: string };
    Version: number;
    SaveError: string;
}

export function* submit(draft: IEditor): IActionGenerator {
    try {
        draft.Version = yield* save(draft.Form);
    } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        draft.SaveError = "Someone else changed this record.";
    }
}
```

### Error boundaries

An **error boundary** is an ancestor bound to a registered receiver with an `Action/Error` case. `Action/Error` is declared by treflex in `IMessageRegistry`, and the runtime delivers it along the route.

```ts
import { type IReceiverId, receiver } from "treflex";

interface IShell extends IEntity {
    readonly $Receiver?: IReceiverId<IShell>;
    DialogIds: string[];
    Toasts: string[];
}

export const ShellReceiver = receiver<IShell>("ShellReceiver")({
    *"Action/Error"(draft, failure, { publisher }) {
        if (!draft.DialogIds.includes(publisher.Id)) throw failure;    // not ours: pass it on up
        draft.Toasts.push(failure.Error.Thrown === "error" ? failure.Error.Message : "Something went wrong.");
    }
});
```

No entity hears its own failure, so a root's goes to `onError`.

### onError

`createRuntime(state, { onError })` is the root taker: it takes what no error boundary took, called with the error and an `IErrorContext` ([below](#the-route)).

**Log from the [`failure` event](#the-failure-event), and keep a root taker.** The event observes, and takes nothing: with no `onError`, every failure nothing else takes is reported twice, once by the logger and once as an unhandled rejection. Keep an `onError` that does nothing else:

```ts
import { createRuntime, type IFailureEvent } from "treflex";

export function boot(seed: IShell, log: (event: IFailureEvent) => void) {
    const runtime = createRuntime(seed, { onError: () => {} });
    runtime.on("failure", log);
    return runtime;
}
```

## Rules

### The order

Once a throw leaves the action, in this order:

1. **The terminal record lands**: `action:end` with `Status: "errored"`, the error on the tap extras.
2. **The route starts**, looking for one taker: the nearest error boundary, or `onError` at the top, or nothing ([below](#the-route)).
3. **The dispatch promise rejects** with it ([below](#the-dispatch-promise)).
4. **The `failure` event fires** once the route has ended, saying whether something took it.

Nothing is unwound, with two exceptions: a step whose writes break the tree rule is undone whole ([`state-tree.md`](./state-tree.md#the-tree-rule)), and an array method refused partway puts back what it wrote ([`write-path.md`](./write-path.md#what-a-write-takes)).

### The route

1. **The nearest error boundary**: the nearest ancestor [bound](./messaging.md#binding) to a registered receiver with an `Action/Error` case, walking up from the failing entity's parent, from where the entity is now. An ancestor bound to an unregistered receiver is passed. An entity that has left the tree has no error boundary. An action on [part of an entity](./views.md#a-form-over-part-of-an-entity) fails from that entity.
2. **The error boundary has taken it when its action completes**, an early return included. If its action ends cancelled or dropped, the failure goes on up.
3. **An error boundary passes a failure on by rethrowing the payload it was given.** The next one up gets the same failure, with the same publisher, `Name` and `Label`. Any other throw is the error boundary's own failure: it takes the route from the error boundary's entity, and carries the failure it was handling as `Cause`.
4. **`onError`** takes what no error boundary took, a root's own failure included. Its `IErrorContext` is `{ Name, Label, EntityId, Cause? }`, `Name` and `Label` as on the [failure event](#the-failure-event), `Cause` being the failure an error boundary was handling when the failure is the error boundary's own. A failure an error boundary took never reaches it, so it is not a count of every failure: the `failure` event is.
5. **Nothing**, when there is no `onError` or `onError` throws: an unhandled rejection ([below](#the-dispatch-promise) says of what).

The delivery to an error boundary queues behind a [hold](./actions.md#holds) on its entity like any work, so an error boundary whose entity is held across a long wait hears its failures after the wait. [`action/long-hold`](./troubleshooting.md#actionlong-hold) names the stall; an action that must hear them during the wait wraps it in `open(...)`.

### The Action/Error payload

| Field | |
|---|---|
| `Error` | The throw, serialized: `{ Thrown: "error", Name, Message, Stack?, Fields?, Native?, Class?, Cause?, Errors?, Error?, Suppressed? }` for an error; `{ Thrown: "value", Data? }` for any other value, a server's error envelope say |
| `Name`, `Label` | The action that failed: its [durable name](./actions.md#durable-names) or `null`, and its function's own name or `null`, a label for display |
| `Cause` | On an error boundary's own failure, the failure it was handling, serialized |

An `Error`'s form holds:

| Field | |
|---|---|
| `Name`, `Message`, `Stack?` | Read off the error |
| `Fields` | The enumerable own string-keyed fields other than `name`, `message`, `stack` and `cause`, and other than `errors` on an `AggregateError` and `error` and `suppressed` on a `SuppressedError`, which `Errors`, `Error` and `Suppressed` carry; each as its JSON round trip |
| `Native` | The nearest native error type up the prototype chain, such as `"TypeError"`, `"DOMException"` or `"WebAssembly.RuntimeError"`, typed `INativeErrorName`; absent for `Error` |
| `Class` | The nearest of treflex's own error classes up the prototype chain, such as `"treflex/EntityGoneError"`: the error's class, or the one an app's class extends |
| `Cause` | The error's own `cause`, serialized the same way |
| `Errors` | An `AggregateError`'s `errors`, serialized the same way |
| `Error`, `Suppressed` | A `SuppressedError`'s `error` and `suppressed`, serialized the same way. An error named `"SuppressedError"` that has both as own properties, as a compiler's helper makes where the engine has no `SuppressedError`, counts as one here and in `Fields`, and is rebuilt with both as own properties |

`Error.Cause` is the thrown error's `cause`; the payload's own `Cause` is the failure an error boundary was handling. `Cause`, `Errors`, `Error` and `Suppressed` are followed eight levels below the thrown error and to 100 nested errors in all, with every item of `Errors` counted whether it is an error or not, read depth first in that order, and an error that is already on the way down is not followed again.

The context's `publisher.Id` is the entity whose action failed. The error is serialized because a message is data. The shape is `ISerializedThrow`, and an app can make one itself with `serializeThrow(error)`, which never throws: to put a failure in state, or log it as data.

### The dispatch promise

It rejects with the failure either way. Once the failure is on a route with a taker in reach, an error boundary or `onError`, the rejection is marked handled, so a discarded promise is no unhandled rejection. With neither, the promise is the uncaught report: a caller that catches it has handled it, and a discarded one is an unhandled rejection. If the route ends with no taker after all:

- **Past the top with no `onError`**, after error boundaries passed it on, the runtime raises the failure as an unhandled rejection of its own.
- **With an `onError` that throws**, the runtime raises `onError`'s own throw as the unhandled rejection. The failure's promise was marked handled when the route started, so the failure itself is heard only through the `failure` event, with `Taken: false`.

A caller catching the promise handles it a second time: after `onError` has run, or an error boundary whose entity was free has started, and before an error boundary queued behind a hold has started.

Only the dispatch's own promise is marked handled. An `await` or a `.then` makes a new promise, so a view handler that awaits a dispatch and is itself discarded raises an unhandled rejection for a failure a boundary already took. A view awaits a dispatch only when it needs the result, such as an opener whose result a dialog shows, and handles the rejection in one helper:

```ts
export function opened<T>(dispatching: Promise<T>): Promise<T | undefined> {
    return dispatching.catch(() => undefined);
}

const opening = await opened(ctx.openMapPending());
if (opening) dialog.show(opening);
```

A view that needs no result doesn't await: `void dispatch(...)` raises nothing once a taker has the failure.

Work whose promise the runtime holds, a started action, a receiver, a timer tick or a resource delivery, has no caller to report it, so a failure there that nothing takes is raised by the runtime.

A dispatch refused before the action starts takes no route: a target [`dispatch` refuses](./runtime.md#dispatch). Its promise rejects, and a discarded one is an unhandled rejection whatever `onError` is. An argument that isn't plain data does fail the action, and takes the route.

### The failure event

`runtime.on("failure", handler)` hears **every throw out of action code that the runtime catches**, except the failure an `r.run` ends with, which goes to the resource ([below](#off-the-route)): the failure an action ends with, an error boundary's own failure, a throw out of a close, and the throws a stop leaves unrouted.

| Field | |
|---|---|
| `Error` | What the action ended with |
| `ActionId`, `EntityId` | The action that threw and its entity |
| `Name`, `Label` | The action's [durable name](./actions.md#durable-names) or `null`, and its function's own name or `null`, a label for display. A log reads `Name ?? Label`. An error boundary's own failure, and a delivery's, has no name, and its label is the receiver's id |
| `Status` | How the action ended: `"errored"`, `"cancelled"`, or `"completed"` for a close throw after it completed |
| `Close` | The throw came out of a close: a `finally` run as the generator was stopped or failed |
| `Taken` | Whether an error boundary or `onError` took it. A throw with no route has nothing to take it |
| `Cause` | On an error boundary's own failure, the failure it was handling |

**It fires once, when the route ends**, since only then is `Taken` known: behind a held error boundary, when its delivery ends. An error boundary's own failure fires its own event, and the failure it was handling fires with the same `Taken`. A throw with no route fires once the action and all its branches have ended, and also raises [`action/unrouted-throw`](./troubleshooting.md#actionunrouted-throw) in every build.

It costs nothing on writes, unlike a record tap of every kind. A subscriber that throws raises [`runtime/callback-threw`](./troubleshooting.md#runtimecallback-threw) and changes nothing about who took the failure. It is for logging and telemetry, not handling: handling is a `catch`, an error boundary or `onError`.

A throw from code the runtime calls outside any action, a record tap, a dispose callback, a resource's release, is not an action's failure. Only that call is lost, a tap or subscriber stays attached, and it is reported as `runtime/callback-threw` with the live error in its data.

### A stopped action's failure

A stop is `return()` on the generator, which skips `catch`, and the stopped action's promise resolves `undefined`. What the stop keeps from the action's code is the stopped action's failure, routed from its entity:

- **A throw out of its close**: a `finally` that throws, or one whose writes break the tree rule. Its event has `Close: true`.
- **A `parallel` branch's failure the stop kept from its root**, once the root has settled.

The first one is routed, once the action has settled cancelled. Any later one, and a close throw in an action that ended another way, has no route: it reaches the `failure` event untaken and raises `action/unrouted-throw`. **A removed entity's stopped work isn't routed**: its removal was its owner's stop. A root that throws in the step that stopped it was kept from nothing: it ends `errored` and takes the route.

A failing `parallel` branch stops its siblings and rethrows once they have ended, and `parallelSettled` hands each outcome back ([`fibers.md`](./fibers.md#parallel-and-parallelsettled)). A branch's failure stays on its `branch:end` record either way, and takes the route only as its action's failure.

### Refusals

A **refusal** is a treflex rule the code broke, the same whatever the data: `DraftInsideOpenError`, `EntityReplacedError`, `StateAliasError`, `AskRefusedError` and the rest. Every one extends **`TreflexRefusal`**, and **`isRefusal(error)`** recognises one, from a duplicate module load too. What the data can cause is not a refusal, so a `catch` around work over a server's payload can stay broad: `NonPlainDataError` and `ReconcileRowsKeyError` aren't refusals, nor are `EntityGoneError` and `DraftDetachedError`, which correct code expects, nor the `TypeError`s of argument checks.

JavaScript can't let a refusal skip a `catch`, so a `catch` that can meet one rethrows it, as `submit` above does. A development build reports a refusal an action swallowed as [`action/refusal-swallowed`](./troubleshooting.md#actionrefusal-swallowed): one its own code was refused with, which it ended without rethrowing, judged when it and all its branches have ended. A refusal `parallel` rethrows into a broad `catch` counts, and so does one `parallelSettled` hands back. Another action's refusal that rejects an effect this one waited on is that action's.

`DraftDetachedError` is caught on purpose, as `if (error instanceof DraftDetachedError) return;`, or avoided by checking `isAttached` first ([`actions.md`](./actions.md#held-references)).

### Off the route

- **A receiver's own throw** fails its delivery's action, routed from the receiver's entity, and lands a `receiver:error` record. The publisher never hears it ([`messaging.md`](./messaging.md#publish)).
- **An `r.run`'s failure** rejects the promise the resource holds and lands in its terminal record; no error boundary, `onError` or `failure` event hears it ([`live-sources.md`](./live-sources.md#rrun)). A resource that fails ends with `$Ended`.

#### A view's throw

**A view's throw is the view's failure, never an action's.** In Solid, a view runs in Solid's flush, not in the step that wrote, so its throw, while it mounts or on an update, never fails the action whose write it reacted to. The throw is Solid's: `TreflexProvider` holds no boundary, and the nearest `<Errored>` of the app's own takes it, above the provider or below it. With none, Solid stops updating every view on the page, under other roots and other runtimes too, and its flush rethrows the error uncaught. An app from `npm create treflex` puts an `<Errored>` at its root.

A boundary swaps its whole subtree to its fallback and pauses the subtree's effects. It comes back when the computation that threw runs again without throwing, with the children as they were:

- a throw on update comes back when the state it read changes;
- a reactive expression whose first run throws at mount comes back the same way;
- a component body that throws at the app's first mount stays blank;
- a component body that throws when a `<Show>` mounts it later comes back when the `Show` flips back.

The user sees only the fallback, so it comes back only when something other than the user changes the state that threw. A cached selector or `getData` read holds a throw from its compute and rethrows it to each reader, so it fails the views reading it, and computes again when something it read changes. In React, an error boundary catches that rethrow in render.

### What treflex reports as data

What treflex expects to go wrong comes back as data rather than a throw: `parallelSettled`'s outcomes, a cancelled or dropped dispatch resolving `undefined`, an ask whose owner left resolving `undefined`, a resource method nothing can answer resolving `undefined`. **`EntityGoneError`** is the race an interface meets most: a dispatch to an entity that isn't in the tree, or an `ask` or `openResource` on an owner that isn't or is leaving. Its `id` names the entity. A `catch` matches it with `instanceof EntityGoneError`, which holds for the copy an action gets when an implementation's own dispatch rejected with it.

## Caveats

- **When the `failure` event fires against the promise's handlers:** before them when `onError` took the failure, or an error boundary whose entity was free and which finished without waiting; otherwise after them.
- **A publish of `Action/Error`** isn't refused: `publish("Action/Error", ...)` reaches every error boundary bound to a registered receiver, and `publishToNearest` the nearest one, and each handles it as a failure, though no action failed. Don't publish it.
- **A thrown value with no JSON form** arrives changed in the payload, with a console warning, when the action threw it; one an implementation rejected with has already [crossed as its JSON form](./effects.md#a-rejection-crosses-as-a-copy). `Name` and `Message` read `"(unreadable)"`, exported as `UNREADABLE`, when the field reads `undefined` or its getter throws (any other value is stringified), and `Stack` is absent on the same terms.
- **An action waiting on another's dispatch,** through an effect that calls `runtime.dispatch`, and not catching it, fails with a copy of the error: its own failure, on its own route, so the one throw is heard on both.
