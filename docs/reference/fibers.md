# Fibers

A **fiber** is one running generator. Every dispatch has a **root fiber**, whose id is the action's `ActionId`, and every element of a `parallel` or `parallelSettled` yield runs as a **branch**. A fiber ends `completed`, `errored` or `cancelled`.

## Usage

Concurrency inside an action is `parallel` and `parallelSettled`, and nothing a branch starts outlives the yield that started it; other work is a [`start`](./actions.md#start). The patterns [stop stale work by replacing its entity](../patterns.md#stop-stale-work-by-replacing-its-entity) and [cleanup that must survive a stop belongs to a resource](../patterns.md#cleanup-that-must-survive-a-stop-belongs-to-a-resource) build on this page.

### parallel and parallelSettled

`yield* parallel(g1, g2, ...)` runs each generator as a branch, and resumes with their results in order once every branch has ended:

```ts
const [users, posts] = yield* parallel(loadUsers(), loadPosts());
```

**A failing branch stops the others, and `parallel` rethrows once they have ended.** A stopped branch runs its `finally` blocks and nothing else, and one not yet started never starts. So a `catch` around the `parallel` can rely on every branch having ended, its `finally` blocks included.

`yield* parallelSettled(g1, g2, ...)` is for branches that must all finish. No failure stops another, and the action resumes with one outcome per branch, in order, typed `IBranchOutcome<R>`: `{ ok: true, value }` or `{ ok: false, error }`.

```ts
const [users, posts] = yield* parallelSettled(loadUsers(), loadPosts());
if (users.ok) draft.Users = users.value;
if (!posts.ok) draft.PostsFailed = true;
```

### Stopping

A fiber is **stopped**, told to end, when:

- its action's entity leaves the tree, or `runtime.dispose()` runs ([removal](./state-tree.md#removal-ends-everything-attached));
- a [`latest`](./actions.md#arrival-marks) arrival replaces its action;
- a sibling branch of a `parallel` failed.

**A stop is silent:** the runtime never throws into the generator, so no `catch` sees an `AbortError`, and a stop takes no [failure route](./failure.md#the-route). In `try { ... } catch { ... } finally { ... }`, the `catch` never runs for a stop and the `finally` does. **A `finally` in an action doesn't yield** ([the close](#the-close)).

### Work entities

Work whose end must clean up state gets an entity of its own, and the work is started on it, so it is owned by, and ends with, that row:

```ts
export function* startUpload(draft: IUploads, name: string): IActionGenerator {
    const upload = yield* entity<IUpload>({ Name: name, Progress: 0 });
    draft.Uploads.push(upload);
    yield* start(runUpload, upload);
}

export function* runUpload(draft: IUpload): IActionGenerator {
    draft.Progress = yield* sendFile(draft.Name);
    yield* publishToNearest(draft, "Upload/Done", { UploadId: draft.$Id });
}

export function* cancelUpload(draft: IUploads, uploadId: string): IActionGenerator {
    draft.Uploads = draft.Uploads.filter((u) => u.$Id !== uploadId);
}
```

Cancelling is the removal: the cascade stops `runUpload`, abandons any ask the row owns, and drops its timers and resources. The worker writes only its own row, so everything it seated goes with it. What it hands elsewhere, a message or a `start` on another entity, belongs to whoever receives it.

## Rules

### Records

The records name fibers: `action:start` and `action:end` for a root, `branch:start` and `branch:end` for a branch, with `ParentBranchId` and `BranchId` ([records](./restart-and-records.md#record-kinds)).

### Fan-out results

- **`parallel`'s error is the first branch's to fail;** each failing branch's error stays on its `branch:end` record.
- **A `parallelSettled` branch's failure is only an outcome:** it takes no route unless the action rethrows it.
- A fiber waiting on either stops its branches when it is stopped, and theirs in turn. A branch can start branches of its own the same way.

### Branches and the hold

- **Branches run under the action's [hold](./actions.md#holds),** and read and write the draft. Only the action's own branches can change what a branch read across its wait.
- **A branch runs inside `open(...)` or not, as its fan-out does, and can't change that.** `parallel` and `parallelSettled` take only generators without `open`'s marker, and an `open(...)` typed `any` in a branch throws a refusal before its body runs. A branch can't [ask](./conversations.md#ask-and-answer) either.
- **Inside `open(parallel(...))`,** each branch's first step runs under the hold, so each reads what it needs before its wait. From the first wait until the `open` ends, a branch's draft throws `DraftInsideOpenError`, as the action's own does. So the branches of an open fan-out return what they read, and the action writes after:

  ```ts
  const [preview, parts] = yield* open(parallelSettled(fetchPreview(id), fetchParts(id)));
  if (preview.ok) doc.Preview = preview.value;
  if (parts.ok) doc.Parts = parts.value;
  ```

- **The fan-outs are [runtime operations](./effects.md#runtime-operations):** no implementation or stub can take their names. Test the branches' own effects instead.

### What a stop does

A fiber is also stopped when the fiber waiting on its fan-out was stopped, and when the resource running its `r.run` retires ([live sources](./live-sources.md#rrun)).

A stopped fiber stops waiting and closes a microtask later. Nothing after the wait runs, a rejection never reaches a `catch`, and [the close](#the-close) runs its `finally` blocks. It ends `cancelled`, and a root's promise resolves `undefined`.

A throw from a stopped action's `finally` depends on whether its entity is still in the tree. After a [`latest`](./actions.md#arrival-marks) replacement it is, so the throw takes the action's failure route, with `Status: "cancelled"` and `Close: true` on the `failure` event. After the entity's removal nothing can take it: it reports `action/unrouted-throw`, the `failure` event says `Taken: false`, and the promise still resolves `undefined` ([failure](./failure.md#a-stopped-actions-failure)).

- **An effect in flight is left running,** and its result goes nowhere. Its context's `signal` fires, and the implementation decides what that means for its work ([effects](./effects.md#the-action-context)). Its `effect` record gets no `response`.
- **An ask the fiber waits on** is abandoned with `Reason: "cancelled"`, ahead of the close.
- **A stop doesn't undo writes** the fiber already made, doesn't stop actions it started or receivers its messages reached, and never fires on completion or on the action's own throw.

### The close

A stop, and a throw that reaches a fiber outside its own code, close its generator with `return()`, which runs its `finally` blocks innermost first. Nothing dispatches in a close.

- **`yield* transient(...)`** returns the transient without yielding. With the owner gone, it returns a throwaway, so writes through it reach nothing.
- **Any other yield** reports `cancel/finally-yield` and is answered with another `return()`, so the rest of that `finally` block is skipped and the blocks outside it still run.
- **A `finally` that throws** leaves the blocks outside it to run.
- **Draft writes** in the close are allowed, journaled as one `step` record stamped `Cancelling: true`. In a stopped fiber they reach the nodes it last held, gone or not, without `DraftDetachedError` ([held references](./actions.md#held-references)). While the action is let go inside `open(...)`, a draft write throws `DraftInsideOpenError`.
- **The close is one unit for [the tree rule](./state-tree.md#the-tree-rule):** a `finally` that breaks it undoes every block in the close, and the refusal is reported as a throw from the close.

The [`treflex/no-yield-in-finally`](../../packages/eslint/README.md#treflexno-yield-in-finally) lint rule reports a yield in a `finally` in the source.

| How the fiber ends | `catch` runs | `finally` runs |
|---|---|---|
| The body returns | No | In the body's own step |
| The action's own code throws, an effect's rejection included | Yes | In the body's own step |
| A stop | No | In the close |
| A throw outside the action's code after a step, such as a view effect outside any `TreflexProvider` throwing in the step's flush | No | In the close, and the fiber ends `errored` |

### Cleanup belongs to the survivors

Before writing cleanup that runs when an action is stopped, ask who can see it. A stop from removal has no audience: the entity has left the tree, no view renders it, and a "mark it cancelled" write in a `finally` is unobservable. A cancel-conditional guard in a `finally`, such as `if (draft.Status === "running") draft.Status = "cancelled"`, is the sign.

- **Compensation, notifications and status** belong to the live actor that caused the removal, or to a surviving ancestor.
- **Progress a survivor might need** goes into state as the work proceeds, not into locals.
- **Something live** is a [resource](./live-sources.md), closed where its ending is handled.

A `finally` shared by completion and failure is fine. Errors never need cancel logic: a `catch` always starts as live code, where effects dispatch normally.

### Work entity rules

- **The row is state, and the started action is not.** A restore brings the row back without the action, so the owner sweeps or re-drives it ([restart](./restart-and-records.md#what-happens-to-in-flight-work)). Write progress to the row as the work goes, and a restored row says how far it got.
- **A pause is state too.** Nothing makes a fiber wait from outside, and fibers don't survive a restore, so a pause is a flag in the tree the orchestrator checks before starting the next piece. A task graph is the same shape: each node's run is a work entity, its completion is a message, and the run's receiver starts each node whose inputs are done.
- **A mark that only says work is running** on an entity that outlives the work is a [transient](./state-tree.md#transients) or [`inFlight`](./actions.md#inflight), not a work entity.

### What reports a broken rule

| Rule | Reported by |
|---|---|
| A branch can't open | The compiler, and a refusal for `open(...)` typed `any` |
| A branch can't ask | `AskRefusedError` |
| A branch of an open fan-out doesn't use the draft after its wait | `DraftInsideOpenError` |
| Nothing replaces a fan-out | Registering or stubbing `parallel` or `parallelSettled` throws |
| A `finally` in an action doesn't yield | `treflex/no-yield-in-finally` lint, and `cancel/finally-yield` during a close |
| A stopped branch's `finally` throws | `action/unrouted-throw` |
| Cleanup on a stop belongs to the survivors | Nothing: a write nobody can see is a valid write |
| An implementation that loops checks its signal | Nothing |

## Caveats

- **A throw from a stopped branch's `finally`** isn't routed: it is reported as `action/unrouted-throw` ([failure](./failure.md#a-stopped-actions-failure)).
- **A late rejection** from an effect a stop left running is absorbed.
- **Get a transient before the `try`,** so the `finally` doesn't yield at all: a stop that lands during the fiber's own step, such as from a view reacting to its write, isn't a close yet, so it takes a `transient` yield in a `finally` as an ordinary yield and skips the rest of that block, unreported.
- **After 100 yields in a close** the generator is abandoned with `cancel/finally-yield-limit`, the rest of its `finally` blocks unrun.
- **The yield in a `finally` dispatches normally** on completion and on the action's own throw, so the runtime can only report it during a close. Turn on `treflex/no-yield-in-finally`.
- **A branch stopped by a sibling's failure** dies while its entity lives, so its `finally` writes are visible. Even then, prefer the action that catches the fan-out's failure.
- **A message a worker sent before its removal is still delivered.** An owner that must ignore a removed worker's results checks the sender against the rows it holds, as `ctx.publisher.Id` in its receiver case.
- **The cost of a work entity** is an index entry and a cascade per item.
