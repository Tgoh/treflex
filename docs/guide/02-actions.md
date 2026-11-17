# 2. An action, and holds

[Page 1](./01-entities.md) made feeds. This page loads one from the network, and shows what happens to other work on an entity while an action waits.

## An effect

An action reaches the outside world by yielding an **effect**: a request described as plain data, which the runtime hands to an implementation registered for its type. Declare the effect once:

```ts
import { defineEffect, type IEffect, implementation } from "treflex";

export interface IFeedItem {
    Guid: string;
    Title: string;
    Link: string;
}

export interface IFeedInfo {
    Title: string;
    Items: IFeedItem[];
}

interface IFetchFeed extends IEffect {
    Type: "Reader/FetchFeed";
    Url: string;
}

export const fetchFeed = defineEffect<IFetchFeed, IFeedInfo | null>("Reader/FetchFeed");

export const fetchFeedImpl = implementation(fetchFeed, async (effect, action) => {
    const response = await fetch(effect.Url, { signal: action?.signal });
    if (response.status === 410) return null;
    return (await response.json()) as IFeedInfo;
});
```

The implementation answers `null` when the server says the feed is gone. The boot registers it with `runtime.registerImplementation(fetchFeedImpl)`, and a test registers a stub in its place.

## An action

```ts
import type { IActionGenerator, IEntity } from "treflex";

interface IFeed extends IEntity {
    Url: string;
    Title: string;
}

export function* refresh(draft: IFeed): IActionGenerator {
    const info = yield* fetchFeed({ Url: draft.Url });
    if (info === null) return;
    draft.Title = info.Title;
}
```

The first argument is the **draft**, the entity the action was dispatched on. Writes to it go straight into state, and views see them at the next yield. Call effects, and anything else that yields, with `yield*`. A generator called without it runs nothing ([lint setup](../reference/effects.md#lint-setup)).

**Dispatch an action on the entity it works on.** `refresh` runs on the feed, `runtime.dispatch(refresh, feedId)`, not on the reader with a feed id as an argument. The entity it runs on decides what it holds and what ends it.

## Holds

**An action holds its entity from its start to its end.** Other work that arrives on the entity while it runs, a second `refresh` or a rename, queues and starts when the hold ends. A different feed is a different entity, so its refresh runs at once.

That gives the **reading rule**: what an action read from its own entity is still true after a wait. `refresh` reads `draft.Url` before the fetch and writes `draft.Title` after it, and nothing else touched the feed in between. A second click on Refresh doesn't interleave with the first: it runs after it.

## Letting work in: `open`

When a wait holds up other work, first ask whether the work belongs on a child entity, whose own hold leaves this one free ([move long work onto a child entity](../patterns.md#move-long-work-onto-a-child-entity)); `open` is for work that must stay on this entity, as `addFeed` must, since it adds to the reader's list.

Sometimes something must get in during a wait. Adding a feed checks the address first, and the person should be able to keep typing in the address box meanwhile. Wrap the wait in `open(...)`:

```ts
import { entity, leading, open } from "treflex";

interface IReader extends IEntity {
    Feeds: IFeed[];
    SelectedId: string | null;
    NewUrl: string;
}

export function* setNewUrl(draft: IReader, url: string): IActionGenerator {
    draft.NewUrl = url;
}

export function* addFeed(draft: IReader) {
    const url = draft.NewUrl.trim();
    if (url === "") return;
    const info = yield* open(fetchFeed({ Url: url }));
    if (info === null) return;
    const feed = yield* entity<IFeed>({ Url: url, Title: info.Title });
    draft.Feeds.push(feed);
    if (draft.NewUrl.trim() === url) draft.NewUrl = "";
}
leading(addFeed);
```

- **Read what you need before the wait, and write after it.** Touching the draft during the wait throws `DraftInsideOpenError`.
- **Re-check after it.** Other work ran on the reader during the wait, so the reading rule doesn't hold across it. `addFeed` clears the box only if it still holds the address it checked.
- **A repeat gets in too.** A second click during the wait would add the feed twice, so `leading(addFeed)` drops a repeat while one is running or queued.
- **Keep the draft out of a `finally` around the wait.** An action stopped during an open wait runs its `finally` with the draft let go, so a write there throws `DraftInsideOpenError` ([caveats](../reference/actions.md#caveats)). Show that work is running with `useInFlight` ([page 3](./03-views.md#components)), not a counter cleared in `finally` ([busy is `inFlight`](../patterns.md#busy-is-inflight-not-a-flag)).
- **`addFeed` has no return type.** A function that uses `open` is open, and `IActionGenerator` refuses it, so leave it unannotated. A normal action can't call it with `yield*`; dispatch it, or `start` it.

Default to holding. Open a wait only when something must get in during it.

## Two mistakes

**Work on the parent.** `refreshFeed(draft: IReader, feedId: string)` that finds the feed and fetches holds the whole reader for the fetch: adding a feed, typing in the box and every other feed's refresh wait behind it. Put the action on the feed.

**Wrapping the whole helper.** `yield* open(refresh(feed))` lets work in and then writes the draft after the wait, which throws `DraftInsideOpenError`. Wrap the wait, `open(fetchFeed(...))`, never the code around it.

## Where the reference takes over

[Actions](../reference/actions.md) has [steps](../reference/actions.md#steps), [holds](../reference/actions.md#holds), [`open`](../reference/actions.md#letting-other-work-in-open), [re-checking after a wait](../reference/actions.md#re-checking-after-a-wait) and [`leading` and `latest`](../reference/actions.md#arrival-marks). Declaring and implementing effects is [effects](../reference/effects.md).

Next: [3. Views](./03-views.md).
