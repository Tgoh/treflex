# Treflex

Treflex is a runtime for front-end application state and the work that runs on it: requests, timers, live connections and multi-step flows. Its reactivity follows [Solid](https://solidjs.com)'s signals, which we think are the best model there is, and in a Solid app it runs on Solid itself. It has first-class bindings for React, where most people come from.

In most apps that work lives in components and `async` functions, so it depends on what's on screen and on what changed during each `await`. Treflex keeps it in the state tree instead, where it runs whether or not a view shows it.

**[See it running →](https://tgoh.github.io/treflex/)** A trip planner, an aquarium and a team chat. Plan a trip and switch apps: its searches carry on. Reload the page: the trips, the fish mid-swim and the half-streamed messages come back, and a search the reload cut off says so, with what it had found.

## Why use it

- **Work isn't tied to the view.** It belongs to an **entity**, an object in the state tree with an `$Id`, and keeps running while no view shows it. Removing the entity stops its work, timers and connections.
- **Actions on one entity take turns.** An action holds its entity until it finishes, so its entity is as it left it after a wait. A second click waits for the first rather than interleaving with it, and marking the action `leading` drops the repeat altogether.
- **Your place survives a reload.** The app's state, timers and connections save to one JSON string and come back. Work a reload cut off is [reported](./docs/reference/restart-and-records.md#recovering-after-a-restore), so the app can pick up where it left off.

## What it looks like

An **action** is a generator that runs on an entity. It writes the entity directly, and reaches the outside world by yielding **effects**, declared calls the runtime makes on its behalf.

```ts
import { defineEffect, implementation, type IActionGenerator, type IEffect, type IEntity } from "treflex";

interface IFeed extends IEntity {
    Url: string;
    Title: string;
}

interface IFetchFeed extends IEffect {
    Type: "Reader/FetchFeed";
    Url: string;
}

export const fetchFeed = defineEffect<IFetchFeed, { Title: string } | null>("Reader/FetchFeed");

export const fetchFeedImpl = implementation(fetchFeed, async (effect, action) => {
    const response = await fetch(effect.Url, { signal: action?.signal });
    return response.status === 410 ? null : await response.json();
});

export function* refresh(draft: IFeed): IActionGenerator {
    const info = yield* fetchFeed({ Url: draft.Url });
    if (info === null) return;
    draft.Title = info.Title;
}
```

`yield*` is where an `async` function would `await`. Because the runtime resumes the action after every yield, it can:

- hand the effect to `fetchFeedImpl` in the app and to a stub in a test;
- hold the feed while the fetch runs, so a second Refresh waits instead of interleaving;
- cancel the fetch, through `action.signal`, if the feed is removed;
- record the step, its request and its answer.

A view reads the entity and dispatches the action. In React, through `treflex-react`:

```tsx
import { createEntityFeature, useInFlight } from "treflex-react";

export const Feed = createEntityFeature<IFeed>("Reader/Feed")({ refresh });

export const FeedView = Feed.provider(() => {
    const feed = Feed.use();
    const refreshing = useInFlight(refresh, feed.state);
    return (
        <button disabled={refreshing} onClick={() => feed.refresh()}>
            {feed.state.Title}
        </button>
    );
});
```

<details>
<summary>The same view in Solid, through <code>treflex-solid</code></summary>

```tsx
import { createEntityFeature, useInFlight } from "treflex-solid";

export const Feed = createEntityFeature<IFeed>("Reader/Feed")({ refresh });

export const FeedView = Feed.provider(() => {
    const feed = Feed.use();
    const refreshing = useInFlight(refresh, () => feed.state);
    return (
        <button disabled={refreshing()} onClick={() => feed.refresh()}>
            {feed.state.Title}
        </button>
    );
});
```

</details>

The view starts nothing and cleans nothing up. Unmount it mid-refresh, and the refresh finishes anyway. Views only read state and dispatch actions, so the same feature files render through either binding: the live demo's Solid and React builds share every one.

## Is it for you?

Treflex fits an app with a lot of work in flight: searches, polling, streams, uploads, multi-step flows, and the races between them. It fits especially well where a reload or a closed tab shouldn't cost the user their place. An AI agent's interface is one such app: the live demo's trip planner is an agent that runs its searches side by side and asks you to pick a fare while the others carry on.

Know these before you start:

- **State is plain data.** Objects, arrays, strings, numbers, booleans and `null`; no class instances, `Date`s or `Map`s. That is what lets the tree save as one string.
- **Actions are generators,** and async work goes through declared effects.
- **A React app carries a small part of Solid.** It comes with `treflex`, and the React binding reads the runtime through `useSyncExternalStore`.
- **It isn't a server-cache library.** Server data lives in the state tree as entities and refreshes through actions, so for data a treflex feature owns, it takes React Query's place. The two can run side by side while you adopt it.
- **There is no server-side rendering yet.** It runs in the browser and in headless tests.
- **It is pre-1.0.** The API can change before 1.0.

For a form that saves once, it is more than you need.

## Building with AI coding agents

What a coding agent, or a person, has to work with in a treflex app:

- **The rules are written down once,** in docs whose code samples are typechecked.
- **Effects are typed, and tests answer them with stubs,** so a test run is deterministic and a change can be checked by running the tests.
- **Lint rules report the mistakes generators invite,** such as a call missing `yield*`, and error messages name the fix.
- **An app from `npm create treflex` includes an `AGENTS.md`** with the rules an agent most needs and the one command that checks a change, and the docs site serves an [`llms.txt`](https://tgoh.github.io/treflex/docs/llms.txt).

## Getting started

```bash
npm create treflex@latest my-app
```

It asks for React or Solid, or takes `-- --template react` or `-- --template solid`. To add treflex to an existing app, `npm install treflex treflex-react` or `npm install treflex treflex-solid solid-js`, then follow [the quickstart's steps by hand](./docs/quickstart.md#add-treflex-to-an-existing-app).

- **[The quickstart](./docs/quickstart.md)** gets a first app running in React or Solid. Start here.
- **[The guide](./docs/guide/01-entities.md)** then builds one small app, a feed reader, a step per page.
- **[The live demo's source](./demos/portal/)** maps each capability onto the files that use it. Run it with `npm run demo:portal`, `npm run demo:react-portal` for the React build, or `npm run demo:portal-swap` for the [swap build](https://tgoh.github.io/treflex/swap/), which switches between the two in place.
- **[`demos/react-todo`](./demos/react-todo/)** and **[`demos/todo`](./demos/todo/)** are one entity in one file, in React and in Solid, for the syntax.
- **[Patterns](./docs/patterns.md)** collects the shapes that cross concepts, and **[the reference](./docs/README.md#reference)** states every rule, one page per concept, with every diag code in [troubleshooting](./docs/reference/troubleshooting.md).
- **[The principles](./docs/design/principles.md)** are what treflex is built on, and why.

The [docs site](https://tgoh.github.io/treflex/docs/) shows the quickstart's and the guide's views in React or Solid, your choice. The reference and the patterns are written in Solid's terms, and [React](./docs/reference/views.md#react) lists what changes. [`docs/README.md`](./docs/README.md) maps them.

## Requirements

In short: React 18.3, or 19.1 or later, for `treflex-react`, TypeScript 5.4 or later with `strict` on, output targeting ES2018 or later, and a browser from 2024 or later. [Requirements](./docs/requirements.md) has the versions, the build setup and the packages.

## Lineage

Treflex builds on ideas proven elsewhere: Solid's signals for its reactivity, the actor model for entities and failure routing, redux-saga for effects described as data, MobX-State-Tree for a tree of identified nodes with snapshots, and Effect-TS for typed `yield*`. [Lineage](./docs/design/choices.md#lineage) says what it takes from each and where it differs.

## Development

[`CONTRIBUTING.md`](./CONTRIBUTING.md#building-and-testing) lists the commands that build and test this repository.
