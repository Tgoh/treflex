# State tree

State is one tree of plain data. Position in it is ownership: a parent owns what sits below it, and removing a node removes everything under it. An **entity** is a node with an `$Id`, which makes it addressable: dispatch, lookup, messaging, timers, resources and cancellation all key on it.

## Usage

The guide teaches this in [1. An entity and its state](../guide/01-entities.md), and transients in [9. Restore](../guide/09-restore.md).

Declare an entity type by extending `IEntity`, which is `{ $Id: string }`:

```ts
interface ITheme extends IEntity {
    PrimaryHue: number;
}
```

A node without an `$Id` is data inside the nearest entity above it: not indexed, not addressable, and not disposed on its own. Make something an entity when it has its own lifetime, its own work, its own receiver or data sources, or its own scoped configuration. Otherwise keep it as data.

An action makes an entity with `entity()`, which returns a deep copy of the value carrying a newly minted `$Id`:

```ts
function* addRow(draft: IList, name: string): IActionGenerator {
    const row = yield* entity<IRow>({ Name: name, Done: false });
    draft.Rows.push(row);
    yield* start(initRow, row);
}
```

A minted `$Id` is a string starting with `~`. It belongs to the framework: it lasts as long as the entity, nothing should be read into it, and a server's id goes in a field of its own.

To store a reference to an entity, store its address. `idOf(node)` returns it, typed `IEntityId`, a plain string at runtime; it throws `TypeError` for anything that isn't an entity. Everything that takes a target takes the id.

```ts
draft.SelectedId = idOf(row);
```

