# 3. Views

[Page 2](./02-actions.md) gave the reader its actions. This page puts it on screen with React, through `treflex-react`, or with Solid, through `treflex-solid`, and each sample shows React first, then Solid. A component reads state and dispatches actions, and does nothing else: it owns no app state and cleans nothing up.

## Features

A **feature** turns an entity type's actions and selectors into a provider component and a `use()` hook. A **selector** is a generator that derives a value from state and yields only reads:

<!-- tabs -->

**React**

```ts
import type { ISelectorGenerator } from "treflex";
import { createEntityFeature } from "treflex-react";

export const Feed = createEntityFeature<IFeed>("Reader/Feed")({ refresh }, {});

function* selected(draft: IReader): ISelectorGenerator<IFeed | undefined> {
    return draft.Feeds.find((feed) => feed.$Id === draft.SelectedId);
}

export const Reader = createEntityFeature<IReader>("Reader")({ setNewUrl, addFeed, selectFeed }, { selected });
```

**Solid**

```ts
import type { ISelectorGenerator } from "treflex";
import { createEntityFeature } from "treflex-solid";

export const Feed = createEntityFeature<IFeed>("Reader/Feed")({ refresh }, {});

function* selected(draft: IReader): ISelectorGenerator<IFeed | undefined> {
    return draft.Feeds.find((feed) => feed.$Id === draft.SelectedId);
}

export const Reader = createEntityFeature<IReader>("Reader")({ setNewUrl, addFeed, selectFeed }, { selected });
```

<!-- /tabs -->

The string is the feature's id, which keeps its context across a hot update. Give each feature its own, and keep the factories in a `.ts` file that exports no components.

## Components

`Feature.provider(Body)` returns a component that takes the entity's node as `state`. Inside it, `Feature.use()` returns `state`, a read-only view of the entity, one method per action, dispatching on that entity, and one method per selector:

<!-- tabs -->

**React**

```tsx
import { useEntity, useInFlight } from "treflex-react";

export const FeedView = Feed.provider(() => {
    const feed = Feed.use();
    const refreshing = useInFlight(refresh, feed.state);
    return (
        <section>
            <h2>{feed.state.Title}</h2>
            <button disabled={refreshing} onClick={() => feed.refresh()}>
                Refresh
            </button>
        </section>
    );
});

function FeedTitle(props: { id: string }) {
    return useEntity<IFeed>(props.id)?.Title;
}

export const ReaderView = Reader.provider(() => {
    const reader = Reader.use();
    const adding = useInFlight(addFeed, reader.state);
    const selected = reader.selected();
    return (
        <main>
            <input value={reader.state.NewUrl} onChange={(e) => reader.setNewUrl(e.currentTarget.value)} />
            <button disabled={adding} onClick={() => reader.addFeed()}>
                Add
            </button>
            {reader.state.Feeds.map((feed) => (
                <button key={feed.$Id} onClick={() => reader.selectFeed(feed.$Id)}>
                    <FeedTitle id={feed.$Id} />
                </button>
            ))}
            {selected && <FeedView state={selected} />}
        </main>
    );
});
```

**Solid**

```tsx
import { For, Show } from "solid-js";
import { useInFlight } from "treflex-solid";

export const FeedView = Feed.provider(() => {
    const feed = Feed.use();
    const refreshing = useInFlight(refresh, () => feed.state);
    return (
        <section>
            <h2>{feed.state.Title}</h2>
            <button disabled={refreshing()} onClick={() => feed.refresh()}>
                Refresh
            </button>
        </section>
    );
});

export const ReaderView = Reader.provider(() => {
    const reader = Reader.use();
    const adding = useInFlight(addFeed, () => reader.state);
    return (
        <main>
            <input value={reader.state.NewUrl} onInput={(e) => reader.setNewUrl(e.currentTarget.value)} />
            <button disabled={adding()} onClick={() => reader.addFeed()}>
                Add
            </button>
            <For each={reader.state.Feeds}>
                {(feed) => <button onClick={() => reader.selectFeed(feed.$Id)}>{feed.Title}</button>}
            </For>
            <Show when={reader.selected()}>{(feed) => <FeedView state={feed()} />}</Show>
        </main>
    );
});
```

<!-- /tabs -->

The reader mounts `FeedView` with the feed's node (in React, its view), so the feed's actions dispatch on that feed. `<Show>` gates the slot, since a provider needs an entity the tree holds; in React, `selected &&` gates it.

