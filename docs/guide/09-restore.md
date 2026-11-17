# 9. Restore

The reader should come back as it was after a reload: its feeds, their articles and read marks, the starred list, the timers and the push stream. This page saves the runtime and builds a new one from the save, and keeps data about running work out of it.

## Data about running work

Importing a list of addresses shows its progress. The count is about work that is running, so it must not come back after a reload: a restored "imported 2 of 5" would show an import that isn't running. It goes in a **transient**, a named place on an entity that no snapshot saves:

```ts
import { entity, inFlight, type ISelectorGenerator, leading, open, start, transient } from "treflex";

const importProgress = (draft: IReader) => transient(draft, "Reader/Import", { Done: 0, Total: 0 });

export function* importFeeds(draft: IReader, urls: string[]) {
    const progress = yield* importProgress(draft);
    progress.Total = urls.length;
    progress.Done = 0;
    for (const url of urls) {
        const info = yield* open(fetchFeed({ Url: url }));
        progress.Done++;
        if (info === null || draft.Feeds.some((f) => f.Url === url)) continue;
        const feed = yield* entity<IFeed>({ $Receiver: FeedReceiver.Id, Url: url, Title: info.Title, Articles: [] });
        draft.Feeds.push(feed);
        yield* start(initFeed, feed, info);
    }
}
leading(importFeeds);

function* importing(draft: IReader): ISelectorGenerator<string> {
    if (!(yield* inFlight(importFeeds, draft))) return "";
    const progress = yield* importProgress(draft);
    return `Imported ${progress.Done} of ${progress.Total}`;
}
```

`importFeeds` joins the reader feature's actions, and `importing` its selectors.

- **`yield* transient(owner, name, default)`** is the same call in an action, where it returns the transient to write, and in a selector, where it returns a view to read. One helper keeps the name and the default in one place.
- **It follows its owner:** the reader's hold covers it, and the reader's removal ends it.
- **Whether work is running at all is `inFlight`,** not a transient, so `importing` shows nothing once the import ends, however it ends.

## Saving

`createSnapshot(runtime)` writes the running app to one JSON string, without pausing it. Save on `pagehide`, and guard the storage call, which can throw:

```ts
import { createSnapshot } from "treflex/snapshot";

const KEY = "reader";

function save(runtime: IRuntime<IReader>): void {
    try {
        localStorage.setItem(KEY, createSnapshot(runtime));
    } catch {
        // Storage can be full or blocked; the next save tries again.
    }
}
```

The snapshot holds the state tree with every binding in it, data sources, timer rows and resource rows. It doesn't hold transients, component state or open asks, and a restore doesn't resume running actions.

## Restoring

The boot either restores the save or starts fresh. It replaces `createRuntime` in the module that renders, which still declares no component ([page 3](./03-views.md#booting)). Both paths register the same things, so registration moves into one `setup` function:

```ts
import { createRuntime, type IRuntime, type IRuntimeOptions } from "treflex";
import { restoreRuntime, SnapshotRejectedError } from "treflex/snapshot";

const options: IRuntimeOptions = { onError: () => {} };

function setup(runtime: IRuntime<IReader>): void {
    runtime.registerImplementation(fetchFeedImpl);
    runtime.registerReceiver(ReaderReceiver);
    runtime.registerReceiver(FeedReceiver);
    runtime.registerReceiver(StarredReceiver);
    registerPush(runtime);
    runtime.on("failure", (event) => console.error(`${event.ActionName} failed`, event.Error));
}

async function boot(): Promise<IRuntime<IReader>> {
    let saved: string | null = null;
    try {
        saved = localStorage.getItem(KEY);
    } catch {}
    if (saved) {
        try {
            const { runtime } = await restoreRuntime(saved, { rootId: "Reader", options, setup });
            return runtime;
        } catch (error) {
            if (!(error instanceof SnapshotRejectedError)) throw error;
        }
    }
    const runtime = createRuntime<IReader>(seed, options);
    setup(runtime);
    void runtime.dispatch(init, "Reader");
    return runtime;
}

const runtime = await boot();
addEventListener("pagehide", () => save(runtime));
```

- **A restore doesn't run `init`.** What `init` did is already in the save: the push stream's row is there, so the stream reopens by itself, and each feed's poll timer arms for the time it was next due. A feed whose poll came due while the reader was closed polls once, straight away.
- **Nothing that was running comes back.** An import interrupted by the reload is gone, with its progress; the feeds it had added stay, since they were written.
- **A save loads into the code that is running, as it was saved,** so a build that changes the shape of state versions what it saves, and discards or migrates an older save before `restoreRuntime` ([a newer build](../reference/restart-and-records.md#a-newer-build)).
- **`SnapshotRejectedError` means the save can't become a runtime,** so the boot starts fresh. Anything else that fails would fail a fresh boot too, and is rethrown.

## Two mistakes

**Running work as a field.** `draft.Importing = true` in the reader's state is saved, so a reload brings back an import that isn't running, and nothing clears it. Use `inFlight`, or a transient for anything more than whether it runs.

**Expecting an open ask to survive.** No ask is saved, so a reload dismisses the unsubscribe dialog. That is right for a short confirm. A question whose typed answer the person would resent losing is a row in state instead: [the durable conversation](../reference/conversations.md#the-durable-conversation).

## Where the reference takes over

[Restart and records](../reference/restart-and-records.md) has [snapshots](../reference/restart-and-records.md#snapshots), [restoring](../reference/restart-and-records.md#restoring), [what happens to in-flight work](../reference/restart-and-records.md#what-happens-to-in-flight-work), and the record stream every tool taps. [Transients](../reference/state-tree.md#transients) are in the state tree page, and [testing a restore](../reference/testing.md#testing-a-restore) in testing.

That is the whole path. [Patterns](../patterns.md) collects the shapes that cross these concepts, and the [reference](../README.md#reference) states every rule.
