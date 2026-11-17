# Write path

State changes one way: an action writes through its **draft**, the proxy it gets as its first argument. Every write is checked, copied, recorded and reconciled as it lands. Everything else that reads state reads a **view**, which refuses writes.

## Usage

The guide teaches writes in [2. An action, and holds](../guide/02-actions.md) and `reconcileRows` in [4. Rows](../guide/04-rows.md).

**A draft is written only during its own action's steps. Views are read-only.** To change state, dispatch an action; to change part of an entity from a view, dispatch on the entity [`locate`](./views.md#a-form-over-part-of-an-entity) names ([who can write](#who-can-write)).

State is plain data: `null`, strings, booleans, finite numbers, plain objects and arrays. Convert at the edge: epoch milliseconds for a `Date`, entries for a `Map`, a name for a function ([what a write takes](#what-a-write-takes)).

To load one entity, write its own fields: anything else on it is untouched.

### Copy and freeze

A plain value you write lands as a copy, and once it has landed the runtime deep-freezes the objects you passed:

```ts
const row = { A: 1 };
draft.Rows.push(row);
row.A = 2;             // TypeError: finish a value before writing it
draft.Rows[0].A = 2;   // change it through the draft
```

The edit afterwards throws `TypeError` in strict code; sloppy-mode code loses it silently. The `treflex/no-edit-after-write` lint rule reports the common shapes ([eslint README](../../packages/eslint/README.md#treflexno-edit-after-write)).

### Refreshing rows

Replacing a list of entities ends whatever was attached to the old rows: their running actions, bindings, timers and resources ([removal](./state-tree.md#removal-ends-everything-attached)). `reconcileRows` refreshes a list and keeps every row an incoming item matches:

```ts
function* assign(draft: IDocument, info: IDocumentInfo): IActionGenerator {
    draft.Title = info.Title;
    const added = yield* reconcileRows(draft.Rows, info.Rows, (row) => row.Id, {
        add: (item) => entity<IRow>({ Id: item.Id, Value: "", Subs: [] }),
        update: assignRow
    });
    for (const row of added) {
        yield* start(initRow, row);
    }
}

function* assignRow(row: IRow, item: IRowInfo): IActionGenerator {
    row.Value = item.Value;
    yield* reconcileRows(row.Subs, item.Subs, (sub) => sub.Id, {
        add: (sub) => entity<ISub>({ Id: sub.Id }),
        update: () => {}
    });
}
```

`reconcileRows(current, incoming, key, { add, update })`, its options typed `IReconcileRowsOptions`:

- **A row whose key matches an item keeps its node and its `$Id`,** so its work, binding and held references survive, wherever the item moved it.
- **An item nothing matched gets a new row from `add`,** which returns a row or a generator such as `entity(...)`.
- **`update` runs on every row in the result,** new or matched, so one path fills both. It is required: `update: () => {}` keeps a matched row's contents.
- **A row no item matched is removed,** and its work ends as with any removal.
- **The list ends in the incoming order,** and it is the same array afterwards, in the tree or in a transient. It returns the rows it added, as draft nodes, in list order.
- **One level at a time.** A row's own collection is a `reconcileRows` inside `update`, with its own key. Nothing matches by position.

**Refresh by key, never by position.** Copying fetched fields onto the rows by index keeps each node but gives it another record's data when the server reorders, so the work running on a row goes on with the wrong record's data.

## Rules

### When a write lands

A write lands at once. A selector read in the same step sees it, and the tree reconciles, its index, paths and removals included, when the step ends. The draft is the same object across yields, and a sub-reference held from it is the node it was navigated to ([held references](./actions.md#held-references)).

### Who can write

**A draft is written only during its own action's steps,** which include its `parallel` and `parallelSettled` branches and its `finally` blocks. A write anywhere else throws a refusal at the write and reports `state/outside-action-write`: a timer or promise callback holding a draft, a draft kept past its action, another action's body writing this action's draft. What landed before the throw stays.

**Views are read-only.** `runtime.state`, a selector's argument, `props.state`, a feature's `use().state` and `useComponentState().state` are views. A write through one throws a refusal and reports `state/view-write`.

Both are [refusals](./failure.md#refusals): a `catch` that can meet one rethrows it. The framework's own frames, mounting and unmounting component state and loading a snapshot, are the only writes outside an action. So every change to the tree is an action's step, and the record stream explains every one. An external system pushing data in does it through a [resource](./live-sources.md), whose receiver is an action.

### What a write takes

A written value holding anything but plain data, at any depth, throws `NonPlainDataError` naming the path: a class instance (a `Date`, `Map`, `Set` or `Headers` included), a function, a symbol, a bigint, `NaN`, `Infinity`, `undefined` as an array element, or a loop.

- **`undefined` in an object field** isn't stored: a written value drops the key, and writing `undefined` to a draft field deletes the field.
- **A refused write fails the action** unless caught, and what landed before it stays. An array method is the exception: `push`, `splice`, `sort` and the rest write slot by slot, and one refused partway puts back what it wrote before rethrowing, so a `catch` sees the array as it was.
- **A live node inside a value** is not copied: it is that node, moved, under [the tree rule](./state-tree.md#the-tree-rule).

An `$Id` has rules of its own at the write ([making an entity](./state-tree.md#making-an-entity), [an `$Id` names one node](./state-tree.md#an-id-names-one-node)), and so does a node crossing between [roots](./state-tree.md#a-live-node-stays-in-its-root).

### What crosses into an action

An action's draft is live. Everything else it receives is a copy of plain data, checked the same way a write is:

| What | Copy | A value with no plain form |
|---|---|---|
| Arguments, from `dispatch`, `start` or a feature method | Frozen | `NonPlainDataError`: the action fails before its first line runs, and a `start` fails at its yield in the starter |
| An effect's input | Frozen, so the implementation never holds the draft or sees its later writes | `NonPlainDataError` at the yield, naming the type, before the implementation runs |
| An effect's result | Not frozen, so the action can adjust it before writing it; a [`returns: "module"`](./effects.md#module-results) result isn't copied | `NonPlainDataError` at the yield, naming the type |
| A read's result | Frozen, except `transient` and `pendingAsks` | `NonPlainDataError` at the yield ([derived reads](./derived-reads.md#reads-in-an-action)) |
| An answer, a message payload | Frozen | `NonPlainDataError` at the sender |

So nothing either side writes afterwards reaches the other. A key holding `undefined` is dropped from every copy, so a patch argument can't clear a field by carrying `undefined`. A positional `undefined` argument is delivered as `undefined`.

**A `NonPlainDataError`** names the route in `what`, what it found in `kind`, and where in `path`: `action "save": an argument is not plain: Date at [0.When]`. It is raised wherever a value enters, before anything is written or sent, `createRuntime`'s seed included; a restore wraps it in `SnapshotRejectedError` as the `cause`. Send a plain form instead. **A `TypeError` writing to something an action received** is the frozen copy refusing: write it into the draft, where it lands as a node of its own, or spread it into a new value.

### Keys and the refresh step

Without `add`, the new row is `entity(item)`, which the types allow only when an item has the row's fields.

The key function gets live rows and incoming items alike, so it reads a field both have. Keys compare as strings, so `5` matches `"5"`; `null`, `undefined` and `""` are no key.

| Case | Result |
|---|---|
| The same key twice in either list | `ReconcileRowsKeyError`, before anything moves |
| An incoming item with no key | `ReconcileRowsKeyError`, before anything moves |
| A current row with no key | Can't match, so it's removed |
| `current` isn't an array on the draft, or `update` is missing, or `add` returns something that isn't a row | `TypeError`, before anything moves |
| `add` returns a row with a hand-written `$Id`, or one that collides with a live row | `HandWrittenIdError` or `EntityReplacedError`, before anything moves |
| Plain rows with no `$Id` | Work the same: matched rows keep their nodes |

**A refresh lands in one step.** Every `add` runs before anything moves, then the list is arranged, then `update` runs on each row inside the parent's step. So a view sees the list before or after, never between. A `settles: "sync"` effect such as `entity()` in `add` or `update` runs without ending the step. Anything that would wait throws `ReconcileRowsWaitError` at its yield: an effect that can suspend, a read such as `select` or `transient`, or an async function. Do the wait or the read before `reconcileRows`. A throw in `add` leaves the list untouched; a throw in `update` comes after the list is arranged, and what landed stays.

### What a write refuses or throws

Each is thrown in every build. A **refusal**, in [failure](./failure.md#refusals)'s sense, is a rule the calling code broke, the same whatever the data: `isRefusal(error)` is true for it, and a `catch` that can meet one rethrows it. The others are ordinary errors an action may catch.

| Error | Means | Thrown | Refusal | Stated in |
|---|---|---|---|---|
| A refusal reporting `state/outside-action-write` or `state/view-write` | Written outside the action's own steps, or through a view | At the write | Yes | [Above](#who-can-write) |
| `NonPlainDataError` | The value has no plain form | At the write or the crossing | No | [Above](#what-a-write-takes) |
| `TypeError` | The object is frozen: an argument, or something already written | At the write | No | [Above](#copy-and-freeze) |
| `HandWrittenIdError` | An `$Id` `entity()` didn't mint, or a change to one | At the write | Yes | [State tree](./state-tree.md#making-an-entity) |
| `EntityReplacedError` | A different node carrying a live `$Id` | At the write | Yes | [State tree](./state-tree.md#an-id-names-one-node) |
| `MoveBetweenRootsError` | A live node moved between roots | At the write | Yes | [State tree](./state-tree.md#a-live-node-stays-in-its-root) |
| `DraftDetachedError` | A reference to a node that has left the tree | At the access | No | [Actions](./actions.md#held-references) |
| `DraftInsideOpenError` | The draft used after a wait inside `open(...)` | At the access | Yes | [Actions](./actions.md#letting-other-work-in-open) |
| `SyncEffectWorkError` | A write inside a sync effect's implementation | At the write | Yes | [Effects](./effects.md#sync-effects) |
| `ReconcileRowsWaitError` | Something that waits inside `reconcileRows` | At its yield | Yes | [Above](#keys-and-the-refresh-step) |
| `ReconcileRowsKeyError` | A missing or repeated key | Before anything moves | No | [Above](#keys-and-the-refresh-step) |
| `StateAliasError`, `StateCycleError`, a duplicate's `EntityReplacedError` | The tree rule | When the step ends, undoing it | Yes | [State tree](./state-tree.md#the-tree-rule) |
| An empty index's `NonPlainDataError` | The tree rule | When the step ends, undoing it | No | [State tree](./state-tree.md#the-tree-rule) |

## Caveats

- **An empty array index** may exist mid-step, as `a.length = n` or `a[a.length + 2] = x` leaves one, but a step that ends with one is undone ([the tree rule](./state-tree.md#the-tree-rule)). Fill every slot before the step ends.
- **Cost.** A write costs one walk of the value, to check and copy it, and a freeze of what you passed.
