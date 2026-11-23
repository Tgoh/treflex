# Actions

An **action** is a generator function, `(draft, ...args) => Generator`, and the unit of work. Its draft is the entity it was dispatched on. It changes state by writing the draft ([write path](./write-path.md)), and reaches anything else by yielding: effects, reads, and the runtime's own operations.

## Usage

The guide teaches actions and holds in [2. An action, and holds](../guide/02-actions.md), `useInFlight` in [3. Views](../guide/03-views.md), and `start` to a child in [5. Receivers and messages](../guide/05-messages.md).

```ts
export function* save(draft: IEditor): IActionGenerator<boolean> {
    return yield* postRecord(draft.Id, draft.Title);
}
```

Call an effect, a read or another generator with `yield*`. A bare `yield` of a call hands the runtime an unrun generator, and a generator called without `yield*` runs nothing. There is no `await` in an action.

An action runs when it is **dispatched** on an entity: `runtime.dispatch(action, target, ...args)` ([runtime](./runtime.md#dispatch)), a feature's method in a view ([views](./views.md)), [`start`](#start) from another action, or a receiver case, timer tick or resource delivery. Each dispatch is a root action with its own fiber ([fibers](./fibers.md)), its own records and its own [failure route](./failure.md#the-route). The dispatch's promise, `Promise<R | undefined>` for an action that returns `R`, resolves with the action's result, rejects with the error when it fails, and resolves `undefined` when the action doesn't run to its end ([a dispatch's result](#a-dispatchs-result)).

### Which entity owns an action

**Dispatch an action on the entity it works on.** The entity decides what holds and what ends the action.

```ts
// On the row: holds only the row, and the row's removal ends it.
function* saveRow(draft: IRow): IActionGenerator {
    yield* postRow(draft.Name);
    draft.Saved = true;
}
```

The same save dispatched on the list holds the list for the whole of `postRow`, so every add, removal and other row's save waits behind it, the row's removal included. So a row's own work goes on the row, with a provider of its own in a view ([views](./views.md#mounting-a-child-feature)), and the parent's actions change the list: add, remove, reorder. A worker on a row can't remove itself, since its draft is the row and not the array, so it tells the owner ([work entities](./fibers.md#work-entities)).

### Holds

**An action holds its entity from its start to its end.** Work that arrives on a free entity starts at once. Work that arrives on a held entity queues, in arrival order, and starts when the hold ends. Every way work arrives queues the same way: a dispatch, a `start` (the starter's own included), a receiver case, a timer tick and a resource delivery.

**The reading rule.** An entity's own fields and transients stay as its action read them across a held wait, except that an ancestor may write into them: authority flows down ([writing into a child entity](#writing-into-a-child-entity)). What it read inside a child entity can change, since a child runs its own work. A wait inside [`open(...)`](#letting-other-work-in-open) lets every writer in.

### Letting other work in: `open`

`yield* open(x)` lets other work on the entity run during the waits inside `x`:

```ts
function* loadPreview(doc: IDocument) {
    doc.Preview = yield* open(fetchPreview(doc.Id));
}
```

- **The hold goes at the first wait inside `x`,** not on entry, so `x` can read the draft before its wait.
- **From then until `x` ends, every access to the draft throws `DraftInsideOpenError`,** reads included, through every proxy of it, transients too, because what it read may no longer be true. Wrap only the wait, and write what it returns after.
- **The hold comes back when `x` ends,** queueing behind whatever got in.
- **A function that uses `open` is open:** it can't be typed `IActionGenerator`, and a normal action can't call it with `yield*`; it starts it or has it dispatched ([open functions](#open-functions)).

### start

`yield* start(action, target, ...args)` dispatches `action` on `target` from inside an action. It is fire-and-forget: a new root action with its own fiber, records and failure route, which the starter doesn't wait for and gets no result from.

```ts
export function* reopen(draft: IKitchen): IActionGenerator {
    draft.Open = true;
    yield* start(refreshLog, draft.Log);
}
```

**Work on another entity, or work that outlives the action, is a `start`.** The canonical use is a parent making a child entity and starting the child's setup on the child, so the setup is owned by, and ends with, the child:

```ts
const row = yield* entity<IRow>({ Name: name, Loaded: false });
draft.Rows.push(row);
yield* start(loadRow, row);
```

### Arrival marks

A second dispatch of an action queues behind the first. `leading` and `latest` change what a repeat does. Each marks the function it is given, for every caller, and returns it:

```ts
export function* save(draft: IEditor, title: string): IActionGenerator<boolean> {
    draft.Title = title;
    return yield* postRecord(draft.Id, title);
}
leading(save);

export function* search(draft: IPicker, text: string) {
    draft.Results = yield* open(findCustomers(text));
}
latest(search);
```

- **`leading` drops a repeat.** An arrival on an entity where the function is already running or queued runs nothing and resolves `undefined`, not the first run's result.
- **`latest` replaces.** An arrival stops the instance running or queued on that entity, and the newest wins. The stopped one resolves `undefined`.

### Durable names

A bundler renames functions, so a function's own `name` is a label, never a key. `named(action, name)` gives an action a name the app owns, the same in every build, for every caller, and returns the action:

```ts
export function* save(draft: IEditor, title: string): IActionGenerator<boolean> {
    draft.Title = title;
    return yield* postRecord(draft.Id, title);
}
named(save, "Editor/Save");
leading(save);
```

The name keys the action's records, its entry in a snapshot, and a restore's `dropped` entry, so a repair can say what a reload cut short ([restart and records](./restart-and-records.md#the-build-and-the-names)). It is any non-empty string, by convention `"Feature/Action"`, and a package that ships actions prefixes its own. Changing a name is like renaming a saved field: records and saves made before the change name the old one. The function's own identifier can change freely.

- **Mark it in the module that defines it,** with a statement after the declaration, as an arrival mark. [`npx treflex-eslint name`](../../packages/eslint/README.md#treflex-eslint-name) writes the marks for the unnamed actions it can find in a project.
- **A function takes one name, once.** Naming it again throws, with either name. In development, naming a function that has already been dispatched or delivered throws: the records made before carry no name.
- **One action per name.** An action a factory makes on each call can't be named, since every call would claim the one name; write one action that takes the factory's parameters as arguments.
- **Beside the other marks.** A named action can be `leading` or `latest` and carry work tags. Functions are still compared by identity: `inFlight` and the arrival marks don't read the name.
- **The names live in one map for the page,** shared by two copies of treflex. A second function marked with a taken name, in development, replaces the first when the mark comes from the same module, as a hot reload does, and throws when it comes from another. In production both functions keep recording the name, it resolves to neither, and every runtime hears `action/name-collision`.
- **A delivery has no name.** Its records name its receiver as `Receiver` ([messaging](./messaging.md#what-names-a-delivery)).

A runtime created with [`requireNames`](./runtime.md#requirenames) refuses, in development, an action that would be saved and has no name.

### The resumable mark

`resumable(action)` says a restore may bring the action back to the wait a snapshot caught it at, for every caller, and returns the action. It is experimental, and does nothing on a runtime without the [`resume`](./runtime.md#options) option. It needs the action's durable name, and throws when `named` hasn't marked the function yet, whether or not the runtime sets `requireNames`. What the mark promises, and what a restore does with it, is in [resume](./restart-and-records.md#resume).

### The redactArgs mark

`redactArgs(action)` keeps an action's arguments out of the record stream and the snapshot, for every caller, and returns the action. The action still receives them. It is for a secret no handle can stand in for, such as the password a sign-in form dispatches:

```ts
export function* logIn(draft: ISession, user: string, password: string): IActionGenerator {
    draft.User = yield* signIn(user, password);
}
named(logIn, "Session/LogIn");
redactArgs(logIn);
```

Here `signIn` is a [redacted](./effects.md#options) effect, so neither the arguments nor the effect's payload is recorded.

- **It covers the arguments only.** What the action writes to state is in its `step` records, and what it passes to an effect or an operation is recorded as [redaction](./effects.md#options) says.
- A field bound to [`useComponentState`](./views.md#usecomponentstate) writes each keystroke, and those writes are in `step` records before the action runs.
- **It excludes `resumable`.** A restore resumes an action with its saved arguments, which this mark keeps out of the save. Each mark throws on a function that carries the other.
- **A receiver's handle can't take it,** and `redactArgs` throws on one: a message is recorded where it was sent. Send a handle, and have the case fetch the secret.
- **Mark it like the others,** in the module that defines it, once: marking it again throws, and in development so does marking a function that has already been dispatched or delivered, since the records made before carry its arguments.

### inFlight

`yield* inFlight(action, owner)` is whether a dispatch of `action`, or a delivery whose receiver case is `action`, has arrived on `owner` and not ended: running, waiting inside `open(...)`, or queued. It is a [read](./derived-reads.md#the-reads), so it gives up no turn and a selector reacts to it. A view reads it with [`useInFlight`](./views.md#useinflight), from `treflex-solid` or `treflex-react`, on a node it holds:

```tsx
const saving = useInFlight(save, () => editor.state);

<button disabled={saving()} onClick={() => editor.save()}>Save</button>;
```

Where busy is one condition among others, a selector reads it:

```ts
function* canSave(draft: IEditor): ISelectorGenerator<boolean> {
    return draft.Dirty && !(yield* inFlight(save, draft));
}
```

Without `yield*`, `inFlight(...)` is a generator object, always truthy; the `require-yield-star` plugin reports one used as a condition.

## Rules

### Types and lint

The [`require-yield-star.grit`](../../packages/core/biome/require-yield-star.grit) Biome plugin reports a bare `yield` of a call, a treflex creator called and discarded as a statement, and `inFlight`, `pendingAsks` or [`someGen`](./derived-reads.md#yields-inside-a-callback) used as a condition without `yield*`. `IActionGenerator<R>` types an action that returns `R` and never [opens](#letting-other-work-in-open); its yields are `IActionYield`. `IAction<S, A, R>` is the type of an action function itself, as the APIs that take one spell it.

### A dispatch's result

A dispatch resolves `undefined` when:

- **its action is stopped:** its entity leaves the tree, `runtime.dispose()` runs, or a `latest` arrival replaces it ([stopping](./fibers.md#stopping));
- **it is a `leading` repeat** ([arrival marks](#arrival-marks));
- **its entity leaves while it is queued** ([removal](./state-tree.md#removal-ends-everything-attached));
- **it was made in a step that was undone** or that removed its target ([caveats](#caveats)).

Where the action itself can return `undefined`, a caller can't tell any of these from that result.

**An action returns plain data.** One that returns a promise or a thenable, a `parallel` or `parallelSettled` branch included, fails with `NonPlainDataError` instead: async work is an effect the action yields, so write `return yield* save(x)`, not `return api.save(x)`. The [`treflex/no-returned-promise`](../../packages/eslint/README.md#treflexno-returned-promise) lint rule reports that `return` in the source.

### Steps

The code between two yields is a **step**, which runs synchronously and whole. Every yield ends a step: its writes are judged by [the tree rule](./state-tree.md#the-tree-rule), recorded, and flushed to views.

Most actions need only [the reading rule](#holds). The table is for reasoning about order: whether another entity's state can change between two reads, or when a started child's first step runs.

What a yield decides is whether it **gives up a turn**, letting other work run before the action resumes:

| Yield | Gives up a turn |
|---|---|
| A [read](./derived-reads.md#the-reads): `select`, `getData`, `transient`, `inFlight`, `pendingAsks` and the rest | No |
| An effect declared [`settles: "sync"`](./effects.md#sync-effects), such as `entity()`'s mint | No |
| Any other effect | Yes, even when its implementation returns a plain value. The action resumes once the result settles |
| [`start`](#start) | Yes. The started action arrives during the yield, so on a free entity its first step runs before the starter resumes |
| `parallel`, `parallelSettled` | Yes. Each branch's first step runs during the yield, and the action resumes once every branch has ended ([fibers](./fibers.md#parallel-and-parallelsettled)) |
| `publish`, `publishToNearest` | Yes ([messaging](./messaging.md#publish)) |
| `startTimer`, `stopTimer`, `registerDataSource`, `unregisterDataSource`, `openResource`, `closeResource`, a resource method | Yes ([live sources](./live-sources.md), [lookup](./lookup.md)) |
| `ask` | Yes, until it is answered or abandoned ([conversations](./conversations.md#ask-and-answer)) |
| `answer` | No |
| The end of an `open(...)` while another action holds or waits for the entity | Yes, until the [hold comes back](#letting-other-work-in-open) |

Other actions interleave only at a yield that gives up a turn, and on the action's own entity only while the wait is inside `open(...)`.

A dispatch made while a step runs, such as `runtime.dispatch` called from action code, copies its arguments at the call and starts after the step has passed the tree rule.

### What a hold covers

- **Work that arrives on a free entity** runs its first step before `dispatch` returns.
- **A hold covers the entity's fields and its [transients](./state-tree.md#transients), down to the next `$Id`.** A child entity is free while its parent is held, and work sent to it starts at once.
- **Branches run under the action's hold** and can't change it ([fibers](./fibers.md#branches-and-the-hold)).
- **The hold ends when the last fiber of the action has ended,** a stopped branch's `finally` included.
- **Arrival and start are separate.** The arguments are copied at arrival. The node is read at start, so queued work runs on whichever node its `$Id` names when its turn comes.
- **Component state** is an entity of its own, so it holds as any entity does, and the tree entity it mounts under holds none of it.
- **A resource's `r.run` takes no hold** ([live sources](./live-sources.md#rrun)).

**Removal doesn't wait.** Removing an entity, or an ancestor of it, ends its work at once, held or not, and clears its queue: queued callers resolve `undefined` and their code never runs. Asking an entity to close or delete something is ordinary work, and queues. To close a window that may be saving, send the close to the window as work, which waits for the save, and let the window ask its owner to remove it.

### Open functions

- **`x` can't open.** `open(...)` inside `open(...)`, and `open(...)` in a branch of `parallel` or `parallelSettled`, are type errors, and code typed `any` that gets one past the compiler throws a refusal before the inner body runs. To let others in while branches run, wrap the fan-out: `open(parallel(...))`.

**A function that writes `open(...)` is open, and so is every function that calls it with a plain `yield*`.** Leave it unannotated or type it `IOpenGenerator<R>`. `IActionGenerator` refuses `open`'s marker, so a normal action can't call an open function at all; it can `start` one or have it dispatched. A helper typed `any` hides the marker, and the [`treflex/no-hidden-open`](../../packages/eslint/README.md#treflexno-hidden-open) lint rule reports that.

A helper both kinds of caller need keeps its waits unmarked. Split it where the wait meets the draft, and the open caller wraps only the wait:

```ts
function* refresh(doc: IDocument): IActionGenerator {
    seatParts(doc, yield* fetchParts(doc.Id));
}

function* refreshOpen(doc: IDocument) {
    seatParts(doc, yield* open(fetchParts(doc.Id)));
}
```

A helper that wraps a caller's wait is generic over the wait's yield type, so it is open exactly when the wait it is given is. `open`'s marker is `IOpenMark`:

```ts
function* withParts<Y extends IActionYield | IOpenMark>(
    doc: IDocument,
    wait: () => Generator<Y, IPart[], any>
): Generator<IActionYield | Y, void, any> {
    doc.Loading = true;
    seatParts(doc, yield* wait());
    doc.Loading = false;
}

function* reload(doc: IDocument): IActionGenerator {
    yield* withParts(doc, () => fetchParts(doc.Id));
}

function* reloadOpen(doc: IDocument) {
    yield* withParts(doc, () => open(fetchParts(doc.Id)));
}
```

### When `open` refuses

`DraftInsideOpenError` usually means a whole helper that uses the draft after its wait was wrapped, as `open(save(draft))`, or a branch of `open(parallel(...))` wrote after its wait: wrap only the wait, have branches return what they read, and call a helper that touches the draft across its waits from a normal action, which holds. An `open(...)` refused in a branch or inside another `open` reached the runtime through `any`: wrap the whole fan-out, or `start` the work, or call the inner function with a plain `yield*`, then type the helper that hid it. `OutsideActionError` means `open(...)` ran with no action step to work on: in a selector, or in a generator stepped by hand, as a test calling `.next()` does. Run it through a dispatch or the [test runtime](./testing.md).

### Re-checking after a wait

Re-check after a wait only where something can write what the action uses during it. Under a hold, only the action's own branches and the reading rule's exceptions can. Inside `open(...)`, every writer of the entity can run: its receiver cases, its timers and resources, its other actions, its views, and its ancestors.

```ts
const order = yield* open(fetchOrder(id));
if (draft.Stations.length === 0) return;
```

- **Re-find by `$Id`, not by index.** A position taken before an open wait addresses whatever sits there after it. `draft.Rows.find((r) => r.$Id === id)` answers `undefined` for a row that left, so one guard covers both.
- **A loop whose body opens** copies the ids out first and re-finds each row inside: a copy of the rows themselves still holds live nodes.
- **`if (!x) return;` swallows `0`, `""` and `false`;** compare with `undefined` where a wait can return one.
- **Prefer taking the writer away to detecting it:** keep the wait outside `open(...)`, or give the action an [arrival mark](#arrival-marks) when the writer is a repeat of itself.

### Writing into a child entity

**Authority flows down.** An action's draft reaches its entity's whole subtree and nothing above it, so an action may write into any child entity's fields and transients. Where the child sits belongs to the parent too: adding, removing, moving and reordering it are the parent's own writes.

- **A write into a child nobody holds is ordinary.** It is what `reconcileRows`' `update` does to the rows it matched, and what a parent does when it fills a row it is adding.
- **A write into a child another action holds** lands at once, skipping the child's hold, so that action can find the fields changed after its wait. In development it reports **`entity/written-while-held`** at info severity, naming the writer, the holder, the entity and the path, once per pair of writer and holder functions ([diagnostics](./troubleshooting.md#entitywritten-while-held)). Where the child can be busy, send the write as work, which queues behind the child's hold: `yield* start(applyEvent, doc, event)`.

The holder is whatever holds the entity as the write lands; queued work and an action waiting inside `open(...)` hold nothing. The holder's own writes, its branches' and its `finally` blocks' included, never report.

### Waits point down

**An action waits on an effect or on a child entity, never on work that needs its own entity or one above it.** Such a wait never ends: the work it waits for queues behind the hold the waiting action keeps. An effect whose implementation waits on a dispatch to the action's own entity is one, and so is a parent waiting on a child whose action waits on the parent. Nothing refuses these; the long-hold warning names them. The ask has refusals of its own for the same reason ([conversations](./conversations.md#ask-and-answer)).

### A long hold warns

A hold with work queued behind it for over a second reports **`action/long-hold`**, naming the holder, what its fibers wait on, and the queued work ([diagnostics](./troubleshooting.md#actionlong-hold)). A forgotten `open(...)`, a slow link, and a wait that points up all show here.

### What a start takes

- **The target is a node or an `$Id`.** A node is checked against the action's draft type at compile time; an id string is not. At the yield, a node has to be the node the index holds under its `$Id`, or the value `entity()` returned for a row this step wrote. Anything else, such as a copy, throws in the starter and reports `dispatch/node-mismatch`. A row an action received as an argument is a frozen copy, so pass its `$Id`.
- **An id no entity holds** reports `dispatch/unresolved-entity`, and the start does nothing.
- **It arrives like any dispatch:** on a free entity, its first step runs during the yield; on a held one it queues. A start to the starter's own entity queues behind the starter, so it starts at the starter's first wait inside `open(...)`, or once the starter has ended.
- **Its arguments cross as frozen copies;** one with no plain form throws `NonPlainDataError` at the yield, in the starter.
- **A function a restore resumed on the target** throws `UnreleasedResumeError` at the yield, in the starter, until the restore releases its held waits ([the window before the release](./restart-and-records.md#the-window-before-the-release)).
- **The target owns it,** so the target's removal ends it.
- **Its `action:start` record** names the starter as `StartedBy`.

Work beside the rest of the action on its own entity is a `parallel` branch around that rest, so the action ends with it, unless the rest opens or asks; then it is a start to the action's own entity.

### Marking a function

- **A dropped `leading` repeat** records an `action:start` and an `action:end` with `Status: "dropped"`.
- **Per function and per entity.** Two marked actions on one entity don't affect each other, and one action on two entities doesn't block itself. Functions are compared by identity, not by name. The marks' bookkeeping is the runtime's, so a restore starts clear.
- **Dispatches read the mark: a dispatch, a feature method and a `start`.** A `yield*` call doesn't, and neither does a message: a receiver case, timer tick or resource delivery reaching a marked case queues and runs.
- **Mark it in the module that defines it,** with a statement after the declaration. A function takes one mark, once; marking it again throws. Prefer the declaration form: a `const` doesn't exist until its line runs, so an import cycle that reaches it earlier fails at load.
- **The types** take only an action whose draft is an entity.
- **`resumable` follows the same rules,** after `named`, and is none of the others: a function can be `leading` or `latest`, named, tagged and resumable at once. A resumed action counts as running for `leading` and `latest`, and `inFlight` and work tags see it from the moment the restore brings it back.

### What inFlight counts

- **The owner** is the draft an action or selector was given, or an entity under it. A value snapshot or a React entity view throws; a view passes its node, view or ref to `useInFlight`.
- **Per owner.** Work on a child entity doesn't count for its parent.
- **A list reads any of its items:** `inFlight([loadPreview, loadParts], draft)`; an empty list is `false`. An item can be a [work tag](#work-tags).
- **A receiver delivery counts as its matched case and as the receiver's `handle`.** Write the case bare, `"Content/Saved": refresh`, so `inFlight(refresh, owner)` counts it; a case that calls `refresh` with `yield*` counts as itself. Records and failures name a delivery by its receiver ([messaging](./messaging.md#what-names-a-delivery)).
- **A `yield*` call has no arrival,** so a helper reached that way isn't readable by its own name. Read the action that called it.
- **It turns false however the run ends,** a throw or a stop included.

A test can stub the answers ([testing](./testing.md#stubbing-inflight)).

### Work tags

A list of actions misses one nobody added to it. A **work tag** puts the membership on each action:

```ts
export const WindowWork = workTag("Window/Work");

export function* saveDraft(draft: IEditor): IActionGenerator { /* ... */ }
WindowWork.mark(saveDraft);
```

A view reads the tag as it reads an action: `useInFlight(WindowWork, () => app.state)`.

- **`workTag(name)` returns the tag,** an `IWorkTag`, and the object is its identity: define it once, in a module the marking modules and the readers share. Two tags with one name are two tags; the name is for errors.
- **`tag.mark(...actions)`** tags each function for every caller, beside any arrival mark. A function takes any number of tags, each once; marking it with the same tag again throws.
- **Mark it in the module that defines it,** straight after the declaration. A tag counts only work that arrives after the mark, so in development marking a function that has already been dispatched or delivered throws.
- **`inFlight(tag, owner)`** is true while any work whose dispatched function or matched case carries the tag is in flight on the owner.

### Held references

A sub-reference taken from the draft is the node it was navigated to. A node that moves, by a splice, a reorder or a reparent, is still that node, and reads and writes through the reference keep landing on it, across waits included.

A node that is removed is gone. **Any access through a reference to a gone node throws `DraftDetachedError`**, a read or a write, naming where the node was. Implicit accesses throw too: a spread, `JSON.stringify`, `Object.keys`, `in`, a template literal. `isAttached(ref)` asks without the throw. When the gone node is the action's own entity, the action is stopped instead ([fibers](./fibers.md#stopping)).

A `DraftDetachedError` has three causes the message doesn't tell apart: something removed the node while the action waited, something put another node in its slot, or an ancestor left. First find the writer: if a refresh that dropped or replaced the row vacated it, refresh with `reconcileRows`, and the reference is fine as written. If the node can genuinely go during the wait, that is a normal outcome: check `isAttached(ref)`, or re-find by `$Id` after the wait and fold when it is missing. If it should not have gone, the record stream's `entity:dispose` records say which entities left and when ([records](./restart-and-records.md#record-kinds)).

- **A refresh through [`reconcileRows`](./write-path.md#refreshing-rows)** keeps every matched node, so a reference into one stays good; a row no item matched is removed, and a reference into it detaches.

Held draft references and lookup results age in opposite directions. The draft is the action's own world and must be current, so a stale reference throws. A read's result is a [frozen copy](./derived-reads.md#reads-in-an-action) of state the action doesn't own, and re-yielding reads the present.

### What reports a broken rule

| Rule | Reported by |
|---|---|
| Call effects, reads and generators with `yield*` | The `require-yield-star` Biome plugin, for the shapes and names it knows, and `treflex/no-discarded-generator` for a generator called and dropped |
| A normal action doesn't call an open function, and `open(x)` takes an `x` that doesn't open | The compiler, `treflex/no-hidden-open` for `any`, and a refusal at runtime |
| An action returns plain data, not a promise or a thenable | `treflex/no-returned-promise`, and `NonPlainDataError` when it ends |
| Don't use the draft after a wait inside `open(...)` until it ends | `DraftInsideOpenError` |
| A `start`'s node is the tree's own, or what `entity()` returned | An `Error` in the starter, and `dispatch/node-mismatch` |
| A `start`'s target is in the tree | `dispatch/unresolved-entity`; the start does nothing |
| A write into a child another action holds goes to it as work | `entity/written-while-held`, in development; the write lands |
| Waits point down | `action/long-hold` |
| A function takes one arrival mark, and each tag once | Throws at the second mark |
| A name is a string literal | `treflex/named`, which reports `named(save, save.name)` and every other non-literal |
| A name names one function | `treflex/named` within a file; at runtime, a throw at the second module's mark in development, and `action/name-collision` in production |
| Every saved action in a `requireNames` runtime has a name | `treflex/require-name`; at runtime, `UnnamedActionError` in development and `action/unnamed` in production |
| A function takes one name, before its first dispatch | A throw at the second mark; a throw at a mark after a dispatch, in development |
| A name is marked in the module that defines the action, by a statement after the declaration | `treflex/named`, which reports a `named` call inside a function or a block, or one whose result is used |
| Re-find a held node where something can remove it during a wait | `DraftDetachedError` |
| Re-check a premise where something can write it during the wait | Nothing: a write through a live reference is a valid write |

## Caveats

- **A higher-order wrapper,** as in `latest(logsFailures(fn))`, returns a new function, so its result is a `const`. That is fine unless an [import cycle reads it at load](#marking-a-function), where it fails; there, declare the action with `function*`, call the wrapper inside it, and mark the declared action.
- **Two actions interleaving on one entity:** where they do, a write to one path is last-write-wins at step granularity.
- **A dispatch made while a step runs** never starts if the step is undone, or it removed the target entity, and its promise resolves `undefined`.
- **An `open(...)` that ends on a free entity** yields nothing. So an action whose last wait is inside `open(...)` takes the hold back just to end.
- **A stop that lands while an `open`'s end waits for the hold** ends the action silently, a throw on its way out of the `open` included: no `catch` outside the `open` runs, and nothing hears the throw.
- **In an action that holds nothing,** `open(...)` changes nothing.
- **An action stopped during a wait inside `open(...)`,** or while its end waits for the hold, runs its `finally` blocks with the draft let go, so a draft write there throws `DraftInsideOpenError` and is lost ([the close](./fibers.md#the-close)). After a `latest` replacement the entity is still in the tree, so that throw takes the route as the stopped action's failure, with `Close: true` on the `failure` event; after the entity's removal it is reported as `action/unrouted-throw` ([stopping](./fibers.md#stopping)). For a busy mark that must end with the run, read [`inFlight`](#inflight) instead of writing one in a `finally`.
- **`===` doesn't throw on a gone reference,** so `indexOf` of a gone row answers `-1` silently, and an unguarded `splice(indexOf(row), 1)` removes the last row: compare by `$Id` after a wait.
- **In Node, `console.log` and `util.inspect`** read a gone reference's values without throwing.
- **A stopped fiber's `finally` blocks are exempt from `DraftDetachedError`:** they serve the nodes the fiber last held, a write through a gone reference there lands on the detached node, which nothing reads, and `isAttached` answers `true`.
- **A node removed and then written back** is live again for new work, and references to it work again, from the step after. An action dispatched on it stays stopped.
- **Two writes no throw catches,** which the console reports while a record tap is on, once per node. A write through a reference to a node the same step removed lands on the detached node: `draft/orphaned-write`. A write through a reference held across a move lands on the node, but its record's `Path` names the path the reference was taken at, where another node may now sit: `draft/stale-path-write`. Write through a reference re-derived from the draft.
