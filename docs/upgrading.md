# Upgrading

What an app meets when it moves to a new treflex release, and what to change. The five packages share one version and move together.

## From 0.2 to 0.3

Move all five packages to 0.3.0 at once: `treflex-solid` and `treflex-react` peer on `treflex` at that exact version. The changes that bring no type error come first, since only a test or a development build shows them.

### Changes that fail quietly

**A rejection reaches an action as a copy** ([the rule](./reference/effects.md#a-rejection-crosses-as-a-copy)). What an implementation rejects with reaches the action as a copy of its nearest native error type, so `instanceof` an app's or a library's class is false for it, and a `catch` that tests the class takes whatever branch handles the unexpected. A development build reports [`effect/class-rejection`](./reference/troubleshooting.md#effectclass-rejection) and a test on `createTestRuntime` fails on it, but a production build reports nothing. A `-0` in an effect's answer arrives as `0`, and `IExternalAnswer.Lossy` is gone.

- Search for `instanceof` on a caught value inside an action, and for helpers that do the same.
- Answer the expected failure with data from the implementation, and throw the app's class from a `yield*` helper beside the effect, inside the action.
- A copy keeps the original's `name` and its enumerable own fields, so a test of `name` or of a tag field works until then.
- Run the app's tests on `createTestRuntime`, and a development build, once before shipping.

**A step's record reaches taps before the step's reactive effects** ([the tap](./reference/restart-and-records.md#the-tap)). In 0.2 a tap heard a step after the effects its writes triggered had run.

- A tap listener runs before the effects of the step it hears. A value an effect or `createComputed` keeps up to date is not yet updated for that step when the listener reads it. A memo reads fresh.
- Where a reactive effect dispatches, the dispatched work's records follow the record of the step that caused it. A consumer that relied on the old order, or reordered records to mend it, needs changing.
- Where a listener and an effect both write one field in response to a step, the effect's write lands last. In 0.2 the listener's did.
- A listener's own signal writes join the step's batch. An effect on such a signal runs after the listener returns, where in 0.2 it ran inside the write.
- `treflex-react`'s hooks built on a watch, `useInFlight`, `useResource` and a feature's selector hooks, are told of a change after a tap, where in 0.2 they were told before. A store subscription for a tree write is still told first.

**An outside value's `changed` takes effect at once wherever it is called** ([providing a value](./reference/derived-reads.md#providing-a-value)). In 0.2, a `changed` called where a scope was tracking, in an effect, a memo or a selector, took effect a microtask later.

- A read right after a `changed` in a tracking scope gets the new value. A test that asserts the old value there fails; one that awaits a microtask first sees what it saw before.
- A computation that changes a key it read runs once more within the flush, not a microtask later.

**A restore started inside an effect or a memo doesn't subscribe that computation** to what the restore reads ([the restore, in order](./reference/restart-and-records.md#the-restore-in-order)), with resume on or off.

**A Solid app, on Solid 2** (see [the changes that report](#changes-that-report)):

- An app that never imports `treflex-solid`, or imports it only for a name nothing uses, renders views that never update.
- A selector that reads a Solid signal or store doesn't re-run when it changes, where in 0.2 its memo tracked it. Outside state goes through [`external`](./reference/derived-reads.md#providing-a-value).
- Solid views catch up at Solid's flush, and during a hold when it lands, while a record tap and `treflex-react` hear a write inside the dispatch. During a hold the screen can tear ([Solid's timing](./reference/views.md#solids-timing)).
- A treflex value never suspends, so a `<Loading>` over plain treflex reads never shows its fallback.

### Changes that report

**`changed` reports what it used to swallow.** A change that never settles throws `[treflex] Potential infinite loop` from the write that started the flush. A dispatch whose step set it off rejects with it, and its record ends `Status: "errored"` though its step committed. A non-plain value throws `NonPlainDataError` from `changed`, to its caller.

**`treflex-solid` runs on Solid 2.** `solid-js` leaves `treflex`'s dependencies, and `treflex-solid` peers `solid-js` and `@solidjs/web` `^2.0.3`, so a Solid app on 1.9 gets a peer conflict at install and moves to Solid 2 with treflex. A React app installs no Solid, and drops a `solid-js` it carried for treflex. Beside Solid 2's own changes:

- **The toolchain.** Install `@solidjs/web`, compile with `@solidjs/vite-plugin` on Vite 8 in place of `vite-plugin-solid`, and set `"jsxImportSource"` to `"@solidjs/web"`; `"solid-js"` fails with TS2875. On TypeScript before 5.7, set `skipLibCheck`. A component test under Vitest's `"node"` environment adds the `"browser"` condition. The build and the tests need Node 22.12 or later, the floor `solid-js`, `@solidjs/web` and `@solidjs/vite-plugin` declare.
- **A view's throw is Solid's.** `TreflexProvider` holds no boundary: the app's own `<Errored>` takes the throw, and with none Solid stops every view on the page. Put an `<Errored>` at the root, as the Solid template does. A view's throw never fails an action.
- **One copy of `solid-js`.** A component rendered by another copy makes `TreflexProvider` throw `[treflex] TreflexProvider found no Solid owner`, and a second `treflex-solid` on another copy throws `[treflex] Two copies of solid-js are loaded` at import. Dedupe `solid-js` and `@solidjs/signals` ([one copy](./reference/views.md#one-copy-of-solid-js)).
- **A development-build warning.** `useComponentState`'s `id` or `state`, or a component feature's `use().state`, read in a component body raises Solid's `STRICT_READ_UNTRACKED`. Read them where they are used.
- **`useInFlight`'s refusal of a plain copy** throws at the accessor's first read, not at the call, so a copy nothing reads is silent.
- **A missing `TreflexProvider`** above `createEntityFeature`'s provider or `useResource` throws the error naming it.
- **Tests.** A test that writes a Solid signal and reads it back in one tick, typing into an input and then clicking submit, awaits `settled()` between the two. A test that made a view without rendering it, with `void (<Provider>…)` or by calling `TreflexProvider(…)` directly, renders it, since a provider's children run only when read.

**A new lint rule in the recommended config.** [`treflex/no-main-state-in-lifecycle`](../packages/eslint/README.md#treflexno-main-state-in-lifecycle) joins `configs.recommended`. It reports a component starting main-state work from its lifecycle ([where an action starts](./reference/views.md#where-an-action-starts)), and a disable comment for it with no reason.

### Changes that fail to compile or install

- **`SolidServerBuildError` is gone.** Core runs on its own reactive engine and imports no `solid-js`, so construction checks for nothing. Remove the import. Resolve conditions an app set to avoid the error no longer matter to the runtime.
- **A restore's result carries `resumed`, and each dropped entry a `reason`.** A test that builds a restore's result by hand adds `resumed: []`, and a `reason` to each `IRestoreDrop`. A test that compares a result or a dropped entry whole expects them too. Without resume, each dropped entry's `reason` is `"resume-off"`.
- **`treflex-eslint` peers `eslint >=9.1`.** An app on ESLint 9.0 gets a peer conflict at install and moves to a later 9.x.
- **`treflex-eslint` and `create-treflex` need Node 22.13 or later.** On an earlier Node 22, npm warns at install, or refuses under `engine-strict`.

### New in 0.3

- **Resume, experimental.** A restore can bring an in-flight action back to the wait its snapshot caught it at, through [`resumable`](./reference/actions.md#the-resumable-mark), the `resume` runtime option and `idempotent` on an effect's declaration ([resume](./reference/restart-and-records.md#resume)). Experimental means its API may change in any release before 1.0, a minor one included. A runtime without the `resume` option restores as 0.2 did, apart from the subscription change above.
- **[`redactArgs`](./reference/actions.md#the-redactargs-mark)** keeps an action's arguments out of the record stream and the snapshot.
- **Snapshot format 8** gains two optional in-flight fields, `State` and `Place`. 0.2 reads a 0.3 save and ignores them, and 0.3 reads a 0.2 save ([what a snapshot holds](./reference/restart-and-records.md#what-a-snapshot-holds)).
- `differentialRestore` in `treflex/snapshot` ([testing every restore point](./reference/testing.md#testing-every-restore-point)), `Landing` as a step tap's opt-in, and `reconcileRows` over a record of rows ([refreshing rows](./reference/write-path.md#a-record-of-rows)).
