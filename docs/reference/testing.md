# Testing

`createTestRuntime(initialState, effectStubs?, options?)` builds a runtime with the same `createRuntime` the application boots, with a few choices made for tests. What a test pins is what production does: the write path, the index, the dispose cascade, holds, asks and failure routing are all the shipped ones. Everything a test needs comes from `treflex`, and snapshot and restore from `treflex/snapshot`.

## Usage

### What the test runtime decides

```ts
import { createTestRuntime, defineEffect, guids, type IActionGenerator, type IEntity } from "treflex";
import { expect, it } from "vitest";

interface IList extends IEntity {
    Templates: { Id: string }[];
}

const fetchTemplates = defineEffect<{ Type: "Api/FetchTemplates" }, { Id: string }[]>("Api/FetchTemplates");

function* loadTemplates(draft: IList): IActionGenerator {
    draft.Templates = yield* fetchTemplates();
}

it("loads templates", async () => {
    const runtime = createTestRuntime<IList>(
        { $Id: "List", Templates: [] },
        { generateGuid: guids("row"), "Api/FetchTemplates": () => Promise.resolve([{ Id: "1" }]) }
    );
    await runtime.dispatch(loadTemplates, "List");
    expect(runtime.state.Templates).toEqual([{ Id: "1" }]);
});
```

It passes `createRuntime` these, and nothing else differs:

