# 8. Asks

Unsubscribing from a feed should ask first. An **ask** is an action waiting on a decision: `ask` opens it and waits, a view renders the open asks, and `answer` ends it.

## Asking

```ts
import { answer, ask, type IActionGenerator, type IAskEntry, type IAskId, type ISelectorGenerator, open, pendingAsks } from "treflex";

export function* unsubscribe(draft: IReader, feedId: string) {
    const feed = draft.Feeds.find((f) => f.$Id === feedId);
    if (!feed) return;
    const sure = yield* open(ask<boolean>(feed, { Path: "Feed/Unsubscribe", Title: feed.Title }));
    if (!sure) return;
    draft.Feeds = draft.Feeds.filter((f) => f.$Id !== feedId);
    if (draft.SelectedId === feedId) draft.SelectedId = null;
}

export function* reply(_draft: IFeed, askId: IAskId<boolean>, sure: boolean): IActionGenerator {
    yield* answer(askId, sure);
}
```

- **The owner is what the ask is about,** here the feed. Whatever removes the feed ends the ask, and the asker resumes with `undefined`. So does a dismissal: `answer(id)` with no value.
- **The request is plain data of the app's own shape.** `Path` is how a view knows which dialog to show.
- **The wait goes inside `open(...)`.** The answer is work on the owner, and an ask whose wait holds is refused with `AskRefusedError`. Since other work runs during the wait, `unsubscribe` removes the feed by `$Id` afterwards, which is safe if the feed has already gone.
- **The answer runs on the owner,** or an entity below it. `reply` is dispatched on the feed.

## Rendering the open asks

`pendingAsks(owner)` lists the open asks at or below an entity. It is a read, so a view reads it through a selector. The sample keeps the feature and the components together; in the app, the feature goes in its `.ts` file, as on page 3:

<!-- tabs -->

**React**

```tsx
import { createEntityFeature, useDispatch } from "treflex-react";

function* asks(draft: IReader): ISelectorGenerator<readonly IAskEntry[]> {
    return yield* pendingAsks(draft);
}

export const Reader = createEntityFeature<IReader>("Reader")(
    { setNewUrl, addFeed, selectFeed, refreshAll, dismissNotice, unsubscribe },
    { selected, asks }
);

function UnsubscribeDialog(props: { entry: IAskEntry }) {
    const dispatch = useDispatch();
    const choose = (sure: boolean) => dispatch(reply, props.entry.OwnerId, props.entry.Id as IAskId<boolean>, sure);
    return (
        <dialog open>
            Unsubscribe from {(props.entry.Request as { Title: string }).Title}?
            <button onClick={() => choose(true)}>Unsubscribe</button>
            <button onClick={() => choose(false)}>Keep</button>
        </dialog>
    );
}

export const Dialogs = Reader.provider(() => {
    const reader = Reader.use();
    return reader
        .asks()
        .filter((entry) => (entry.Request as { Path: string }).Path === "Feed/Unsubscribe")
        .map((entry) => <UnsubscribeDialog key={entry.Id} entry={entry} />);
});
```

**Solid**

```tsx
import { createEntityFeature, useDispatch } from "treflex-solid";
import { For, Show } from "solid-js";

function* asks(draft: IReader): ISelectorGenerator<readonly IAskEntry[]> {
    return yield* pendingAsks(draft);
}

export const Reader = createEntityFeature<IReader>("Reader")(
    { setNewUrl, addFeed, selectFeed, refreshAll, dismissNotice, unsubscribe },
    { selected, asks }
);

function UnsubscribeDialog(props: { entry: IAskEntry }) {
    const dispatch = useDispatch();
    const choose = (sure: boolean) => dispatch(reply, props.entry.OwnerId, props.entry.Id as IAskId<boolean>, sure);
    return (
        <dialog open>
            Unsubscribe from {(props.entry.Request as { Title: string }).Title}?
            <button onClick={() => choose(true)}>Unsubscribe</button>
            <button onClick={() => choose(false)}>Keep</button>
        </dialog>
    );
}

export const Dialogs = Reader.provider(() => {
    const reader = Reader.use();
    return (
        <For each={reader.asks()}>
            {(entry) => (
                <Show when={(entry.Request as { Path: string }).Path === "Feed/Unsubscribe"}>
                    <UnsubscribeDialog entry={entry} />
                </Show>
            )}
        </For>
    );
});
```

<!-- /tabs -->

The reader's view mounts `<Dialogs state={reader.state} />`, and a feed's Unsubscribe button calls `reader.unsubscribe(feed.$Id)`. Each entry is `{ Id, OwnerId, Request }`, and the dialog answers by dispatching on `entry.OwnerId`. `useDispatch()` dispatches on any entity, for a component that has no feature for it.

## Two mistakes

**Answering from the asker.** Dispatching `reply` on the reader throws `AnswerOutsideOwnerError`: the reader is above the feed, not at or below it. Dispatch on `entry.OwnerId`.

**An ask with nobody rendering it.** An ask nothing renders waits for good, and nothing reports it. A view needs a selector reading `pendingAsks` on the owner or an entity above it.

## Where the reference takes over

[Conversations](../reference/conversations.md) has [`ask` and `answer`](../reference/conversations.md#ask-and-answer), [a decision the server must accept](../reference/conversations.md#a-decision-the-server-must-accept), [what ends an ask](../reference/conversations.md#what-ends-an-ask), and [the durable conversation](../reference/conversations.md#the-durable-conversation) for a question that must survive a reload. A test answers an ask as a view does: [work on a held entity](../reference/testing.md#work-on-a-held-entity).

Next: [9. Restore](./09-restore.md).
