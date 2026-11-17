# Conversations

A conversation is an action waiting on a decision, usually a person's, usually through a dialog. `ask` opens it and waits, `answer` ends it, and `pendingAsks(owner)`, read through a selector, is how a view finds the open ones. A dialog no action waits on is just a component holding a copy of what it edits, and needs no ask. Code that can't see the asker answers with a message instead ([`messaging.md`](./messaging.md)).

## Usage

The guide teaches this in [8. Asks](../guide/08-asks.md).

### ask and answer

```ts
import { answer, ask, type IActionGenerator, type IAskId, type IEntity, open } from "treflex";

type IShiftAnswer = "handover" | "bin" | undefined;

interface IStation extends IEntity {
    Name: string;
}

interface IKitchen extends IEntity {
    Stations: IStation[];
}

export function* endShift(draft: IKitchen, stationId: string) {
    const station = draft.Stations.find((s) => s.$Id === stationId);
    if (!station) return;
    const choice = yield* open(ask<IShiftAnswer>(station, { Path: "Kitchen/EndShift", CookName: station.Name }));
    if (!choice) return;
    const leaving = draft.Stations.find((s) => s.$Id === stationId);    // other work ran during the wait
    if (!leaving) return;
    draft.Stations = draft.Stations.filter((s) => s.$Id !== stationId);
}

export function* answerShift(_draft: IStation, askId: IAskId<IShiftAnswer>, choice: "handover" | "bin" | null): IActionGenerator {
    yield* answer(askId, choice ?? undefined);
}
```

**`ask<R>(owner, request)`** opens an ask owned by `owner`, a node or an `$Id`, and waits. It resumes with the answer, or with `undefined` when the ask ended without one, so `undefined` covers a dismissal and an owner that left.

**`answer(id, value?)`** answers the ask `id`. With no value, or `undefined`, it dismisses, for any answer type.