**A React view holds each child entity as a ref,** `{ $Id }`, so `reader.state.Feeds` lists refs, and `feed.Title` through the reader's view is a compile error. React reads a child through its own provider, as `FeedView` does, through `useEntity`, as `FeedTitle` does, or through a selector, as `selected` does. Solid reads through: `feed.Title` in the reader's `<For>` is the feed's title ([entity views](../reference/views.md#entity-views)).

`useInFlight(action, entity)` is true while that action is running or queued on the entity, so `refreshing` is the feed's busy state with nothing written to keep it. It takes a node or a function returning one, so it reads a row the view holds as easily as its own entity. `FeedView` passes a function, `() => feed.state`, since `<Show>` can hand the provider another feed. In React, `useInFlight` returns a boolean and takes a view, a ref or an `$Id`, read at each render, so `FeedView` passes `feed.state`.

## Booting

`TreflexProvider` puts the runtime in context for every feature below it:

<!-- tabs -->

**React**

```tsx
// Root.tsx
import { useRoot } from "treflex-react";

export function Root() {
    return <ReaderView state={useRoot<IReader>()} />;
}

// main.tsx
import { createRoot } from "react-dom/client";
import { createRuntime } from "treflex";
import { TreflexProvider } from "treflex-react";
import { Root } from "./Root";

const runtime = createRuntime<IReader>(
    { $Id: "Reader", Feeds: [], SelectedId: null, NewUrl: "" },
    { onError: (error) => console.error(error) }
);
runtime.registerImplementation(fetchFeedImpl);

createRoot(document.getElementById("root")!).render(
    <TreflexProvider value={runtime}>
        <Root />
    </TreflexProvider>
);
```

**Solid**

```tsx
// Root.tsx
export function Root(props: { reader: IReader }) {
    return <ReaderView state={props.reader} />;
}

// index.tsx
import { createRuntime } from "treflex";
import { TreflexProvider } from "treflex-solid";
import { render } from "@solidjs/web";
import { Root } from "./Root";

const runtime = createRuntime<IReader>(
    { $Id: "Reader", Feeds: [], SelectedId: null, NewUrl: "" },
    { onError: (error) => console.error(error) }
);
runtime.registerImplementation(fetchFeedImpl);

render(
    () => (
        <TreflexProvider value={runtime}>
            <Root reader={runtime.state} />
        </TreflexProvider>
    ),
    document.getElementById("root")!
);
```

<!-- /tabs -->

In React, `useRoot()` reads the root's view, and only a component below `TreflexProvider` can call it, so `Root` mounts the reader. Solid's `Root` takes `runtime.state` as a prop, and mounts the reader from a component because a view made by `provider(...)` doesn't hot reload by itself in Solid. In both, the module that builds the runtime declares no component, so each tab's `Root` has a file of its own: hot reload runs such a module again, which would build a second runtime ([hot reload](../reference/views.md#hot-reload-and-the-id)).

`onError` hears a failed action that nothing else handled; [page 6](./06-failures.md) comes back to it.

## Three mistakes

**A busy flag.** `draft.Refreshing = true` at the top of `refresh` and `false` in a `finally` doesn't do what `inFlight` does. A click that arrives while the feed is held by other work queues, and the flag isn't set until it starts, so the button stays live and a second click queues another refresh. A guard such as `if (draft.Refreshing) return` doesn't stop it either: the repeat runs after the first has cleared the flag. `inFlight` counts queued work, and [`leading`](../reference/actions.md#arrival-marks) drops a repeat.

**Guarding a click on busy.** `if (!refreshing()) feed.refresh()` guards one button, a microtask late: `useInFlight` turns true a microtask after the dispatch, so a second dispatch in the same turn still reads `false`, and a dispatch made elsewhere, from another view or a `start`, isn't guarded at all. React's `if (!refreshing)` misses the same way: the boolean catches up at the re-render after the dispatch. Busy is for display. Mark the action `leading`, which drops a repeat from any caller.

**Writing through a view.** `feed.state.Title = "..."` throws: `state` is read-only. In React it is also a compile error. To change state, call an action.

## Where the reference takes over

[Views](../reference/views.md) has [features](../reference/views.md#features), [mounting a child feature](../reference/views.md#mounting-a-child-feature), [component state](../reference/views.md#usecomponentstate) for state only a view needs, and [React](../reference/views.md#react). Selectors and their memos are [derived reads](../reference/derived-reads.md), `useInFlight` is in [views](../reference/views.md#useinflight), and what `inFlight` counts is in [actions](../reference/actions.md#inflight).

Next: [4. Rows](./04-rows.md).
