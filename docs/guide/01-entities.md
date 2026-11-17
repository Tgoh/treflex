# 1. An entity and its state

This guide builds one small app, a feed reader, a step per page. Each page adds one idea and stops where its reference page takes over. This page sets up the state.

## State is a tree

A treflex app's state is one tree of plain data: objects, arrays, strings, numbers, booleans and `null`. An object in it with an `$Id` is an **entity**. Entities are what the runtime can address: work runs on an entity, messages reach an entity, and an entity's removal ends everything attached to it.

The reader holds a list of feeds, and each feed is an entity:

```ts
import type { IEntity } from "treflex";

interface IFeed extends IEntity {
    Url: string;
    Title: string;
}

interface IReader extends IEntity {
    Feeds: IFeed[];
    SelectedId: string | null;
}
```

`IEntity` is `{ $Id: string }`. Every field but `$Id` is yours to name.

## The runtime

`createRuntime` takes the initial state and returns the runtime that owns it:

```ts
import { createRuntime } from "treflex";

const runtime = createRuntime<IReader>({ $Id: "Reader", Feeds: [], SelectedId: null });
```

The root gets an `$Id` too, since only an entity can have work run on it. The seed may carry `$Id`s written by hand, such as `"Reader"`, because it is copied once. Everywhere else, ids are minted.

## Making an entity

An entity made while the app runs gets its `$Id` from `entity()`, inside an **action**, a generator function that changes the state it is given. The next page is about actions; this one only needs two:

```ts
import { entity, type IActionGenerator, idOf } from "treflex";

export function* addFeed(draft: IReader, url: string): IActionGenerator {
    const feed = yield* entity<IFeed>({ Url: url, Title: url });
    draft.Feeds.push(feed);
}

export function* selectFeed(draft: IReader, feedId: string): IActionGenerator {
    draft.SelectedId = feedId;
}
```

`yield* entity(...)` returns a copy of the value with a newly minted `$Id`, a string starting with `~`. An id is random, and anything random reaches an action as the answer to a yield, which is what lets a test name its rows and a record hold every id ([inputs arrive as answers](../design/principles.md#inputs-arrive-as-answers)). Mint first, then write: give the entity every field it needs before it lands, so nothing reads a half-made one.

Run an action by dispatching it on an entity, by `$Id`:

```ts
async function demo(): Promise<void> {
    await runtime.dispatch(addFeed, "Reader", "https://example.com/feed.json");
    const first = runtime.state.Feeds[0];
    await runtime.dispatch(selectFeed, "Reader", idOf(first));
}
```

`runtime.state` is a read-only view of the tree. Writing through it throws: every change goes through an action.

## Two mistakes

**Writing an `$Id` by hand.** `draft.Feeds.push({ $Id: "feed-1", Url: url, Title: url })` throws `HandWrittenIdError`. Use `entity()`, and keep any id a server gives you in a field of its own.

**Putting one node in two places.** `draft.Selected = draft.Feeds[0]` leaves the feed in the list and in `Selected` at once, and the action fails with `StateAliasError`. A node sits in exactly one place. Anything else that refers to it stores its `$Id`, as `SelectedId` does; `idOf(feed)` returns it.

## Where the reference takes over

[State tree](../reference/state-tree.md) has the rest: the [rules on an `$Id`](../reference/state-tree.md#rules-on-an-id), [the tree rule](../reference/state-tree.md#the-tree-rule), the three roots, and what [removal](../reference/state-tree.md#removal-ends-everything-attached) ends. How a write is checked is in [write path](../reference/write-path.md).

Next: [2. An action, and holds](./02-actions.md).
