# 5. Receivers and messages

Entities talk to each other with typed messages, and neither side imports the other. This page has a feed tell the reader it is gone, an article tell a starred list it was starred, and the reader hand work to its feeds.

## Topics

A topic is a key in `IMessageRegistry`, mapped to its payload:

```ts
import { type IActionGenerator, type IEntity, type IReceiverId, publish, publishToNearest, receiver, start } from "treflex";

declare module "treflex" {
    interface IMessageRegistry {
        "Feed/Gone": {};
        "Article/Starred": { Title: string; Link: string };
    }
}
```

A misspelt topic or a payload of the wrong shape is a compile error.

## Receivers and binding

An entity hears messages through the **receiver** it is bound to. A receiver has one case per topic it handles, and each case runs as an action on the bound entity:

```ts
interface IStarred extends IEntity {
    readonly $Receiver?: IReceiverId<IStarred>;
    Items: { Title: string; Link: string }[];
}

export const StarredReceiver = receiver<IStarred>("StarredReceiver")({
    *"Article/Starred"(draft, message) {
        draft.Items.push({ Title: message.Title, Link: message.Link });
    }
});

interface IReader extends IEntity {
    readonly $Receiver?: IReceiverId<IReader>;
    Feeds: IFeed[];
    SelectedId: string | null;
    NewUrl: string;
    Starred: IStarred;
}

export const ReaderReceiver = receiver<IReader>("ReaderReceiver")({
    *"Feed/Gone"(draft, _message, { publisher }) {
        draft.Feeds = draft.Feeds.filter((feed) => feed.$Id !== publisher.Id);
        if (draft.SelectedId === publisher.Id) draft.SelectedId = null;
    }
});
```

The binding is the entity's own field, `$Receiver`, so it moves with the entity and is saved with it. Set it on the value, here in the seed, and register every receiver at startup:

```ts
import { createRuntime } from "treflex";

const runtime = createRuntime<IReader>(
    {
        $Id: "Reader",
        $Receiver: ReaderReceiver.Id,
        Feeds: [],
        SelectedId: null,
        NewUrl: "",
        Starred: { $Id: "Starred", $Receiver: StarredReceiver.Id, Items: [] }
    },
    { onError: (error) => console.error(error) }
);
runtime.registerImplementation(fetchFeedImpl);
runtime.registerReceiver(ReaderReceiver);
runtime.registerReceiver(StarredReceiver);
```

`bind(draft, receiver)` sets a binding from an action instead.

A case that switches over a union of event kinds ends with `default: event satisfies never;`, so a new kind breaks the build until a case handles it.

## publishToNearest: up to the owner

A feed that the server says is gone should leave the reader, but a row can't remove itself: its draft is the feed, not the reader's list. It tells the nearest entity above it that handles the topic:

```ts
export function* refresh(draft: IFeed): IActionGenerator {
    const info = yield* fetchFeed({ Url: draft.Url });
    if (info === null) {
        yield* publishToNearest(draft, "Feed/Gone");
        return;
    }
    yield* assignFeed(draft, info);
}
```

The reader's case removes the feed whose `$Id` the context names as the publisher.

## publish: to anyone listening

Starring an article broadcasts it. The starred list hears it because it is bound to a receiver with the case; the article knows nothing about it:

```ts
export function* star(draft: IArticle): IActionGenerator {
    yield* publish("Article/Starred", { Title: draft.Title, Link: draft.Link });
}
```

The article's feature gains `star`, and `ArticleView` a Star button that calls `article.star()`. The reader's view lists the starred articles from `reader.state.Starred.Items`.

**When a receiver runs.** Each receiver case is a new action on its own entity. It queues behind that entity's hold like any work, and starts only after the publisher has given up its turn, so the code after `yield* publish(...)` never sees what a receiver wrote. A test that checks a receiver's work waits with [`settled()`](../reference/testing.md#waiting-until-nothing-can-run).

## start: work for a child

The reader's "refresh all" hands each feed its own refresh:

```ts
export function* refreshAll(draft: IReader): IActionGenerator {
    for (const feed of draft.Feeds) {
        yield* start(refresh, feed);
    }
}
```

Each refresh runs on its feed, under the feed's hold, so the reader is free as soon as the loop ends. The reader's feature gains `refreshAll`, and its view a Refresh all button.

## Two mistakes

**Writing into a child that is held.** The reader may write into a feed, but a write into a feed whose `refresh` is waiting on the network skips the feed's hold, so `refresh` finds the feed changed after its wait; development reports it as `entity/written-while-held`. Send a change for a feed that can be busy to the feed as work, with `start` ([a parent's receiver starts work on the child](../patterns.md#a-parents-receiver-starts-work-on-the-child)).

**Reading the result straight after.** `start` doesn't wait for the started action, so the parent can't read the outcome on its next line ([a parent stops reading what it handed off](../patterns.md#a-parent-stops-reading-what-it-handed-off)).

## Where the reference takes over

[Messaging](../reference/messaging.md) has [receivers](../reference/messaging.md#receivers), [binding](../reference/messaging.md#binding), [`publish`](../reference/messaging.md#publish), [`publishToNearest`](../reference/messaging.md#publishtonearest) and [what to check when a receiver doesn't fire](../reference/messaging.md#when-a-receiver-doesnt-fire). Writing into a child is in [actions](../reference/actions.md#writing-into-a-child-entity).

Next: [6. Failures](./06-failures.md).