- **`effectStubs` as `implementations`**, so each yielded effect goes to the test's stub.
- **`generateGuid` refused** unless stubbed, with the message any unimplemented type gets: `No implementation registered for effect type: "generateGuid"`. A test that forgot it would otherwise draw a real uuid and pass.
- **`pauseTimers: true`**: rows record, nothing ticks ([below](#timers-and-resources-in-tests)).
- **`pauseResources: true`** ([`live-sources.md`](./live-sources.md#restore-and-tests)), and the resource stubs from `options` installed, so methods and supplies answer from stubs ([below](#resources)).
- **`onError`** and the **`inFlight` stub** from `options`, which takes those two and `resources`, nothing more.

**`guids(prefix)`** is a `generateGuid` stub answering `prefix-1`, `prefix-2` and so on, which `entity()` makes into the `$Id`s `~prefix-1`, `~prefix-2`. Take a new one per test, since each holds its own count.

### Waiting until nothing can run

A dispatch resolves when its own action ends, while what it started may still be running: a started action, a receiver of what it published. **`await settled()`** waits for those: it resolves once no fiber can move without something outside, every stub that has answered heard and microtasks drained.

```ts
import { publish, receiver, type IReceiverId, settled } from "treflex";

declare module "treflex" {
    interface IMessageRegistry {
        "Test/Ping": { Text: string };
    }
}

interface ISub extends IEntity {
    readonly $Receiver?: IReceiverId<ISub>;
    Last: string;
}

const TestReceiver = receiver<ISub>("TestReceiver")({
    *"Test/Ping"(draft, message) {
        draft.Last = message.Text;
    }
});

function* trigger(_draft: ISub): IActionGenerator {
    yield* publish("Test/Ping", { Text: "hello" });
}

it("fires on publish", async () => {
    const runtime = createTestRuntime<ISub>({ $Id: "Sub", Last: "", $Receiver: TestReceiver.Id });
    runtime.registerReceiver(TestReceiver);
    await runtime.dispatch(trigger, "Sub");
    await settled();
    expect(runtime.state.Last).toBe("hello");
});
```

### Check the app loads

Keep one test that builds the production bundle and renders it, in jsdom say. It catches load-order failures, such as an import cycle that reads an export before the export exists, which typecheck, lint and the build all pass. Importing the source under Vitest misses them, because Vitest's module loader answers `undefined` for that read instead of throwing. Vitest sets `NODE_ENV=test`, so pass production mode to the build explicitly.

The build goes in a global setup, which runs in plain Node, since esbuild doesn't run inside jsdom, and writes inside the project, where the test can import it; a directory under the system temp folder fails to import. Name it in the vitest config's `test.globalSetup`:

```ts
// test/buildBundle.ts
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import type { TestProject } from "vitest/node";

declare module "vitest" {
    export interface ProvidedContext {
        bundleDir: string;
    }
}

export default async function setup(project: TestProject): Promise<() => void> {
    const cache = join(process.cwd(), "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    const outDir = mkdtempSync(join(cache, "app-bundle-"));
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        await build({ logLevel: "silent", build: { outDir, emptyOutDir: true } });
    } finally {
        process.env.NODE_ENV = nodeEnv;
    }
    project.provide("bundleDir", outDir);
    return () => rmSync(outDir, { recursive: true, force: true });
}
```

The test imports the built entry into jsdom and waits for the first screen. Stub whatever that screen needs that jsdom lacks, such as `fetch` or `ResizeObserver`, and use the element id the app's `index.html` renders into:

```ts
// @vitest-environment jsdom
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, inject, test, vi } from "vitest";

test("the app loads", { timeout: 60_000 }, async () => {
    const assets = join(inject("bundleDir"), "assets");
    const entry = readdirSync(assets).find((file) => /^index-.*\.js$/.test(file));
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    document.body.innerHTML = '<div id="root"></div>';
    await import(/* @vite-ignore */ pathToFileURL(join(assets, entry!)).href);
    const root = document.getElementById("root")!;
    await vi.waitUntil(() => root.childElementCount > 0, { timeout: 30_000 });
    expect(errors).toEqual([]);
});
```

## Rules

### Beyond the preset

`verifyIndex` is left to the environment: set `TREFLEX_VERIFY_INDEX=always` in a vitest config's `test.env` and every reconciliation checks the index against the tree, which makes every test a check that no write bypassed the write path. A bare `createRuntime` is the escape for what the preset decides against: real ticks under fake timers, a wired `generateGuid`, live resource types. `ITestRuntime<T>` is `IRuntime<T>`. A stub for a type declared `redact: true` redacts like any implementation of it. The activity log is off here as everywhere, unless a bare `createRuntime` turns it on.

A runtime needs no `createRoot` around it. `solid-js` must resolve to its browser build in the test environment, or construction throws `SolidServerBuildError` ([`runtime.md`](./runtime.md#the-solid-build)).

### Effects under the test's control

An effect yield resolves exactly when, and to exactly what, the stub decides, which makes interleavings deterministic. A stub that returns a promise the test resolves later holds the yield open while something else happens. A stub for a `settles: "sync"` type, `generateGuid` among them, returns its value directly: a promise fails the yield ([`effects.md`](./effects.md#sync-effects)).

An effect implementation tested directly, without a dispatch, takes a hand-built `IActionContext`: an `entityId`, an `actionId`, `new AbortController().signal`, a `get` over a `Map`, and a `processAction` that throws.

#### Runtime operations and reads

The runtime's own operations (`publish`, `start`, `ask`, `openResource`, `startTimer` and the rest) and its reads (`select`, `getData`, `inFlight`, `pendingAsks` and the rest) can't be stubbed or replaced: a stub-map entry under any of their names throws. A test observes them instead:

- **through records**: each operation leaves its `effect` and `response` records;
- **through what they cause**: a publish by what its receivers did, a timer or a resource by `runtime.timers()` and `runtime.resources()`;
- **an ask by answering it**, as a view does ([below](#work-on-a-held-entity));
- **`inFlight` by its stub** ([below](#stubbing-inflight)).

A test reads a selector, a transient, `inFlight` or `pendingAsks` through `runtime.processSelector(selector, () => runtime.state)`. A selector with no yields is a plain generator a test can drive with no runtime: `expect(remaining(state).next().value).toBe(1)`.

#### Stubbing inFlight

`options.inFlight(ownerId)` names actions and [work tags](./actions.md#work-tags) to count as running on an owner, without holding real work open, for reads in actions and selectors alike. It returns a list, or `undefined` for none. A read is true when the record of running work says so or the list holds what it asks about, matched by identity; a tag read is also true for a listed action carrying the tag.

```ts
import { inFlight, type ISelectorGenerator } from "treflex";

interface IDoc extends IEntity {
    Title: string;
}

function* save(draft: IDoc): IActionGenerator {
    draft.Title = draft.Title.trim();
}

function* canSave(draft: IDoc): ISelectorGenerator<boolean> {
    return !(yield* inFlight(save, draft));
}

it("disables save while one runs", () => {
    const runtime = createTestRuntime<IDoc>({ $Id: "doc-1", Title: "" }, {}, {
        inFlight: (ownerId) => (ownerId === "doc-1" ? [save] : undefined)
    });
    expect(runtime.processSelector(canSave, () => runtime.state)).toBe(false);
});
```

The stub only adds: a read the record answers true stays true. `leading` and `latest` never read it.

### What settled waits for

What waits on something outside doesn't hold it up, so it always returns: an unanswered ask, a stub's unresolved promise, a timer. It is a test tool, not on the runtime, because a running app's open ask may never be answered.

**A failing action rejects its dispatch,** even when `onError` takes the failure ([the dispatch promise](./failure.md#the-dispatch-promise)), so a test that expects a failure awaits `expect(runtime.dispatch(...)).rejects`, and one that only checks the state after it catches the promise.

**A test can pin "no diags"** by collecting them: `const diags: string[] = []; runtime.on("diag", (event) => diags.push(event.code));`, then `expect(diags).toEqual([])` at the end ([diags](./troubleshooting.md)).

**A topic a test declares is declared for the whole program.** A `declare module "treflex"` in one test file applies to every file the compiler sees with it, so give test topics a prefix the app never uses, as `Test/` above.

### Work on a held entity

A dispatch to an entity a running action [holds](./actions.md#holds) queues behind it, here as in production. A test that answers an ask finds it through a selector reading `pendingAsks`, dispatches the answer on its owner, and then awaits the asker ([`conversations.md`](./conversations.md#rendering-the-open-asks)):

```ts
import { answer, ask, type IAskEntry, type IAskId, open, pendingAsks } from "treflex";

interface IKitchen extends IEntity {
    Closed: boolean;
}

function* closeKitchen(draft: IKitchen) {
    const sure = yield* open(ask<boolean>(draft, { Path: "Kitchen/Close" }));
    if (sure) draft.Closed = true;
}

function* reply(_draft: IKitchen, id: IAskId<boolean>, value: boolean): IActionGenerator {
    yield* answer(id, value);
}

function* asks(draft: IKitchen): ISelectorGenerator<readonly IAskEntry[]> {
    return yield* pendingAsks(draft);
}

it("closes once confirmed", async () => {
    const runtime = createTestRuntime<IKitchen>({ $Id: "kitchen", Closed: false });
    const asking = runtime.dispatch(closeKitchen, "kitchen");
    await settled();
    const [entry] = runtime.processSelector(asks, () => runtime.state);
    expect(entry?.Request).toEqual({ Path: "Kitchen/Close" });
    await runtime.dispatch(reply, entry!.OwnerId, entry!.Id as IAskId<boolean>, true);
    await asking;
    expect(runtime.state.Closed).toBe(true);
});
```

A dispatch queued behind a hold that never ends never resolves, so awaiting it times the test out. `action/long-hold` names the holder and what is queued ([troubleshooting](./troubleshooting.md#actionlong-hold)); collect diags in the test, as above, to see it in the failure.

**Cancellation** is tested the same way: an implementation that captures `action.signal` and settles only on abort, a dispatch on a child, a dispatched action that removes the child, and an assertion that the signal aborted. The stopped action's promise resolves `undefined`; `createTraceAggregator` tells a cancelled action from a completed one, `trace.cancelled === true` ([`restart-and-records.md`](./restart-and-records.md#traces)).

### Timers and resources in tests

**Timers** never tick here. A test reads the rows with `runtime.timers(owner?)`, copies, and drives a tick by dispatching the receiver's handle with the tick and the context a delivery carries: `runtime.dispatch(ClockReceiver.handle, "clock-1", { Type: "Clock/Tick", Label: "x" }, { publisher: { Id: "clock-1" } })`. A test of the ticking itself uses a bare `createRuntime` and fake timers.

#### Resources

A test reads what was opened with `runtime.resources(owner?)`, and drives a resource's receiver by dispatching its handle with `{ Type: key, ...message }`, or with `{ Type: key, $Ended: { Reason } }`, and `{ publisher: { Id: owner } }`. Answers come from stubs in `options.resources`, each keyed by resource key:

```ts
export const stubbed = createTestRuntime<IDoc>({ $Id: "doc-1", Title: "" }, {}, {
    resources: {
        methods: { "Upload/Files": { upload: (_ctx, id: string) => `guid-${id}` } },
        supplies: { "Upload/Files": (_ctx, files: readonly File[]) => files.map((f) => ({ Id: f.name, Name: f.name })) },
        exposes: { "Viewer/Preview": "blob:preview" },
        statuses: { "Feed/Events": { State: "live", Detail: "retrying" } }
    }
});
```

- **`methods`** is keyed by key, then method; a stub is called `(ctx, ...args)` with `ctx` `{ ownerId }`. **`supplies`** answers a supply as `(ctx, value)`. **`exposes`** is the value a view reads, and **`statuses`** the status, so a view's "reconnecting" state tests with nothing else stubbed. Results are checked as plain data.
- **A stub answers only when a row exists** for that owner and key. With none, the call takes the ordinary path: `undefined`, with [`resource/not-open`](./troubleshooting.md#resourcenot-open) for a method and [`resource/supply-dropped`](./troubleshooting.md#resourcesupply-dropped) for a supply. A feature that forgot `openResource` gets `undefined`, not the stubbed answer.
- **A cell with a row reads** its `statuses` stub, else `live` when any stub exists for its key, else `pending` with `Waiting: "paused"`. A view gated on `live`, a picker say, is driven by stubbing its key.
- **An unstubbed method or supply on a cell with a row throws**, so a test never passes on a silent `undefined`.

A type's own behaviour is tested on a bare `createRuntime` with a scripted type registered, driven by `runtime.supplyResource` and the methods and emits it exercises.

### Testing a restore

A restart in a test is a second runtime built from the first one's snapshot, with **`restoreTestRuntime(json, { rootId, effectStubs?, options?, setup?, repair? })`** from `treflex/snapshot`: it builds what `createTestRuntime` does from the same stubs and options, and otherwise works as [`restoreRuntime`](./restart-and-records.md#restoring) does.

```ts
import { createSnapshot, restoreTestRuntime } from "treflex/snapshot";

it("keeps the title across a restart", async () => {
    const before = createTestRuntime<IDoc>({ $Id: "doc-1", Title: "draft" });
    const { runtime: after, result } = await restoreTestRuntime<IDoc>(createSnapshot(before), {
        rootId: "doc-1",
        effectStubs: { generateGuid: guids("after") }
    });
    expect(after.state.Title).toBe("draft");
    expect(result.dropped).toEqual([]);
});
```

Give the restored runtime's `guids` a prefix of its own. The preset's pauses carry over: no restored timer ticks and no restored resource connects.

### Testing a Solid component

A component test renders inside a real Solid root, under a `TreflexProvider`, with the host element in the document, since Solid delegates events like `onClick` to it:

```tsx
import { render } from "solid-js/web";
import { TreflexProvider, useDispatch } from "treflex-solid";

interface ICounter extends IEntity {
    Count: number;
}

function* bump(draft: ICounter): IActionGenerator {
    draft.Count++;
}

function Counter(props: { counter: ICounter }) {
    const dispatch = useDispatch();
    return <button type="button" onClick={() => void dispatch(bump, props.counter)}>{props.counter.Count}</button>;
}

it("renders state and dispatches on a click", async () => {
    const runtime = createTestRuntime<ICounter>({ $Id: "C", Count: 0 });
    const host = document.body.appendChild(document.createElement("div"));
    const dispose = render(
        () => (
            <TreflexProvider value={runtime}>
                <Counter counter={runtime.state} />
            </TreflexProvider>
        ),
        host
    );
    host.querySelector("button")!.click();
    await settled();
    expect(host.textContent).toBe("1");
    dispose();
    host.remove();
});
```

The vitest config runs `vite-plugin-solid` with hot reload off, `solid({ hot: false })`, and sets `test.environment: "jsdom"`. Component state needs a mounted component, so a headless test dispatches the action the component would call.

## Caveats

- **The `inFlight` stub reacts to nothing,** so a memoized selector re-derives only on the record's own changes; read through `processSelector`, which doesn't memoize, after changing what the stub answers.
- **A stub answering from a real timer** hasn't answered yet: advance fake timers, under which `settled` still works, and then call it.
- **A restored runtime's `guids` under the same prefix** counts from 1 again, so it mints an `$Id` a restored entity already holds, and writing that entity throws `EntityReplacedError`.
- **A scripted resource type's setup and deliveries** run in the manager's microtask drain, so flush a microtask after opening before advancing fake timers.
- **`vite-plugin-solid` with hot reload on** fails a test file at load with `Received 'file:///@solid-refresh'`. Pass `solid({ hot: false })`.
