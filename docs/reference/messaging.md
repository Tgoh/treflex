# Messaging

Entities send each other typed messages without importing or referencing each other. An entity hears messages through the **receiver** it is bound to, named in its own state, so who hears what follows the tree: an entity that leaves hears nothing more, and a restored entity hears what it heard before.

- **`publish(topic, data)`** reaches every entity bound to a receiver with a case for the topic.
- **`publishToNearest(entity, topic, data)`** reaches the nearest ancestor of `entity` that handles the topic, and nothing else.

Timer ticks ([`live-sources.md`](./live-sources.md#timers)), resource messages ([`live-sources.md`](./live-sources.md#emit)) and failures ([`failure.md`](./failure.md#error-boundaries)) reach an entity through its receiver too. Waiting for one answer is an ask ([`conversations.md`](./conversations.md)).

## Usage

The guide teaches this in [5. Receivers and messages](../guide/05-messages.md).

### Topics

A topic is a key in `IMessageRegistry`, mapped to its payload:

```ts
import type { IActionGenerator, IEntity, IReceiverId } from "treflex";

declare module "treflex" {
    interface IMessageRegistry {
        "Content/Saved": { ContentId: string };
        "App/Close": {};
    }
}
```

A misspelt topic or a payload of the wrong shape is a compile error. `publish` takes the payload only when the topic declares fields. Declare a topic beside the feature that owns its meaning.

### Receivers

`receiver<T>(id)(cases)` builds a receiver for entities of state `T`: one case per key it handles, each called with the draft, the message and its context.

```ts
import { receiver } from "treflex";

interface IRow extends IEntity {
    readonly $Receiver?: IReceiverId<IRow>;
    ContentId: string;
    Title: string;
}

export const RowReceiver = receiver<IRow>("RowReceiver")({
    *"Content/Saved"(draft, message, ctx) {
        if (message.ContentId !== draft.ContentId) return;
        draft.Title = `saved by ${ctx.publisher.Id}`;
    }
});
```

**Register every receiver at startup**, whole: `runtime.registerReceiver(RowReceiver)`.

### Binding

An entity is bound to one receiver by its reserved field `$Receiver`, which holds the receiver's `Id`. The binding is the entity's own state: it moves with the entity, is saved and restored with it, and ends when the entity leaves the tree. The receiver's topics are read at each publish, never copied onto the entity.

Three places set it:

```ts
import { bind, entity, unbind } from "treflex";

interface IList extends IEntity {
    Rows: IRow[];
}

export function* addRow(draft: IList, contentId: string): IActionGenerator {
    const row = yield* entity<IRow>({ ContentId: contentId, Title: "", $Receiver: RowReceiver.Id });  // on the value
    draft.Rows.push(row);
}

export function* init(draft: IRow): IActionGenerator {
    bind(draft, RowReceiver);                                    // on a draft node in the tree
}

export function* mute(draft: IRow): IActionGenerator {
    unbind(draft);
}
```

- **On the value**: `$Receiver: Receiver.Id` in a seed, a default state, or the value given to `entity()`. It is checked as `bind` is.
- **`bind(node, receiver)` on a draft node**, an ordinary write in the step.
- **`bind(value, receiver)` on the value `entity()` returned**, before it is written into the tree.

`unbind(node)` takes a binding away, and takes what `bind` takes. Neither yields: they are writes, not effects.

### publish

```ts
import { publish, publishToNearest } from "treflex";

export function* save(draft: IRow): IActionGenerator {
    draft.Title = draft.Title.trim();
    yield* publish("Content/Saved", { ContentId: draft.ContentId });
}
```

Each receiver is a new action on its entity, and none starts until the publisher has given up its turn again, at its next wait or its end ([when they run](#when-they-run)).

### publishToNearest

```ts
export function* close(draft: IRow): IActionGenerator {
    yield* publishToNearest(draft, "App/Close");
}
```

Use `publish` for "anything that cares should react" and `publishToNearest` for "the enclosing scope should react".

## Rules

### Cases

- **The message** is `{ Type: topic, ...payload }`. The payload is a frozen copy made at the publishing yield, one shared by every receiver, so a receiver that writes it into its draft lands its own node.
- **The context** is `{ publisher: { Id } }`: an `$Id`, not live state.
- **A case key** is a topic, a [timer key or a resource key](./live-sources.md#registries). Any other key is a compile error, unless the cases object is cast.
- **A case can be an action given bare**, whose message and context parameters are optional. A delivery to it counts as that action, and as its work tags, for `inFlight` ([`actions.md`](./actions.md#inflight)).
- **The id names the receiver**, not an entity: many entities can be bound to one receiver.
- **The state type is checked.** A receiver built for one state can't be bound to an entity of another: that is a compile error.
- **Cases are partial.** A receiver handles the keys it lists and nothing else, and a misspelt key is refused at compile time, as above. A receiver meant to cover a set of topics says so in a statement after it, `RowReceiver satisfies IReceiver<IRow, "Content/Saved" | "App/Close">;`, which fails to compile while a case is missing. A case over a union payload ends its `switch` with `default: event satisfies never;`, so a new kind of event fails to compile until a case handles it.

### What names a delivery

Each delivery runs as the receiver's `handle`, an action named by the receiver's id. So `inFlight` counts a delivery as the case it matched, and as the receiver's `handle`; everything else names it by the receiver id, never by the case: the `action:start` record's `Name`, the `ActionName` of the `failure` event and of `onError`'s context, and the diags. To tell which case a failure came from, join its `ActionId` to its `action:start` record, whose first argument is the message, with the topic as its `Type`.

### Registering

Anything other than what `receiver(id)(cases)` returns throws a `TypeError`. Registering an id again replaces its handle and topics, which is what a hot reload does: entities bound to it hear the new version's topics with nothing else re-run. In a production build, a second registration of one id with a different handle also raises [`receiver/id-collision`](./troubleshooting.md#receiverid-collision), since there it means two modules claim one id.

### What binding refuses

- **`bind` or `unbind` on the value `entity()` returned, after it was written**, throws `BindAfterWriteError`: the tree holds a copy, so changing the value changes nothing. Set `$Receiver` before the write, or bind the draft node.
- **A view** (`runtime.state` and anything read from it) is read-only, and `bind` on it throws a `TypeError`. So does `bind` on a frozen value, and on a node with no `$Id`.
- **A plain write that changes `$Receiver`**, such as `Object.assign(row, serverItem)`, throws a `TypeError`, so a copy can't rebind an entity by accident. Writing the value it already holds passes.
- **A `$Receiver` that isn't a non-empty string**, or one on a node with no `$Id`, is refused in a write, a seed and a snapshot alike.

A `bind` on a draft node is recorded as a change at `$Receiver`. `entity({ ...row })` keeps the row's `$Receiver`, so a copy of a bound row is bound. `withoutIds(row)` drops it with the `$Id`.

An entity that should hear some of a receiver's topics and not others gets a receiver of its own. A guard inside a case, an early return, is enough for a broadcast.

### Who hears a publish

**Who hears it** is decided at the yield: every entity bound to a registered receiver with a case for the topic, receivers in the order they were first registered for the topic, and each receiver's entities in tree order. A restored runtime whose `setup` registers receivers in the same order delivers in the same order as the one it was saved from. Every [external source](./lookup.md#external-sources) declaring the topic receives it too, during the yield.

### When they run

Each receiver is a new action on its entity, a root fiber of its own, so the publisher stopping doesn't stop it. Each arrives at the yield, in delivery order, so the publisher's code after `yield* publish(...)` never sees a receiver's writes. A receiver on an entity some action [holds](./actions.md#holds) starts when the hold ends.

**A receiver's failure** is its own action's failure, routed from its own entity ([`failure.md`](./failure.md#the-route)), and lands a `receiver:error` record. The publisher never hears it.

Code that asserts on what receivers did waits for them: in a test, with [`settled()`](./testing.md#waiting-until-nothing-can-run).

### The nearest walk

`publishToNearest` walks the strict ancestors of `entity`, nearest first, and delivers to the first one bound to a registered receiver with a case for the topic. `entity` itself is skipped, an ancestor bound to a receiver without the case is passed, and nothing past the first match receives. The receiver queues and starts as a broadcast's does. The context's `publisher.Id` is `entity`'s `$Id`.

`entity` must be in the tree. A child dispatched from a view inside its owner's provider can call the owner's action directly instead.

### A receiver that isn't registered

A binding can name a receiver that isn't registered yet, such as one in a code-split chunk, or one renamed since a snapshot was saved. The binding stays, and registering the receiver heals it:

- **When the binding lands**, a microtask later, [`receiver/unresolved`](./troubleshooting.md#receiverunresolved) fires once per receiver id.
- **A broadcast** delivers nothing to such entities, and names every entity bound to an unregistered receiver in its record's `UnresolvedIds`, since any of them may have handled the topic.
- **A `publishToNearest` walk stops at the nearest one**, delivers nothing, names it in `UnresolvedIds`, and raises `receiver/unresolved`. Falling through would deliver a scoped message to a scope that may have claimed it.
- **A failure's route passes it** and goes on up ([`failure.md`](./failure.md#the-route)).

A restore also lists such bindings in its result and in [`restore/unresolved-receiver`](./troubleshooting.md#restoreunresolved-receiver).

### Records

Each `publish` and `publishToNearest` lands one `message:deliver` record, even when nothing hears it, except a `publishToNearest` from an entity not in the tree: `Topic`, `PublisherId`, `RecipientIds` (the entities and external sources delivered to, in delivery order) and `UnresolvedIds` (those that may have claimed it and couldn't, absent when none). The payload is on the `effect` record's `Descriptor`. A receiver's throw lands a `receiver:error` record with the live error on the tap extras. See [`restart-and-records.md`](./restart-and-records.md#record-kinds).

### When a receiver doesn't fire

1. **Is the receiver registered?** Look for [`receiver/unresolved`](./troubleshooting.md#receiverunresolved), and for the entity in the `message:deliver` record's `UnresolvedIds` ([above](#a-receiver-that-isnt-registered)).
2. **Is the entity bound to a receiver with the case?** An empty `RecipientIds` means no entity was bound to a registered receiver with a case for the topic: check the entity's `$Receiver` and the receiver's cases. An entity has one receiver, so a later `bind` replaced an earlier one.
3. **Was the binding in place yet?** A `bind` in `init` lands with that step, so a publish racing `init` misses it. Await the `init` dispatch first, or put `$Receiver` on the value or the seed.
4. **Is it a `publishToNearest`?** It reaches the publisher's ancestors only, never the publisher, its siblings or its descendants.
5. **Is a test asserting too early?** Wait with [`settled()`](./testing.md#waiting-until-nothing-can-run) after the publishing dispatch.

## Caveats

- **`satisfies` inline,** around the cases object, would take away the cases' parameter types. Put it in a statement after the receiver.
- **A guard inside a case is not the same as not handling the topic for `publishToNearest`:** the bound entity takes the message and the walk stops there. Give the entity a receiver of its own.
- **A receiver that rebinds an entity** after a publish's yield changes nothing for that message.
- **A receiver whose entity leaves before it starts** ends cancelled, unrun.
- **A `publishToNearest` from an entity whose `$Id` the tree doesn't hold** delivers nothing, with a console warning, and lands no record.