**A node sits in exactly one place, and the tree has no loops.** Anything else that refers to a node stores its `$Id`. To change an entity, write its fields. To refresh a list of entities, use [`reconcileRows`](./write-path.md#refreshing-rows). To start again, make a new entity with `entity()`.

An entity has no `dispose()` method: removing it ends its work ([removal](#removal-ends-everything-attached)), and [stopping](./fibers.md#stopping) lists every way a running action is stopped.

**Which to use.** If losing the value on a restart would be a bug, it is state in the tree. If it is a live object, or must be closed or reopened, it is a [resource](./live-sources.md). If it is about running work, it is a [transient](#transients). Whether an action is running at all is [`inFlight`](./actions.md#inflight), not a transient.

## Rules

### Entities

An object anywhere in state with a non-empty string `$Id` is an entity. The runtime indexes every entity by its `$Id`, with its **path**: the `$Id`s from the root down to it, its own last. Lookup and `publishToNearest` walk the path upwards. The runtime keeps it current as nodes move, and nothing in an app maintains it.

Two field names are reserved: `$Id`, and `$Receiver`, the receiver an entity is bound to ([messaging](./messaging.md#binding)). The match is exact. Any other key, `$id`, `$ref` or `Id` included, is yours.

### Making an entity

- **The copy is yours until it is written.** The value passed is left alone, so a frozen argument or a live node is fine. Once written, the copy is frozen like anything written ([write path](./write-path.md#copy-and-freeze)).
- **A new top-level `$Id` wins.** `entity({ ...row })` makes a new entity from an old one. An `$Id` further down is kept, so an entity minted a moment earlier and placed inside the value stays that entity.
- **What state can't hold throws `NonPlainDataError`** before anything is minted. A non-object or an array throws `TypeError`.
- **Minting is an effect,** `generateGuid`, declared `settles: "sync"` ([effects](./effects.md#sync-effects)). So the yield ends the step without giving up a turn, it is on the record stream, and a test can stub it ([testing](./testing.md#effects-under-the-tests-control)). Writes ahead of it land first, so mint, then edit the tree.
- **Types.** The result has the literal's fields plus `$Id`, typed `IWithId<T>`. Name the type, `entity<IRow>(...)`, where a field is a union a literal would widen; that also checks the fields.
- **Make it complete.** Give every field its default before the entity lands, so a selector or view sees a stable shape from the first read. Something still to load holds a loading field and is filled by an action that writes the entity's own fields; a slot with nothing in it yet holds `null`.

#### Rules on an `$Id`

| Rule | Refused with |
|---|---|
| A draft write carries only `$Id`s that `entity()` minted, the index holds, or a node that left the tree had. This holds at any depth, in every root, and for `reconcileRows`' `add` | `HandWrittenIdError`, ahead of the write |
| An `$Id` never changes: writing a different value over one, deleting one, or giving a plain node one | `HandWrittenIdError` |
| An `$Id` is a non-empty string | `HandWrittenIdError` at a write |
| An `$Id` names one node: [below](#an-id-names-one-node) | `EntityReplacedError` |

**The `createRuntime` seed may carry plain `$Id`s,** such as `"Theme"` for a singleton, since it has one owner and is copied once. Every `$Id` in a seed is a non-empty string, unique across the tree, or `createRuntime` throws before any index is built. A singleton can pin its id in the type: `interface IPlatform extends IEntity { $Id: "Platform" }`.

**A component state factory and a transient's default hold no `$Id` at any depth,** minted or not, since each is copied per mount or per owner and every copy would share it. Either throws `HandWrittenIdError`. An action adds the nested entity afterwards with `entity()`.

### An $Id names one node

A draft write whose value carries a *different* node holding an `$Id` the index already holds throws `EntityReplacedError`, naming the `$Id` and where its node sits. The check reaches into the value, so `draft.Rows = freshRows` is refused when a fresh row carries a live `$Id`, and it holds in any slot and across a removal in the same step. Writing the same node elsewhere, as a move, swap, reorder or `filter` written back does, is not a replacement.

To hold what an entity says somewhere else, such as an edit buffer in component state or a value in another root, copy it with `withoutIds(node)`, a deep copy with every `$Id` and `$Receiver` dropped, typed `IWithoutIds<T>`, and keep `idOf(node)` in a field to write back by:

```ts
const edit = useComponentState(() => ({ ...withoutIds(props.row), RowId: idOf(props.row) }));
```

Write back the fields you edited, by name. Assigning the whole copy back would replace nested entities with plain rows, and they would end.

### The tree rule

The rule is the one in [usage](#usage): a node sits in exactly one place, and the tree has no loops. Graph-shaped data, such as links, dependencies and backlinks, is fields or flat collections of `$Id`s, and an app clears a stale one by filtering, as it would a dangling foreign key.

The rule is judged when a step ends, so the writes between two yields may pass through any shape, as a move does. A step that ends with any of these is **undone**:

| Shape at the step's end | Error |
|---|---|
| A node at two places (an alias) | `StateAliasError` |
| A node below itself (a loop) | `StateCycleError` |
| Two nodes carrying one `$Id` | `EntityReplacedError` |
| An array with an empty index | `NonPlainDataError` |

Every write the step made is put back, its `step` record never lands, nothing is disposed, and the yield's effect isn't dispatched. Then:

- **A step that ended at a yield** gets the error thrown in at that yield, so a `catch` there sees the draft as it was before the step.
- **A step that ended at `return` or a throw** ends the action errored; its own throw wins.
- **A `parallel` branch** has steps of its own, so a sibling's writes stand.

A move split across a yield leaves the node at both places at that yield, so it is undone with `StateAliasError`. Keep a move's writes in one step: seat the new place and clear the old with no yield between, and mint any entity the move needs before it starts.

```ts
target.Tickets.push(...leaving.Tickets);
leaving.Tickets = [];
draft.Stations = draft.Stations.filter((s) => s.$Id !== leaving.$Id);
```

### Three roots

The runtime holds three roots. Each is indexed and ruled as this page describes; they differ in how long what they hold lives and whether a snapshot saves it.

| Root | Holds | Saved |
|---|---|---|
| `AppState` | The tree `createRuntime` is given, read as `runtime.state` | Yes ([restart](./restart-and-records.md#snapshots)) |
| `TransientState` | Each entity's [transients](#transients), living as long as the owner | No |
| `ComponentState` | An entity per mounted component, under its nearest tree entity ([component state](#component-state)) | No |

An entity in a transient or in component state has its lineage through its owner: its path, lookup, `publishToNearest`, error routing and the dispose cascade treat it as sitting below the owner.

#### A live node stays in its root

Writing a live node into another root throws `MoveBetweenRootsError`, whether alone, inside a value, or as a `reconcileRows` row. That holds for a node new in the same step too. A move inside one root is legal, such as between two owners' transients, and the entity then ends with its new owner. To hold what a node says in another root, hold a copy ([an `$Id` names one node](#an-id-names-one-node)).

### Transients

A **transient** is a named place on an entity for data about running work, which a restart must not bring back: a progress count, a row per running upload, a pending mark. It lives in `TransientState` and is never saved.

```ts
const progress = (draft: IImport) => transient(draft, "Import/Progress", { Running: 0 });

export function* importAll(draft: IImport): IActionGenerator {
    const p = yield* progress(draft);
    p.Running++;
    try {
        yield* importRows(draft.Id);
    } finally {
        p.Running--;
    }
}

function* idle(draft: IImport): ISelectorGenerator<boolean> {
    return (yield* progress(draft)).Running === 0;
}
```

- **`yield* transient(owner, name, default)`** is one spelling in an action and a selector. The owner is the draft you were given or an entity under it. Every entity has at most one transient of each name; namespace the name as a message topic is. Share a helper between sites, as above.
- **The default** is a plain object or array, copied for each owner the first time. A default that isn't plain, or holds a live node, throws `NonPlainDataError`; one holding an `$Id` throws `HandWrittenIdError`. An unwritten transient reads as its default, and a read writes nothing.
- **In an action** it returns the transient's draft, live, ruled as the rest of the draft is: the [write path](./write-path.md), the tree rule, the record stream, with paths starting `TransientState`, the owner's `$Id` and the name. It belongs to the owner, so it follows the owner's [hold](./actions.md#holds), not the hold of the action that reached it. The yield ends the step without giving up a turn.
- **In a selector** it returns a read-only view that the selector reacts to. A view reads it through a selector ([views](./views.md#reading-through-selectors)).
- **Lifetime.** A transient goes when its owner leaves, and what it holds is disposed first, while its lineage still resolves. A removed and re-added owner starts empty, and work left from before the removal can't reach the new transient.
- **Entities inside a transient** are ordinary entities, with their lineage through the owner.

### Component state

`ComponentState` holds one entity per mounted component that asks for one through `useComponentState` or `createComponentFeature` ([views](./views.md#usecomponentstate)). It exists for state only the view needs: an open dialog's edit buffer, column widths, a selection.

- **It is an entity like any other:** indexed, held by its actions, ruled by the tree rule, and taken by `start`, `bind`, `transient`, `inFlight`, `pendingAsks` and the rest. A failure in its actions takes [the failure route](./failure.md#the-route) through its owner.
- **It mounts under the nearest tree entity,** in `AppState` or `TransientState`, never under another component's entity, so widgets nested in the render tree are siblings in state. With no provider above, it mounts under the root.
- **The framework seats it** when the component mounts, outside any action, and removes it when the component unmounts or its owner leaves, whichever comes first.
- **It is never saved.** Anything an action reads, or a receiver or a test relies on, belongs on an entity in the tree: in `AppState` if a reload must keep it, in a transient if not. An action given a copy from component state reads only its argument.

### Removal ends everything attached

Removing a node from the tree removes its subtree. Each entity in it is **disposed**, children first, and for each one the runtime, in order:

1. Ends its transients and the component state mounted under it, which dispose first.
2. **Cancel:** stops every action on the entity, running or queued ([fibers](./fibers.md#stopping)). Queued callers resolve `undefined`.
3. **Tables:** drops its data sources, timers and resource rows, and abandons the asks it owns, their askers resolving `undefined`.
4. **Caches:** drops its selector and `getData` memos.
5. **Resources:** retires its resource instances.
6. Appends an `entity:dispose` record ([records](./restart-and-records.md#record-kinds)).

Its binding is a field of its own state, so it goes with it.

What counts as removal is position: `splice`, `filter` written back, `delete`, assigning a different node or `null` over a slot, or replacing a container all remove what they drop. Changing fields, reordering, and moving a node within one step do not.

Replacing a list of entities with plain data ends whatever was attached to the old rows, silently to the code that started it: `entity/replaced-by-plain-data` warns when the dropped rows carried running work, a binding, timers or resources ([diagnostics](./troubleshooting.md#entityreplaced-by-plain-data)). Refresh such a list with [`reconcileRows`](./write-path.md#refreshing-rows).

How removal meets a hold is in [actions](./actions.md#what-a-hold-covers).

### When a rule refuses

Each of these errors is a [refusal](./failure.md#refusals): rethrow it from any `catch` that can meet one. Recognise one by `isRefusal(error)` and `error.name`.

**`StateAliasError`**, with `path`, `heldAt` and `others`: when a step ended, one node sat at two places. The usual writes:

```ts
draft.Selected = draft.Items[0];               // a node at a second place
draft.Snapshot = { ...draft.Form };            // a spread shares the nodes nested in Form
draft.Picked = draft.Rows.filter(isPicked);    // the rows stay in Rows too
```

Keep the node in one place and store its `$Id` elsewhere, or store a [copy](#an-id-names-one-node). To move a node, clear the old place in the same step.

**`StateCycleError`**, with `path`, `loop` and `others`: a write made a node hold its own ancestor, through the draft (`draft.A.B.Back = draft.A`) or inside a fresh value (`draft.A.B.Box = { Up: draft.A }`). Hold the `$Id`, and look the node up when it's needed ([lookup](./lookup.md)).

**`EntityReplacedError`**, at a write: the value carries a different node holding a live `$Id`, usually a freshly fetched object or a spread of the node assigned into the slot, or a copy that crossed a boundary such as a message payload or an effect result. At a step's end, naming two places: the step wrote one new row twice. Do what [an `$Id` names one node](#an-id-names-one-node) says instead. In a test, a stub that mints one id twice does it too.

**`MoveBetweenRootsError`**, naming both places; one shown as a root and `…` is a node new in the step: a live node was written into another root, usually a component action storing a tree row, or a transient keeping a tree row instead of its `$Id`. Write a [copy](#an-id-names-one-node) instead.

**`HandWrittenIdError`**, naming the `$Id`: a write, a component state factory or a transient's default carries an `$Id` that `entity()` didn't mint, or a write would change one. The usual causes are a literal `$Id`, `$Id: yield* generateGuid()`, a row off the wire carrying one, or `$Id: ""` standing in for an entity not made yet. Make the entity with `entity()`, keep a server's id in a field of its own, and start an empty slot as `null`.

### What reports a broken rule

| Rule | Reported by |
|---|---|
| An entity type extends `IEntity` | The compiler |
| `$Id`s come from `entity()` or the seed, and never change | `HandWrittenIdError` |
| An `$Id` names one node | `EntityReplacedError` at the write, or at the step's end for two fresh nodes |
| A node sits in one place | `StateAliasError` at the step's end |
| No loops | `StateCycleError` at the step's end |
| No empty array index | `NonPlainDataError` at the step's end |
| A live node stays in its root | `MoveBetweenRootsError` |
| Seed `$Id`s are non-empty and unique | `createRuntime` throws |
| An entity is complete when it lands | Nothing: a half-shaped value is an ordinary write |
| Make something an entity only when it needs to be one | Nothing: an over-entified list costs index and cascade work |
| Keep a move within one step | `StateAliasError` when the move spans a yield |

## Caveats

- **Cost.** Every entity costs an index entry and a step in the dispose cascade, so make something an entity only when it needs to be one.
- **Minting a list** takes `mapGen`, since a `yield*` can't sit in `.map`'s callback ([yields inside a callback](./derived-reads.md#yields-inside-a-callback)).
- **The `$Id` check catches accidents, not forgery.** It reads the `~` prefix and keeps no record of what it issued.
- **Two fresh nodes carrying one new `$Id`,** such as one minted row written twice, can't be refused at the write since neither was live; the step that lands them is undone with `EntityReplacedError` when it ends ([the tree rule](#the-tree-rule)). Mint once per row.
- **A catch that retries the same writes meets the same refusal.** After 100 refusals thrown back in a row with no step passing between, the next one ends the action errored with `action/refusal-loop` ([diagnostics](./troubleshooting.md#actionrefusal-loop)).
- **Two sites giving one transient name different defaults** share one transient. Until it is first written, a selector reads its own site's default, and every action reads the default of the first action that read it, which the first write seats. Share one helper.
- **A transient yield costs a step's flush,** so a helper that uses a transient often gets it once and holds it.
- **A value snapshot or a React entity view** reaches no transient, and passing one as the owner throws.
- **A held transient draft used after its owner left** throws `DraftDetachedError`, except in a stopped fiber's `finally`, where a write such as `p.Running--` lands on the gone transient unrecorded ([the close](./fibers.md#the-close)).
- **Writing an entity into its own transient** is a loop, refused with `StateCycleError`.
- **After a restore** every transient is empty, and no table row owned by an entity in one comes back. Two things dangle then, unreported: a tree field holding a transient entity's `$Id`, and a tree entity's data source whose data sits in a transient.
- **A move that clears the old place, yields, then writes the new place** is accepted, but it is a removal and a re-add: the node's running work, timers and resources end at the removal, and its transients start empty. The same goes for any node removed in one step and written back in a later one. Keep a move in one step ([the tree rule](#the-tree-rule)).
- **A dispose callback that throws** stops only itself, reported as `runtime/callback-threw`.
- **`instanceof` misses a refusal** when a bundler has loaded the module twice. Test with `isRefusal(error)` and `error.name`.
