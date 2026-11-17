# Derived reads

A **selector** derives a value from state. It is a generator that takes a slice of state, yields only reads, and returns the value.

## Usage

The guide teaches selectors in [3. Views](../guide/03-views.md).

```ts
export function* remaining(draft: ITodoList): ISelectorGenerator<number> {
    return draft.Todos.filter((t) => !t.Done).length;
}
```

A selector is a pure derivation: given the same state, transients and [outside values](#outside-values) it returns the same value. It writes nothing, since its draft is a read-only view that refuses writes with `state/view-write`. It yields no effects, and it reads no random source and no clock but a provided one. Derived state that needs async work is an action that fetches and writes the result, plus a selector that reads it.

### Composing selectors

```ts
export function* completionRatio(draft: ITodoList): ISelectorGenerator<number> {
    const total = draft.Todos.length;
    if (total === 0) return 0;
    const left = yield* select(remaining);
    return (total - left) / total;
}
```

**A selector read in a reactive scope is memoized per entity `$Id` and selector function** ([memos](#memos)). Declare selectors at module level.

### Yields inside a callback

A `yield*` works only in a generator's own body, so a read or an effect can't sit in an array method's callback. `filterGen`, `someGen` and `mapGen`, from `treflex`, are those methods for a callback that yields, called with `yield*`. The callback gets the item and its index, and is a generator function or a function returning a generator, such as an arrow returning a read, or a selector passed by name:

```ts
function* saving(doc: IDoc): ISelectorGenerator<boolean> {
    return yield* inFlight(save, doc);
}

export function* savingDocs(draft: IBoard): ISelectorGenerator<IDoc[]> {
    return yield* filterGen(draft.Docs, saving);
}

export function* anySaving(draft: IBoard): ISelectorGenerator<boolean> {
    return yield* someGen(draft.Docs, (doc) => inFlight(save, doc));
}
```

A helper yields what its callback yields, so an action uses them too:

```ts
export function* load(draft: IBoard, names: string[]): IActionGenerator {
    draft.Docs = yield* mapGen(names, (name) => entity<IDoc>({ Name: name }));
}
```

- **Each item's callback runs to its end before the next starts,** so an action's effects in it run one at a time; [`parallel`](./fibers.md#parallel-and-parallelsettled) runs them together. `someGen` stops at the first `true`.
- **A forgotten inner `yield*` fails to compile:** a predicate's generator must return a boolean, and `mapGen`'s callback a value, so `return inFlight(save, doc)` in a `function*` is refused; one inside an object it returns, `{ Busy: inFlight(save, doc) }`, isn't. The `require-yield-star` plugin reports a forgotten outer one, for `someGen` used as a condition and any of the three discarded as a statement.
- **Pass `entity` through an arrow,** as above: passed by name, its overloads type the result `IEntity`.

### Selectors take no parameters

A feature exposes each selector as a call with no arguments: a selector declared with a required extra parameter maps to `never` on the feature, so calling it fails to compile. One whose extra parameters are all optional maps to `() => R`, and always runs without them. Two idioms cover what a parameter would:

- **Put the parameter in state.** A selector reads `draft.CurrentAppId` rather than taking an id: the selection *is* state, and the memo re-runs when it changes.
- **Parameterize in the component.** Read the collection through a selector, and close over the item in the view: `const isSelected = (id: string) => feature.selectedId() === id`.
## Rules

### The reads

A **read** is answered by the runtime from what it holds, synchronously. Eight ship, and the set is closed: an app can't add one, and no effect can take a read's name.

| Read | Answers | Page |
|---|---|---|
| `select(selector, accessor?)` | Another selector's value | [Below](#select-and-its-accessor) |
| `getData(owner, key)` | A data source from the owner's lineage, nearest first | [Lookup](./lookup.md#reading) |
| `getDataGlobal(key)` | The root-most data source for the key | [Lookup](./lookup.md#reading) |
| `getDataPath(owner, key)` | The walk `getData` takes | [Lookup](./lookup.md#getdatapath) |
| `transient(owner, name, default)` | A transient on the owner | [State tree](./state-tree.md#transients) |
| `inFlight(action, owner)` | Whether work of an action or work tag is in flight on the owner | [Actions](./actions.md#inflight) |
| `pendingAsks(owner)` | The pending asks at or below the owner | [Conversations](./conversations.md#rendering-the-open-asks) |
| `external(key)` | The value provided under the key on this runtime | [Below](#outside-values) |

Selectors and actions both yield reads with `yield*`. A read gives up no turn in an action ([steps](./actions.md#steps)).

`ISelectorGenerator<R>` yields only reads, so a selector that calls an effect creator, or a helper typed `IActionGenerator`, fails to compile. One that gets past the type through `any` throws at the yield: a refusal for a yield with no `Type`, and `No read registered for type: "X"` for anything else.

| | Effects | Reads |
|---|---|---|
| Answered by | An implementation the app registers | The runtime, from what it holds |
| Gives up a turn | Yes, unless declared `settles: "sync"` | No |
| In a selector | Never | Always |
| Recorded | An `effect` and `response` record | No, except an action's `inFlight` and `external` answers, which land on its `step` record |

### select and its accessor

`select`'s second argument is an accessor applied to the current slice before the inner selector runs, so a selector can run against a part of it:

```ts
function* isDone(todo: ITodo): ISelectorGenerator<boolean> {
    return todo.Done;
}

export function* firstDone(draft: ITodoList): ISelectorGenerator<boolean> {
    return yield* select(isDone, (list: ITodoList) => list.Todos[0]);
}
```

The accessor is a pure function: the runtime calls it and never inspects it. Where a derivation needs both an argument and a memo, run the inner selector on a sub-slice with the accessor.

### Memos

Every reader of one selector on one entity shares the memo, which re-runs only when state it read changes, and the dispose cascade drops it when the entity leaves.

- **Which reads build a memo.** A read inside a reactive scope does: a view, a Solid effect or memo, or a `select` inside a memoized selector. A feature's selector method does wherever it is called. An untracked read, such as a nested `select` under `runtime.processSelector`, reuses a memo that exists and otherwise computes without building one.
- **`runtime.processSelector(selector, getState)`** runs the selector itself fresh, with no memo of its own, for code outside a feature: devtools, a console, a server render, or a component that holds a node but no feature for it, which wraps the call in its own memo ([views](./views.md#reading-through-selectors)).
- **An action's `select` runs fresh,** nested selects included, so its `inFlight` answers are exact in the same turn as a dispatch. A memo a view reads catches up a microtask later.
- **The memo reads its entity by `$Id`.** A reader whose path comes to lead to another entity, after a reorder say, reaches that entity's memo.
- **The key is the function, never its name.** Two selectors with one name never share a memo.

### Reads in an action

**In an action, a read returns a frozen plain copy of its result,** taken at the yield, never a live reference. Re-yield to read the present. A write through the copy throws `TypeError`, so an action can't write another entity's state through a lookup. Two reads are exempt: `transient` returns the transient's live draft, which belongs to the action's own entity, and `pendingAsks` returns entries that are frozen already.

- **The result must be plain data.** A data source answering with a `Date` or a `Map` throws `NonPlainDataError` at the yield ([write path](./write-path.md#what-a-write-takes)). In a selector a read takes no copy and no check.
- **The copy costs what the result holds,** not what the read walked. For a large read, `select` a narrow selector, which runs live and copies only its result:

  ```ts
  function* openCount(draft: IBoard): ISelectorGenerator<number> {
      return draft.Rows.filter((r) => r.Open).length;
  }

  export function* report(draft: IBoard): IActionGenerator {
      const open = yield* select(openCount);
      draft.Summary = `${open} open`;
  }
  ```

- **An `external` read copies the whole value,** inside a `select` too, since the copy is what the step records ([an action's read](#an-actions-read)). A smaller copy needs a narrower key.

### Outside values

An **outside value** is data a selector derives from that the state tree doesn't hold: whether the browser is online, a breakpoint, flags an SDK owns, the locale a server render knows, the [activity log](./restart-and-records.md#the-activity-log). A runtime is given one under a key with `runtime.provideExternal`, and `external(key)` reads it. Declare each key and its value's type:

```ts
declare module "treflex" {
    interface IExternalRegistry {
        Online: boolean;
    }
}
```

#### An outside value or the tree

A value goes into the tree, through a [resource](./live-sources.md#choosing-a-resource), when its change is an event for the app or a restore should bring it back: a change that must start work, such as flushing a queue on reconnect, or a value that should come back after a restart, such as a route. Otherwise it stays outside: its changes land no record, a snapshot doesn't save it, and a restored runtime reads the value its `setup` provides.

A value only a view uses, such as a media query for layout, stays in the view. A value fixed for the runtime's life and the same for every runtime in the process, such as the page's host name, can be read directly.

#### Providing a value

```ts
export function setup(runtime: IRuntime<IInbox>): void {
    if (typeof navigator !== "undefined") {
        runtime.provideExternal("Online", {
            read: () => navigator.onLine,
            subscribe: (changed) => {
                addEventListener("online", changed);
                addEventListener("offline", changed);
                return () => {
                    removeEventListener("online", changed);
                    removeEventListener("offline", changed);
                };
            }
        });
    }
}
```

| Provider field | Does |
|---|---|
| `read()` | Returns the current value. Called at the provide and after each change |
| `subscribe(changed)` | Optional. Starts listening, calls `changed` on each change, and returns the function that stops listening |
| `equals(a, b)` | Optional. Whether two values `read` gave are the same, `Object.is` by default |
| `redact` | Optional. `true` keeps the value off an action's step record |

`read` and `subscribe` are the pair React's `useSyncExternalStore` takes, so a store an app binds that way provides unchanged. `provideExternal` returns a handle whose `changed()` does what `subscribe`'s callback does, for a provider that pushes. Provide in `setup`, the function a fresh boot and a [restore](./restart-and-records.md#the-restore-in-order) both call.

- **The runtime keeps the last value `read` gave,** one per key. On `changed` it calls `read` again, compares with `equals`, and re-runs the key's readers only on a difference. Every reader in one flush sees the same value.
- **A value is plain data, treated as immutable.** In development a value that isn't plain throws `NonPlainDataError` from `provideExternal`, which then provides nothing, or from the change that read it, which keeps the value before it: from `changed`, or from the microtask a deferred `changed` runs in. The runtime doesn't freeze a provider's value.
- **`read`, `subscribe` and the comparison run untracked,** so a provide or a change inside a reactive scope subscribes it to nothing. A `changed` called where a scope is tracking, in the body of a Solid effect or memo or of a selector, takes effect a microtask later. Anywhere else it takes effect at once, an untracked stretch inside such a body included, such as a dispatch.
- **Providing a key again** stops the first provider's subscription, leaves its handle doing nothing, reads the new provider and re-runs the readers, with an `external/replaced` warning. Nothing is unprovided.
- **`runtime.dispose()`** stops each subscription in provide order. A throw from one reports `runtime/callback-threw`. A `changed` after it does nothing, and `provideExternal` on a disposed runtime throws.

#### Reading a value

```ts
export function* canSync(draft: IInbox): ISelectorGenerator<boolean> {
    const online = yield* external("Online");
    return (online ?? true) && draft.Pending.length > 0;
}
```

In a selector, `external` tracks the key and returns the value uncopied, as every selector read does. A key nothing provides reads `undefined`, and in development its first read reports `external/unprovided`, once per key. A selector that read a key before it was provided re-runs when it is.

#### An action's read

An action reads an outside value as it reads anything: `yield* external(key)`, or a `select` of a selector that reads it. It gets a [frozen plain copy](#reads-in-an-action), and its `step` record carries what it read as `ExternalAnswers`, in read order, a nested `select`'s reads included ([record kinds](./restart-and-records.md#record-kinds)):

| Entry | When |
|---|---|
| `{ Key, Value }` | `Value` is the copy the read answered, the same object the action or its `select`'s selector got |
| `{ Key, Value, Lossy: true }` | `Value`'s JSON form doesn't give back exactly what the action got: it is or holds a `-0` |
| `{ Key, Redacted: true }` | The provider declares `redact: true`, for a value no record may hold |
| `{ Key }` | Nothing provides the key, or the action got `undefined` |

A step that read an outside value is recorded even when it wrote nothing. A view's selector records nothing. The entries are made only while a tap takes `step`, and the copy is made either way.

An action decides on an outside value only when something else runs it. A change that must start work is tree data, from a [resource](#an-outside-value-or-the-tree).

### What reports a broken rule

| Rule | Reported by |
|---|---|
| A selector doesn't write | A refusal at the write, with `state/view-write` |
| A selector yields only reads | The compiler, and a throw at the yield |
| A selector takes no parameters | The compiler, at the feature method's call |
| A selector doesn't read time or randomness, since a memo would keep one draw | The [`no-nondeterminism`](./effects.md#non-determinism) plugin, for a direct read |
| A selector reads its own slice: reading `runtime.state` from one bypasses its memo's tracking, so cross-cutting reads use `getData` ([lookup](./lookup.md)) | Nothing |
| A selector reads data from outside the tree only through `external`, never from a module global or a Solid signal, which its memo may not track | Nothing |
| An outside value is plain data | `NonPlainDataError` from `provideExternal` or `changed`, in development |
| A key is provided before it is read | `external/unprovided`, in development |
| A key has one provider | `external/replaced` |
| A read in an action returns plain data | `NonPlainDataError` at the yield |
| Keep a read in an action narrow | `action/large-read-copy`, in development |
| A selector returning a list returns nodes or strings, not fresh objects ([views](./views.md#a-list-over-a-selector)) | Nothing |

## Caveats

- **A slice with no `$Id`** isn't memoized: each call re-runs the selector.
- **A hot-reloaded selector** is a new function with a new memo, and the old one stays until the entity leaves.
- **A selector declared inside another's body** is a new function on every run, so each run builds a memo that lingers until the entity leaves: declare selectors at module level.
- **A selector run that tracks more than 50,000 reads** reports `selector/many-tracked-reads` in development, since a change to any of them re-runs the whole of it ([diagnostics](./troubleshooting.md#selectormany-tracked-reads)). Derive per row with a selector on each row entity instead.
- **A key holds one value.** A family, such as a query cache keyed by query, is one value under one key, and any change to it re-runs every reader.
- **Every memo that has read a key re-runs on each change,** whether or not anything still reads the memo, since a memo lives until its entity leaves. Throttle in `subscribe` where the source changes fast, and pass `equals` when `read` builds a fresh object each time.
- **A server render** provides in `setup` what the request knows, such as a locale, and guards browser-only providers. When the browser's first `read` differs, the view re-renders to it.
- **A read in an action that copies more than 10,000 objects and arrays** reports `action/large-read-copy` in development ([diagnostics](./troubleshooting.md#actionlarge-read-copy)). `select` a narrow selector instead.
- **`mapGen`, `filterGen` and `someGen` read the length once,** at the start, as the native methods do: an item added during the loop isn't visited, and one removed before its turn is skipped. `mapGen` leaves that item's slot empty, which a write to state refuses with `NonPlainDataError`, for an undefined array element. A callback that opens lets other work remove rows, so map over ids copied out first ([re-checking after a wait](./actions.md#re-checking-after-a-wait)).
