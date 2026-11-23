# 4. Rows

A feed's articles come from the server and refresh on every fetch. This page makes them rows that keep what the client adds to them, such as whether an article was read, across a refresh.

## Choosing the entities

Which parts of a screen are entities decides what each action holds, what ends with what, and who hears which messages. A part is an entity when it has its own lifetime, its own work, its own receiver or data sources, or its own scoped configuration ([state tree](../reference/state-tree.md#usage)). Everything else is data inside the nearest entity above it. By the last page, the reader's tree is:

```text
Reader (IReader)
├─ Starred (IStarred)
└─ Feeds: IFeed[]
   └─ Articles: IArticle[]
```

- **The reader** is the root, and only an entity can have work run on it. Its own work is the list's membership: adding, selecting and removing feeds are a parent's writes ([one entity or two](../patterns.md#one-entity-or-two)). Its receiver makes it the error boundary for everything below it ([page 6](./06-failures.md)), and it owns the push stream ([page 7](./07-live-sources.md)).
- **A feed** has its own work: `refresh` holds only that feed, so the reader and the other feeds stay free ([page 2](./02-actions.md#two-mistakes)). It has its own lifetime, since removing it ends its refresh, its poll timer and its unsubscribe ask ([page 8](./08-asks.md)), and its own receiver for the timer.
- **An article** has its own work, `markRead` and `star`, which hold only that article ([rows as entities](../patterns.md#rows-as-entities)).
- **The starred list** has its own receiver, which hears every starred article without the article knowing it exists ([page 5](./05-messages.md)).

Two parts are deliberately not entities:

- **A starred item**, `{ Title, Link }`, has no work and nothing addresses it, so it is data inside the starred list.
- **The import's progress** is data about running work, so it is a [transient](../reference/state-tree.md#transients) on the reader ([page 9](./09-restore.md)), which no snapshot saves.

## Rows as entities

Each article is an entity, so it can have work of its own, `markRead`, which holds only that article:

```ts
import { entity, type IActionGenerator, type IEntity, reconcileRows } from "treflex";

interface IArticle extends IEntity {
    Guid: string;
    Title: string;
    Link: string;
    Read: boolean;
}

interface IFeed extends IEntity {
    Url: string;
    Title: string;
    Articles: IArticle[];
}

export function* markRead(draft: IArticle): IActionGenerator {
    draft.Read = true;
}
```

`Guid` is the server's id for the article, kept in a field of its own. The `$Id` is the framework's.

## A refresh per type

Loading and refreshing are one function per entity type. The feed's function writes the feed's own fields and refreshes its list of articles with `reconcileRows`, keyed by the server id:

```ts
export function* assignFeed(feed: IFeed, info: IFeedInfo): IActionGenerator {
    feed.Title = info.Title;
    yield* reconcileRows(feed.Articles, info.Items, (row) => row.Guid, {
        add: (item) => entity<IArticle>({ Guid: item.Guid, Title: "", Link: "", Read: false }),
        update: assignArticle
    });
}

function assignArticle(article: IArticle, item: IFeedItem): void {
    article.Title = item.Title;
    article.Link = item.Link;
}

export function* refresh(draft: IFeed): IActionGenerator {
    const info = yield* fetchFeed({ Url: draft.Url });
    if (info === null) return;
    yield* assignFeed(draft, info);
}
```

- **A row whose key matches an item keeps its node and its `$Id`,** so its `Read` mark, and any work running on it, survive the refresh.
- **An item with no match gets a new row from `add`;** a row no item matched is removed. `add` returns `entity(...)` without `yield*`: it hands back the generator, and `reconcileRows` runs it.
- **`update` runs on every row in the result,** new or matched, so one function fills both. It writes only the fields the server owns.
- **Writing into the articles from the feed's action is ordinary.** Authority flows down, and no action holds an article during the refresh: `markRead` ends in the step it starts in ([writing into a child entity](../reference/actions.md#writing-into-a-child-entity)).
- The list ends in the server's order, and the whole refresh lands in one step, so a view never sees it half done.

A first load is the same call over an empty list. `addFeed` makes the feed with no articles and starts `assignFeed` on it with what it fetched:

```ts
import { leading, open, start } from "treflex";

export function* addFeed(draft: IReader) {
    const url = draft.NewUrl.trim();
    if (url === "") return;
    const info = yield* open(fetchFeed({ Url: url }));
    if (info === null) return;
    const feed = yield* entity<IFeed>({ Url: url, Title: info.Title, Articles: [] });
    draft.Feeds.push(feed);
    yield* start(assignFeed, feed, info);
    if (draft.NewUrl.trim() === url) draft.NewUrl = "";
}
leading(addFeed);
```

`yield* start(action, target, ...args)` dispatches an action on another entity from inside an action. It doesn't wait for it: the started action runs on the new feed, under the feed's own hold, and ends with the feed.

## Showing the rows

Each article gets a feature of its own, and the feed mounts one provider per row. The sample keeps the features and the components together; in the app, the features go in a `.ts` file, as on page 3.

<!-- tabs -->

**React**

```tsx
import type { ISelectorGenerator } from "treflex";
import { createEntityFeature, useInFlight } from "treflex-react";

export const Article = createEntityFeature<IArticle>("Reader/Article")({ markRead }, {});

export const ArticleView = Article.provider(() => {
    const article = Article.use();
    return (
        <a href={article.state.Link} className={article.state.Read ? "read" : undefined} onClick={() => article.markRead()}>
            {article.state.Title}
        </a>
    );
});

function* unread(draft: IFeed): ISelectorGenerator<number> {
    return draft.Articles.filter((article) => !article.Read).length;
}

export const Feed = createEntityFeature<IFeed>("Reader/Feed")({ refresh }, { unread });

export const FeedView = Feed.provider(() => {
    const feed = Feed.use();
    const refreshing = useInFlight(refresh, feed.state);
    return (
        <section>
            <h2>
                {feed.state.Title} ({feed.unread()} unread)
            </h2>
            <button disabled={refreshing} onClick={() => feed.refresh()}>
                Refresh
            </button>
            {feed.state.Articles.map((article) => (
                <ArticleView key={article.$Id} state={article} />
            ))}
        </section>
    );
});
```

**Solid**

```tsx
import type { ISelectorGenerator } from "treflex";
import { createEntityFeature, useInFlight } from "treflex-solid";
import { For } from "solid-js";

export const Article = createEntityFeature<IArticle>("Reader/Article")({ markRead }, {});

export const ArticleView = Article.provider(() => {
    const article = Article.use();
    return (
        <a href={article.state.Link} class={{ read: article.state.Read }} onClick={() => article.markRead()}>
            {article.state.Title}
        </a>
    );
});

function* unread(draft: IFeed): ISelectorGenerator<number> {
    return draft.Articles.filter((article) => !article.Read).length;
}

export const Feed = createEntityFeature<IFeed>("Reader/Feed")({ refresh }, { unread });

export const FeedView = Feed.provider(() => {
    const feed = Feed.use();
    const refreshing = useInFlight(refresh, () => feed.state);
    return (
        <section>
            <h2>
                {feed.state.Title} ({feed.unread()} unread)
            </h2>
            <button disabled={refreshing()} onClick={() => feed.refresh()}>
                Refresh
            </button>
            <For each={feed.state.Articles}>{(article) => <ArticleView state={article} />}</For>
        </section>
    );
});
```

<!-- /tabs -->

Clicking an article runs `markRead` on that article. It doesn't wait for a refresh running on the feed, since the article is an entity of its own. In React, the feed's view holds each article as a ref, so the feed passes the ref to `ArticleView` and reads the article's fields only inside it.

## Two mistakes

**Replacing the list.** `feed.Articles = info.Items.map(...)` throws every row away on each refresh. The `Read` marks go, and so does any work running on the old rows: removal ends it. Refresh with `reconcileRows`.

**A selector that returns fresh objects for a list.** `draft.Articles.map((a) => ({ Title: a.Title }))` returns new objects on every run, and `<For>` keys on identity, so every row remounts. In React, rows keyed by `key` keep their mounts, but each run hands every row a fresh object, which defeats `memo`. Return the nodes themselves, `draft.Articles.filter(...)`, or a list of `$Id`s.

## Where the reference takes over

`reconcileRows`' full contract is in [refreshing rows](../reference/write-path.md#refreshing-rows), which also covers [a record of rows](../reference/write-path.md#a-record-of-rows) keyed by id, and [keys and the refresh step](../reference/write-path.md#keys-and-the-refresh-step). [`start`](../reference/actions.md#start) and [which entity owns an action](../reference/actions.md#which-entity-owns-an-action) are in actions, and [a list over a selector](../reference/views.md#a-list-over-a-selector) in views. [Patterns](../patterns.md#a-refresh-per-entity-type) covers rows whose refresh is their own action.

Next: [5. Receivers and messages](./05-messages.md).