- **Ask from the action itself, not from a `parallel` branch or an `r.run`, and wait inside `open(...)`.** The answer runs on the owner or below it, often the asker's own entity, and would queue behind the asker's [hold](./actions.md#holds) for good ([what an ask takes](#what-an-ask-takes)).
- **Re-check after the wait.** Inside `open(...)` other work on the entity runs, so the asker re-reads what it relies on, as `endShift` re-finds the station ([`actions.md`](./actions.md#re-checking-after-a-wait)).
- **Answer from the owner or below it** ([what an answer takes](#what-an-answer-takes)).

### Rendering the open asks

`yield* pendingAsks(owner)` lists the open asks whose owners are at or below `owner`, in opening order. It is a read ([`derived-reads.md`](./derived-reads.md#the-reads)): a selector reading it re-runs when an ask opens or ends and when an owner moves. A view reads it through a selector.

```ts
import { type IAskEntry, type ISelectorGenerator, pendingAsks } from "treflex";

export function* kitchenAsks(draft: IKitchen): ISelectorGenerator<readonly IAskEntry[]> {
    return yield* pendingAsks(draft);
}
```

The view answers by dispatching on `entry.OwnerId`, through the owner's feature or `useDispatch()`.

## Rules

### What an ask takes

- **The owner is what the ask is about**, and must be attached when the ask opens, in any of the three roots: an entity added earlier in the step is, since the yield lands the step's writes. An unknown, removed or leaving owner throws `EntityGoneError`. The station owns the handover question, so whatever removes the station ends the ask.
- **The request is the app's own shape**, plain data copied and frozen at the yield. A request with no plain form, a function say, throws `NonPlainDataError` and opens nothing. A renderer shows the asks it knows by a field of the app's choosing, such as `Path`.
- **An ask outside the action's own generator, or not waiting inside `open(...)`,** throws `AskRefusedError` before the ask opens, its `reason` naming the rule: `"outside-open"` for a wait that holds, `"in-branch"` for an ask from a branch of `parallel` or `parallelSettled`, and `"in-run"` for an [`r.run`](./live-sources.md#rrun). Work that must run beside an ask is started before it.

### What an answer takes

- **From an action holding any entity but the owner or one below it,** `answer` throws `AnswerOutsideOwnerError`. An action on [part of an entity](./views.md#a-form-over-part-of-an-entity) counts as that entity, and component state counts as below the entity it mounts under. An `r.run` holds nothing and may answer any ask.
- **The value is copied and frozen**, so a node of the answerer's state is a fine answer. One with no plain form throws `NonPlainDataError` and the ask stays open.
- **The first answer wins.** A later answer, an answer to an ended ask and one to an unknown id do nothing.
- **`answer` gives up no turn**, so the answering action's code after it runs before the asker resumes. At its next wait or its end the asker resumes, and if the asker then removes the answering action's entity, as a dialog's asker often does, the answering action is [stopped](./fibers.md#stopping) there.

Once answered, the question is settled: a failure in the work after it belongs to the asker, not to a dialog that comes back.

### The entries

Each entry is `{ Id, OwnerId, Request }`, one frozen object for the ask's whole life, so a keyed list keeps its mount: Solid's `<For>` keeps it, and a React key is its `Id`. `Id` is an `IAskId<unknown>`, since the list doesn't know answer types: narrow it by the request with a cast, `entry.Id as IAskId<IShiftAnswer>`.

A dialog about another entity, a ticket say, is owned by the ticket, so removing the ticket ends the ask, the dialog rendering it goes with it, and the asker resumes `undefined`. A view renders it from `pendingAsks(ticket)`, or `pendingAsks(inbox)` for every ticket's.

#### A decision the server must accept

Where a refusal should show in the dialog, the answer is the outcome, not the input. The dialog calls an action with the ask's id; the action saves and answers only on success, and hands a failure back to the dialog as its result. The ask stays open through the save, so the dialog keeps its mount and can try again:

```ts
interface IPolicy extends IEntity {
    Name: string;
}

export function* askRename(draft: IPolicy) {
    const renamed = yield* open(ask<IRenameResult>(draft, { Path: "Policy/Rename", Name: draft.Name }));
    return renamed !== undefined;
}

export function* rename(draft: IPolicy, askId: IAskId<IRenameResult>, name: string): IActionGenerator<{ Error: string } | undefined> {
    try {
        const result = yield* api.rename(draft.$Id, name);
        draft.Name = result.Name;
        yield* answer(askId, result);
        return undefined;
    } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return { Error: error.message };
    }
}
```

`rename` runs on the ask's owner, the asker's own entity, which the asker let in through its `open`.

### What ends an ask

- **An answer**, or a dismissal.
- **Its owner leaving.** The owner's cascade ends the ask, and the asker resumes `undefined`.
- **Its asker stopping**, by `latest` or by the removal of the asker's entity.
- **A restart.** No ask is saved, so a restored runtime has none open, and an ask id kept in saved state answers nothing.

A move doesn't end an ask, because the owner keeps its `$Id`: a reorder, a move between transients, a filter that keeps the owner, or a `reconcileRows` refresh that matches it.

On the record stream an ask is one `ask` effect, whose descriptor carries the request and whose response is the answer. Opening and ending it each land a `table` record with `Table: "asks"`, without the request. An answer lands `ask:answer`, and an ending without one lands `ask:abandon` with `Reason: "disposed"` or `"cancelled"`.

**A dialog that is stuck**, or an asker that never resumes, is an ask nothing answers, and an answer that reaches nothing is silent. Check, in order:

- **Is a view rendering it?** It needs a selector reading `pendingAsks` on the owner or an entity above it.
- **Is the view answering an old id?** Asking again opens a new ask with a new id, and the old id answers nothing. So does an id kept in saved state, after a restore.
- **Is `answer(...)` called without `yield*`?** It builds a generator that never runs.
- **Is the answering action queued?** One queued behind another action's hold never runs: [`action/long-hold`](./troubleshooting.md#actionlong-hold) names the holder. One on an entity that isn't the owner or below it throws `AnswerOutsideOwnerError`.

`runtime.processSelector` over a selector reading `pendingAsks` lists what is open, and the `asks` table records name each ask's `AskId` and `OwnerId`.

### The durable conversation

A plain ask dies at a reload. A conversation that must survive one is built from state instead: an opening action writes a row into the tree and ends, the dialog renders the row, and the answering actions re-read the row from current state and do nothing when it is gone. Nothing waits on it, so a restore brings the row back with what the person typed. Where the answering view can't see the owner, the answer is a `publish`, and the owner's saved binding carries the wiring. Overlapping conversations of one kind carry an app-minted id in the row, passed back by the answering dispatch.

**Choose per step: would the person be annoyed if a reload dismissed this?** A seconds-long confirm is a plain ask. Typed input they would resent re-entering is a row.

## Caveats

- **An asker that must act on what the person saw** copies the request to a local first: the state it was built from can change during the wait.
- **A stopped asker's ask ends a microtask after the stop,** so an answer landing in the same step still wins.
- **Taking the owner out in one step and putting it back in a later one** is a removal, and ends the ask.
- **`pendingAsks` on a plain object,** such as a value snapshot or a React entity view, throws. Read it through a selector.
