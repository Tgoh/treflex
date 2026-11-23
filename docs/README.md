# treflex documentation

Start with the [quickstart](./quickstart.md): a counter in React or Solid, made by `npm create treflex` or added to an app by hand. [Requirements](./requirements.md) has the packages, the versions and the build setup. [Upgrading](./upgrading.md) has what changes from one release to the next.

Four tiers. Each fact is stated once, on the page where a reader acts on it, and everything else links there.

| Tier | For | Read it |
|---|---|---|
| [Guide](#guide) | Building a first feature | In order |
| [Patterns](#patterns) | Shapes that cross concepts | When a design needs one |
| [Reference](#reference) | Every rule, one page per concept | On demand |
| [Design](#design) | Why treflex is shaped as it is | When asking why |

## Guide

One small app, a feed reader, built a step per page. Each page ends where its reference page takes over.

1. [An entity and its state](./guide/01-entities.md): `createRuntime`, entities, minted ids.
2. [An action, and holds](./guide/02-actions.md): effects, holds, `open(...)`, the reading rule.
3. [Views](./guide/03-views.md): `TreflexProvider`, features, selectors, `useInFlight`.
4. [Rows](./guide/04-rows.md): choosing the entities, rows as entities, `reconcileRows`, a refresh per type.
5. [Receivers and messages](./guide/05-messages.md): `bind`, `publish`, `publishToNearest`, `start` to a child.
6. [Failures](./guide/06-failures.md): the route, an error boundary, `onError`, logging.
7. [Resources and timers](./guide/07-live-sources.md): a poll timer and a push stream.
8. [Asks](./guide/08-asks.md): `ask`, `answer`, rendering `pendingAsks`.
9. [Restore](./guide/09-restore.md): transients, snapshots, `restoreRuntime`.

## Patterns

[`patterns.md`](./patterns.md): rows as entities, where long work goes, holding or opening a wait, busy state, stopping stale work, a `latest` action reading its inputs from state, parents and children, one owner for each fact, refreshing server data and sending rows back, timers and timed rows, cleanup that survives a stop, a child calling its parent's resource, facts as messages and connection state as status, catching failures, work tags, per-row view state.

## Reference

One page per concept:

1. [State tree](./reference/state-tree.md): entities and identity, minted ids, the tree rule, the three roots, transients, component state, removal.
2. [Write path](./reference/write-path.md): how a write lands, what it refuses, `reconcileRows`.
3. [Actions](./reference/actions.md): steps, holds, `open`, `start`, `leading` and `latest`, `inFlight`, work tags, held references.
4. [Effects](./reference/effects.md): declaring and implementing effects, sync effects, the data-only rule, the action context.
5. [Fibers](./reference/fibers.md): `parallel` and `parallelSettled`, stopping, the close, work entities.
6. [Derived reads](./reference/derived-reads.md): selectors, the reads, yields inside a callback, memos, reads in an action, outside values.
7. [Lookup](./reference/lookup.md): data sources, `getData`.
8. [Messaging](./reference/messaging.md): receivers, binding, `publish`, `publishToNearest`.
9. [Live sources](./reference/live-sources.md): resources and timers.
10. [Conversations](./reference/conversations.md): `ask`, `answer`, `pendingAsks`.
11. [Failure](./reference/failure.md): the route, error boundaries, `onError`, the `failure` event, refusals, a view's throw.
12. [Restart and records](./reference/restart-and-records.md): snapshots, `restoreRuntime`, the record stream, the activity log.

Four pages cut across them:

- [Views](./reference/views.md): the Solid and React bindings, features, `useDispatch` and `useLocate`, component state.
- [Runtime](./reference/runtime.md): `createRuntime` and its options, `IRuntime`, runtime services.
- [Testing](./reference/testing.md): `createTestRuntime`, stubs, `settled`, `guids`, testing a restore.
- [Troubleshooting](./reference/troubleshooting.md): symptoms and their causes, and every diag code, what triggers it, and what to do.

## Design

- [`principles.md`](./design/principles.md): the seven principles treflex is built on, and why.
- [`choices.md`](./design/choices.md): how treflex is built to them, and why.

## Examples

[`demos/todo/`](../demos/todo/) is one entity in one file. [`demos/portal/`](../demos/portal/) is the live demo the [top-level README](../README.md#getting-started) links, and its README maps each capability onto its files. [`demos/react-todo/`](../demos/react-todo/) and [`demos/react-portal/`](../demos/react-portal/) are the same apps in React, and [`demos/portal-swap/`](../demos/portal-swap/) switches the portal between its Solid and React views in place. [`demos/checkout/`](../demos/checkout/) is a flow written as one action, a checkout of several questions, and what a reload does to it.
