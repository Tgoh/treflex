# 6. Failures

A refresh can fail: the server is down, or answers with an error. This page sends those failures to one place that shows them, and logs every failure once.

## Failing on purpose

What can go wrong with a request becomes part of the effect's answer, and a helper beside the effect throws it as one error class, so an action can tell an outage from a bug in its own code:

```ts
import { defineEffect, type IActionGenerator, implementation } from "treflex";

export type IFeedAnswer = { Info: IFeedInfo | null } | { Status: number; Message: string };

export const fetchFeed = defineEffect<IFetchFeed, IFeedAnswer>("Reader/FetchFeed");

export class FeedError extends Error {
    readonly Status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "FeedError";
        this.Status = status;
    }
}

export function* loadFeed(url: string): IActionGenerator<IFeedInfo | null> {
    const answer = yield* fetchFeed({ Url: url });
    if ("Info" in answer) return answer.Info;
    throw new FeedError(answer.Status, answer.Message);
}

export const fetchFeedImpl = implementation(fetchFeed, async (effect, action) => {
    const response = await fetch(effect.Url, { signal: action?.signal }).catch(() => null);
    if (response === null) return { Status: 0, Message: "The feed couldn't be reached." };
    if (response.status === 410) return { Info: null };
    if (!response.ok) return { Status: response.status, Message: `The feed answered ${response.status}.` };
    return { Info: (await response.json()) as IFeedInfo };
});
```

`refresh` and `addFeed` call `yield* loadFeed(url)` where they yielded `fetchFeed`. `refresh` doesn't catch the `FeedError`, so the refresh fails.

The implementation answers with data and throws only what it didn't expect. What it throws reaches the action as a copy of its native error type, so a `FeedError` thrown there would arrive as a plain `Error` that no `instanceof FeedError` matches ([effects](../reference/effects.md#a-rejection-crosses-as-a-copy)).

## The route

**A failure is handled by the first thing that takes it.** Inside the action, that is a `catch`. Once the throw leaves the action, it goes to the nearest **error boundary** above the failing entity: an ancestor bound to a receiver with an `Action/Error` case. With none, it goes to `onError`, the runtime's root taker.

The reader makes itself the error boundary for everything below it by adding the case to its receiver, and shows the failure until the person dismisses it:

```ts
import { type IActionGenerator, receiver } from "treflex";

export const ReaderReceiver = receiver<IReader>("ReaderReceiver")({
    *"Feed/Gone"(draft, _message, { publisher }) {
        draft.Feeds = draft.Feeds.filter((feed) => feed.$Id !== publisher.Id);
        if (draft.SelectedId === publisher.Id) draft.SelectedId = null;
    },
    *"Action/Error"(draft, failure) {
        draft.Notice = failure.Error.Thrown === "error" ? failure.Error.Message : "Something went wrong.";
    }
});

export function* dismissNotice(draft: IReader): IActionGenerator {
    draft.Notice = null;
}
```

The reader gains a `Notice: string | null` field, seeded `null`, which its view shows with a Dismiss button; the reader's feature gains `dismissNotice`. `failure.Error` is the throw serialized as data, since a message carries data. With this case, a failed refresh on any feed shows its message. A case that should pass a failure on up rethrows the payload it was given.

## Its own failures

No entity hears its own failure: the route starts at the parent. The reader is the root, so a failure in `addFeed` would go straight to `onError`. Where an entity must react to its own failure, it catches it, and it catches only what it expects:

```ts
import { entity, leading, open, start } from "treflex";

export function* addFeed(draft: IReader) {
    const url = draft.NewUrl.trim();
    if (url === "") return;
    let info: IFeedInfo | null;
    try {
        info = yield* open(loadFeed(url));
    } catch (error) {
        if (!(error instanceof FeedError)) throw error;
        draft.Notice = `Couldn't add ${url}: ${error.message}`;
        return;
    }
    if (info === null) return;
    const feed = yield* entity<IFeed>({ Url: url, Title: info.Title, Articles: [] });
    draft.Feeds.push(feed);
    yield* start(assignFeed, feed, info);
    if (draft.NewUrl.trim() === url) draft.NewUrl = "";
}
leading(addFeed);
```

Anything that isn't a `FeedError` is a bug, and goes on to `onError`.

## Logging

`runtime.on("failure", ...)` hears every action's failure once, whoever took it. It observes and takes nothing, so keep an `onError` at the root that does nothing else. The boot, with page 5's seed plus `Notice: null`:

```ts
import { createRuntime } from "treflex";

const runtime = createRuntime<IReader>(seed, { onError: () => {} });
runtime.registerImplementation(fetchFeedImpl);
runtime.registerReceiver(ReaderReceiver);
runtime.registerReceiver(StarredReceiver);
runtime.on("failure", (event) => console.error(`${event.Name ?? event.Label} failed`, event.Error));
```

## Two mistakes

**Logging with no root taker.** Without `onError`, a failure nothing else takes is an unhandled rejection as well as a `failure` event, so it is reported twice.

**Catching in the view.** `feed.refresh().catch(...)` handles the failure a second time: the route has it already. A view discards the promise. Where a view must branch on the outcome, the action catches the failure and returns it as data.

## Where the reference takes over

[Failure](../reference/failure.md) has [the route](../reference/failure.md#the-route), [error boundaries](../reference/failure.md#error-boundaries), [`onError`](../reference/failure.md#onerror), [the `failure` event](../reference/failure.md#the-failure-event), and [refusals](../reference/failure.md#refusals), the errors a `catch` must always rethrow. A view's own throw is [a view crash](../reference/failure.md#a-views-throw), not an action's failure.

Next: [7. Resources and timers](./07-live-sources.md).
