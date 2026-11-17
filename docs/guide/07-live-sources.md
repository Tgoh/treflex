# 7. Resources and timers

So far the reader only refreshes when asked. This page has each feed poll on a timer, and the reader listen to a push stream from the server.

## A timer

A timer is a message an entity sends itself on an interval. Declare its key, give the feed a receiver with a case for it, and start it when the feed is set up:

```ts
import { type IActionGenerator, type IReceiverId, receiver, startTimer } from "treflex";

declare module "treflex" {
    interface ITimerRegistry {
        "Feed/Poll": {};
    }
}

interface IFeed extends IEntity {
    readonly $Receiver?: IReceiverId<IFeed>;
    Url: string;
    Title: string;
    Articles: IArticle[];
}

export const FeedReceiver = receiver<IFeed>("FeedReceiver")({
    "Feed/Poll": refresh
});

export function* initFeed(draft: IFeed, info: IFeedInfo): IActionGenerator {
    yield* startTimer(draft, "Feed/Poll", FeedReceiver, 15 * 60_000);
    yield* assignFeed(draft, info);
}
```

`addFeed` mints the feed bound to its receiver, `entity<IFeed>({ $Receiver: FeedReceiver.Id, Url: url, Title: info.Title, Articles: [] })`, and starts `initFeed` on it in place of `assignFeed`.

- **Each tick runs the case as a new action on the feed.** The case is `refresh` given bare, so `inFlight(refresh, feed)` counts a polled refresh too, and the Refresh button disables during it.
- **A tick queues behind the feed's hold,** like any work. The next interval starts once the tick's action ends, so ticks never overlap.
- **The timer is a row, not running code.** Nothing runs between ticks. Removing the feed removes the row, and `stopTimer(draft, "Feed/Poll")` removes it sooner. A snapshot saves it.

## A resource

A **resource** is something live that an entity owns, outside the state tree: a socket, a stream, a worker. Its type and key are declared:

```ts
declare module "treflex" {
    interface IResourceTypeRegistry {
        push: { Params: { Endpoint: string }; Message: { Url: string } };
    }
    interface IResourceRegistry {
        "Reader/Push": { Type: "push" };
    }
}
```

The type's implementation runs the live thing and emits messages to the owner's receiver. Register it at startup, beside the receivers:

```ts
import type { IRuntime } from "treflex";

export function registerPush(runtime: IRuntime<IReader>): void {
    runtime.registerResourceType("push", (params, r) => {
        const source = new EventSource(params.Endpoint);
        source.onopen = () => r.status();
        source.onerror = () => {
            if (source.readyState === EventSource.CLOSED) r.end("refused");
            else r.status("retrying");
        };
        source.onmessage = (event) => {
            void r.emit(JSON.parse(event.data));
        };
        r.signal.addEventListener("abort", () => source.close());
    });
}
```

An action opens it, which writes a plain-data row naming the owner, the key, the receiver and the params. The runtime sets up the live instance from the row:

```ts
import { isEnded, openResource, start } from "treflex";

export function* init(draft: IReader): IActionGenerator {
    yield* openResource(draft, "Reader/Push", ReaderReceiver, { Type: "push", Endpoint: "/push" });
}

export const ReaderReceiver = receiver<IReader>("ReaderReceiver")({
    *"Feed/Gone"(draft, _message, { publisher }) {
        draft.Feeds = draft.Feeds.filter((feed) => feed.$Id !== publisher.Id);
        if (draft.SelectedId === publisher.Id) draft.SelectedId = null;
    },
    *"Action/Error"(draft, failure) {
        draft.Notice = failure.Error.Thrown === "error" ? failure.Error.Message : "Something went wrong.";
    },
    *"Reader/Push"(draft, e) {
        if (isEnded(e)) return;
        const feed = draft.Feeds.find((f) => f.Url === e.Url);
        if (feed) yield* start(refresh, feed);
    }
});
```

The boot calls `registerPush(runtime)` and dispatches `init` on the reader.

- **Each message is a new action on the owner,** delivered one at a time and queued behind the owner's hold. The push case only starts the refresh on the feed and ends, so it never holds up the next delivery.
- **It ends when the server refuses the stream.** `EventSource` reconnects by itself after a network drop, which the type reports as status, but an error answer closes it for good, and then the type ends. The receiver hears that as an `$Ended` message, which `isEnded(e)` recognises. This one leaves the stream closed; a receiver that reopens backs off with a timer first.
- **The owner's removal closes it.** Something else that ends it, such as signing out, writes `closeResource(draft, "Reader/Push")` where it is handled.

## Two mistakes

**Polling with a loop.** An action that loops on a delay effect holds the feed for its whole life, keeps `inFlight` true, and doesn't come back after a restore. Recurring work is a timer.

**A receiver that waits.** A push case that fetches the feed itself holds the reader for the fetch, and every later message waits behind it. Start the work on the entity it is for.

## Where the reference takes over

[Live sources](../reference/live-sources.md) has [opening](../reference/live-sources.md#opening), [implementing a type](../reference/live-sources.md#implementing-a-type), [ending](../reference/live-sources.md#ending), values a view reads through [`useResource`](../reference/live-sources.md#supply-and-expose), and [timers](../reference/live-sources.md#timers).

Next: [8. Asks](./08-asks.md).
