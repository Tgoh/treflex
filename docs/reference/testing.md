# Testing

`createTestRuntime(initialState, effectStubs?, options?)` builds a runtime with the same `createRuntime` the application boots, with a few choices made for tests. What a test pins is what production does: the write path, the index, the dispose cascade, holds, asks and failure routing are all the shipped ones. Everything a test needs comes from `treflex`, snapshot and restore from `treflex/snapshot`, and the Vitest setup file is `treflex/vitest`.

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

It passes `createRuntime` these and listens to its events, and nothing else differs:

- **`effectStubs` as `implementations`**, so each yielded effect goes to the test's stub.
- **`generateGuid` refused** unless stubbed, with an error that starts `No implementation registered for effect type: "generateGuid"` and names `guids`. A test that forgot it would otherwise draw a real uuid and pass. Any action that makes an entity yields it, so a test's stubs usually include `generateGuid: guids("row")`.
- **`pauseTimers: true`**: rows record, nothing ticks ([below](#timers-and-resources-in-tests)).
- **`pauseResources: true`** ([`live-sources.md`](./live-sources.md#restore-and-tests)), and the resource stubs from `options` installed, so methods and supplies answer from stubs ([below](#resources)).
- **`verifyIndex: "always"`**, so every reconciliation checks the `$Id` index against the tree, and a write that bypassed the write path fails the test. The `TREFLEX_VERIFY_INDEX` environment variable overrides that default, and `options.verifyIndex` overrides both ([`runtime.md`](./runtime.md#options)).
- **A diag or a failure fails the test**, unless the test allows it ([below](#failures-and-diags-fail-the-test)). Its `onError` is the test runtime's own, which calls `options.onError` when there is one.
- **The `inFlight` stub** from `options`.

**Load `treflex/vitest` in the Vitest config**, `test: { setupFiles: ["treflex/vitest"] }`, so that what the test runtime catches fails the test that caused it.

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

A bare `createRuntime` is the escape for what the preset decides against: real ticks under fake timers, a wired `generateGuid`, live resource types. `ITestRuntime<T>` is `IRuntime<T>`. A stub for a type declared `redact: true` redacts like any implementation of it. A test provides the [outside values](./derived-reads.md#outside-values) its selectors read with `provideExternal`, and after changing what `read` returns, calls the handle's `changed()`.

A runtime needs no `createRoot` around it.

**A topic a test declares is declared for the whole program.** A `declare module "treflex"` in one test file applies to every file the compiler sees with it, so give test topics a prefix the app never uses, as `Test/` above.

### Effects under the test's control

An effect yield resolves exactly when, and to exactly what, the stub decides, which makes interleavings deterministic. A stub that returns a promise the test resolves later holds the yield open while something else happens. A stub for a `settles: "sync"` type, `generateGuid` among them, returns its value directly: a promise fails the yield ([`effects.md`](./effects.md#sync-effects)).

A stub answers a failure the app handles with data, as the implementation does, and rejects with an `Error` for one it doesn't. The action gets a [copy](./effects.md#a-rejection-crosses-as-a-copy) of what the stub rejects with, so a test asserts its class, name, message and fields, never that it is the stub's own object. A stub that rejects with an app's class, or with an object that is neither an error nor plain data, fails the test with [`effect/class-rejection`](./troubleshooting.md#effectclass-rejection), and one that rejects with an error carrying a field JSON changes, such as a `Date`, fails it with [`effect/rejection-field-lost`](./troubleshooting.md#effectrejection-field-lost), however the action catches it.

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

### Failures and diags fail the test

The test runtime reports:

- **every [diag](./troubleshooting.md)** whose code `options.allowDiags` doesn't list. `allowDiags: true` allows every code. It never reports [`state/view-write`](./troubleshooting.md#stateview-write): every live runtime hears that diag, and the write already throws at the writer.
- **every failure** whose action `options.allowFailures` doesn't list, whatever took it, an awaited dispatch's included. `allowFailures: true` allows every failure. [`action/unrouted-throw`](./troubleshooting.md#actionunrouted-throw) is reported as the failure it reports.
- **a throw out of `options.onError`**, whatever `allowFailures` says. The test runtime's own `onError` catches it, so the failure counts as taken: its `failure` event has `Taken: true`, where a bare `createRuntime` gives `Taken: false` ([the dispatch promise](./failure.md#the-dispatch-promise)).

A dispatch refused before its action starts takes no route, so only its own promise and its diag report it: [`dispatch/unresolved-entity`](./troubleshooting.md#dispatchunresolved-entity) for an entity not in the tree is a diag.

A report names the diag code, or the action and its entity, and the option that allows it, such as `allowFailures: [loadTemplates]`, and carries the diag event or the thrown value as its `cause`. Its stack starts at the line that built the runtime. An allowed diag still prints to the console.

**With `treflex/vitest` loaded,** the test runtime holds each report and throws it from an `afterEach`, so the test that caused it fails, with an `AggregateError` holding them when there are several. A report made after the test's `afterEach`, such as a failure from a stub that answers from a real timer after the test ended, fails the next test, or the file's `afterAll` after its last test. One that lands after the file's last test can go unheard, so a test awaits its work, or calls `settled()` once its stubs have answered, before it ends.

**Without it,** the test runtime raises each report as an unhandled rejection. Vitest then fails the run and no test, and names only the test that might have caused it.

**A test that fails work on purpose lists the action:**

```ts
it("keeps the list empty when the fetch fails", async () => {
    const runtime = createTestRuntime<IList>(
        { $Id: "List", Templates: [] },
        { "Api/FetchTemplates": () => Promise.reject(new Error("offline")) },
        { allowFailures: [loadTemplates] }
    );
    await expect(runtime.dispatch(loadTemplates, "List")).rejects.toThrow("offline");
    expect(runtime.state.Templates).toEqual([]);
});
```

**The list matches by identity,** as it stands when the runtime is built: an entry is the function the runtime runs, the reference passed to `dispatch` or `start`. `leading` and `latest` return the function they mark, so the action is listed as it is exported. A function with the same name from elsewhere isn't matched, and an anonymous action can be listed only by holding its reference. A receiver case's failure, and an error boundary's own, are listed by the receiver's `handle`.

**A test that causes a diag on purpose lists its code,** `{ allowDiags: ["resource/not-open"] }`, and can still collect diags with `runtime.on("diag", ...)` to assert on them. `restoreTestRuntime`'s `options` cover the restore's own diags, those of its table load included.

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

A dispatch queued behind a hold that never ends never resolves, so awaiting it times the test out. After a second, `action/long-hold` names the holder and what is queued ([troubleshooting](./troubleshooting.md#actionlong-hold)), and the test fails with it beside the timeout.

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
- **A stub answers only when a row exists** for that owner and key. With none, the call takes the ordinary path: `undefined`, with [`resource/not-open`](./troubleshooting.md#resourcenot-open) for a method and [`resource/supply-dropped`](./troubleshooting.md#resourcesupply-dropped) for a supply, which fail the test ([above](#failures-and-diags-fail-the-test)). A feature that forgot `openResource` gets `undefined`, not the stubbed answer.
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

### Testing a resume

A test of [resume](./restart-and-records.md#resume) gives both runtimes the same `build` and `resume` in their options, holds the flow at a wait with a stub that never answers, and restores the snapshot with stubs that do:

```ts
import { defineEffect, type IEffect, type IEntity, type IOpenGenerator, named, open, resumable } from "treflex";

interface ITicket extends IEntity {
    Seat: string;
    Booked: boolean;
}

interface IHoldSeat extends IEffect {
    Type: "Tickets/HoldSeat";
}

interface IBook extends IEffect {
    Type: "Tickets/Book";
    Seat: string;
}

const holdSeat = defineEffect<IHoldSeat, string>("Tickets/HoldSeat", { idempotent: true });
const book = defineEffect<IBook, boolean>("Tickets/Book");

export function* buy(draft: ITicket): IOpenGenerator {
    draft.Seat = yield* open(holdSeat());
    draft.Booked = yield* open(book({ Seat: draft.Seat }));
}
named(buy, "Tickets/Buy");
resumable(buy);

const resuming = { build: "test", resume: true } as const;
const never = () => new Promise<never>(() => {});
const ticket = (): ITicket => ({ $Id: "ticket-1", Seat: "", Booked: false });

it("resumes a purchase caught at the seat", async () => {
    const before = createTestRuntime(ticket(), { "Tickets/HoldSeat": never }, resuming);
    void before.dispatch(buy, "ticket-1");
    await settled();
    const { runtime, result } = await restoreTestRuntime<ITicket>(createSnapshot(before), {
        rootId: "ticket-1",
        effectStubs: { "Tickets/HoldSeat": () => "12A", "Tickets/Book": () => true },
        options: resuming
    });
    expect(result.resumed.map((entry) => [entry.name, entry.wait])).toEqual([["Tickets/Buy", "Tickets/HoldSeat"]]);
    await settled();
    expect(runtime.state).toMatchObject({ Seat: "12A", Booked: true });
});

it("drops a purchase caught at the booking", async () => {
    const before = createTestRuntime(ticket(), { "Tickets/HoldSeat": () => "12A", "Tickets/Book": never }, resuming);
    void before.dispatch(buy, "ticket-1");
    await settled();
    const { result } = await restoreTestRuntime<ITicket>(createSnapshot(before), { rootId: "ticket-1", options: resuming });
    expect(result.dropped.map((entry) => [entry.reason, entry.wait])).toEqual([["not-idempotent", "Tickets/Book"]]);
});
```

Whether resume ever leaves a restore worse than one without it is tested at every point of a script by `differentialRestore` with [`compareDataOnly`](#comparing-with-a-data-only-restore).

A drop is data, so the preset doesn't fail a test on [`resume/never-resumes`](./troubleshooting.md#resumenever-resumes), which a restore raises for a marked action's drop. It does fail one on [`resume/tree-watched`](./troubleshooting.md#resumetree-watched), since a watched tree is how the app is set up, on [`resume/no-build`](./troubleshooting.md#resumeno-build), which a runtime with `resume` and no `build` raises, and on [`resume/over-budget`](./troubleshooting.md#resumeover-budget); a test that means to reach one passes it in `allowDiags`.

### Testing every restore point

**`differentialRestore(app, script)`** from `treflex/snapshot` tests an app's restore code at every point between two steps of a script at which work is in flight; a reload in the middle of a step isn't tried. It plays `script` once without interruption. Then, for each point between two steps at which any action is running, it plays the script again from the seed up to that point, takes a snapshot there, disposes that runtime as a reload ends a page, restores the snapshot into a new runtime with the app's `setup` and `repair`, plays the rest of the script on it, and compares how that run ends with the uninterrupted one. Each restored point so plays the whole script, so the cost grows with the square of its length.

```ts
import { differentialRestore, dispatchStep, settleStep } from "treflex/snapshot";

interface IOutbox extends IEntity {
    Text: string;
    Sent: boolean;
}

const postText = defineEffect<{ Type: "Api/PostText"; Text: string }, void>("Api/PostText");

function* sendText(draft: IOutbox, text: string): IActionGenerator {
    draft.Text = text;
    yield* postText({ Text: text });
    draft.Sent = true;
}

it("loses the send a reload interrupts", async () => {
    const outbox: IOutbox = { $Id: "outbox", Text: "", Sent: false };
    const report = await differentialRestore({ seed: outbox, hold: [postText] }, [
        dispatchStep(sendText, "outbox", ["hello"]),
        settleStep(postText, { value: undefined })
    ]);
    expect(report.points.map((point) => point.after)).toEqual([1]);
    expect(report.differing[0]?.differences).toEqual({
        state: [{ path: "Sent", expected: true, actual: false }]
    });
});
```

The restore dropped `sendText`, so the settle step found nothing to settle and the message stayed unsent. A dropped entry carries no arguments, so a repair that dispatches `sendText` again for each one, reading the text from state, would turn that point into one that ends the same. It starts the send and doesn't await it: a repair must not await work that waits on a held effect, since only a later step settles one, and the tool rejects a restore that hasn't finished in `restoreTimeoutMs`.

**`app`** takes:

- **`seed`**, the tree every run starts from, copied for each. Its `$Id` is the `rootId` each restore checks.
- **`setup`** and **`repair`**, the app's own, as `restoreTestRuntime` takes them. `setup` runs on every runtime the tool builds, and work it starts can wait on a held effect. A restore's `setup` calls the stubs live, so a stub that `setup` calls sees one more boot for each restore, as a server sees a reload.
- **`effectStubs`**, as `createTestRuntime` takes them, or a function that returns them. A map's stubs are shared by every run, so they must keep no state. A stub that keeps state, such as a counter or a fake server, is given as a function, which the tool calls once for the uninterrupted run and once for each restored point. A point's stubs serve its run up to the point and then its restore, so they have seen every call made before the point, with the action context it was made in, and a server that had taken a request has still taken it. Disposing the run to the point aborts every effect still open, so a call that ends only when its action is aborted, such as a long poll, ends there as a reload ends it. The function must return a new map of new stubs each call. The test pins anything else a run reads from outside, such as the clock with `vi.setSystemTime`. The tool mints ids itself ([below](#ids-across-a-restore)), so a `generateGuid` stub is refused.
- **`options`**, as `createTestRuntime` takes them. Everything in it, resource stubs in `resources.methods` and `supplies` included, is shared by every run, so it must keep no state.
- **`restoreTimeoutMs`**, how long each restore, its `repair` included, may take, in milliseconds: a positive finite number, 1000 by default.
- **`hold`**, the effect types the tool holds open, as their declarations or their `Type`s. A held effect resolves or rejects only when a step settles it, and an implementation `setup` registers for a held type is not installed. Effects of other types are answered by the stubs and `setup`'s implementations, as in any test. Timers and resources stay paused.

**The script** is a list of steps:

- **`dispatchStep(action, on, args?)`** dispatches `action` on the entity `on`, with `args` checked against the action's arguments.
- **`settleStep(effect, { value } | { error }, { on?, where? }?)`**, `effect` given as its declaration or its `Type`, resolves one held effect of that type to `value`, checked against the declaration's result, or rejects it with `error`. `on` keeps the effects yielded by an action on that entity, and `where` the ones whose payload it accepts. Exactly one held effect must be left, so two effects of one type open at once are told apart by `on` or `where`.

An `on` or `args` that depends on the runtime is a function of it, called on the runtime the step plays on, such as `(runtime) => runtime.state.Messages[0].$Id`. A script declared outside the call is annotated `IDifferentialStep<T>[]`, or the runtime those functions take is typed `IRuntime<object>`. The tool waits with `settled()` after every step.

**A restored run skips a step it can't play** and plays on: a settle that leaves no held effect or more than one, a dispatch on an entity its tree doesn't hold, an `on` that returns something that isn't an `$Id`, or an `on`, `args` or `where` that throws, as one that reads an entity the restore lost does.

**The report** is an `IDifferentialReport`:

- **`steps`**, the script's length, and **`quiet`**, how many points had no action running and so were not restored.
- **`points`**, one per point that was restored, in order. Each has `after`, how many steps ran before its snapshot; `inFlight`, the snapshot's in-flight list; `snapshot`, the envelope the restore read, so a test can restore it again itself or measure it; `result`, what the restore resolved to, its `dropped`, `unresolved` and `repairError` included; `skipped`, the steps the restored run skipped, each with its number and why; `differences`; and `same`, true when `differences` is `{}`. A point with skipped steps can still be `same`, and then isn't in `differing`, so a test that wants to know a flow ran to its end asserts on `skipped` too. A snapshot leaves out work on transient and component-state entities, so a point where only such work was running is restored with an empty `inFlight`.
- **`differing`**, the points whose `same` is false.

**`differences`** holds only the kinds that differ, so a point that ended as the uninterrupted run has `{}`. Ids the tool minted are compared through a pairing between the two runs ([below](#ids-across-a-restore)), and each side shows its own run's ids:

- **`state`**: each place the final trees differ, as `{ path, expected, actual }`, with `undefined` for a side that has nothing there. A `path` joins keys with dots and puts array indexes in brackets, as in `Cart.Lines[0].Price`.
- **`diags`**: the diags raised after the point, each as its `code`, `severity` and `message`.
- **`failures`**: the failure events after the point, without the `ActionId` each runtime numbers for itself and without `Cause`, and with `Error` as `"name: message"`.
- **`onError`**: present only when `options` has an `onError`: the calls it received after the point, with `Error` as `"name: message"` and `Threw` when it threw.
- **`unfinished`**: what the restored run left running after its last step, as `{ inFlight, held }`: each action still running by its `Name`, `Label`, `Receiver` if it has one, `EntityId`, `State` and `Place` as a snapshot's entry has them ([what a snapshot holds](./restart-and-records.md#what-a-snapshot-holds)), whatever entity it is on, and each effect the tool still holds open by its `Type` and the `EntityId` of the action that yielded it. The uninterrupted run never ends with either.
- **`repairError`**: what the repair threw, as `"name: message"`.

Each event kind is a `{ missing, extra }` pair: what the uninterrupted run raised after the point and the restored run didn't, and the other way round. Order is ignored. What the restore itself raises, such as `restore/unresolved-receiver` or a failure of an action the repair dispatched, counts as raised after the point. A skipped step is not a difference by itself; what not playing it changed is.

**The uninterrupted run is strict and the restored runs are not.** The uninterrupted run is a test runtime with `options` as given, so a diag or failure it raises that `allowDiags` or `allowFailures` doesn't allow fails the test, as in any test, and a report names `differentialRestore`. Each restored run allows every diag and failure, and catches a throw out of `onError`, so what it raises is on the report instead, where the test asserts on it. A point's run up to the point allows them too, and what it raises there is not compared.

**What it doesn't see:**

- State is compared as its JSON form, so `NaN` and `null`, `-0` and `0`, and a missing key and one set to `undefined` compare equal.
- Arrays are compared index by index, so one lost item shows as a difference at every index after it, and the number of state differences doesn't measure how much was lost.
- The runtime's tables, its timers, data sources and resources, are not compared.
- A stub that resolves on a real timer can settle outside the tool's wait: during a later step, or after the run has been compared. It can also make the tool reject a point's run as differing from the uninterrupted run, and give a different result from one call to the next.
- An implementation of a held type registered after `setup` returns replaces the tool's hold.
- Only the tree as it ends is compared, so a difference a later step undoes doesn't show.
- An action's draft type isn't checked against the entity it is dispatched on.
- Transient state isn't compared, since the tool compares each run's final state tree, which transient state isn't part of.
- Effects aren't compared, so a repair that performs again an effect the uninterrupted run performed before the point reads `same` unless a stub that keeps state answers it differently.

#### Ids across a restore

The tool's `generateGuid` names each id for the step it is minted in. The n-th id minted while step k plays, its dispatch or settlement and everything that follows until the runtime has settled, is `stepk-n`, which `entity()` makes into the `$Id` `~stepk-n`: step 3's first is `~step3-1`. Each run counts every step's mints from 1, so a step that mints mints the same ids in every run, whatever was or wasn't minted before it. A mint after a step's wait, such as one from a stub that resolves on a real timer, is named for the last step the run played, or for the restore while a restored run has played none. What `setup` mints before step 1 is `setup-1`, `setup-2` and so on. What a restore's `setup`, its repair and the work they start mint before the first step after the point is `restore-1`, `restore-2` and so on. No step mints either.

A restore changes when things happen, so the same entity can be minted at another time, and so under another name, in a restored run: one the repair recreates is named `~restore-n`, and work queued behind dropped work starts, and mints, a step earlier. So the tool doesn't compare the ids minted after the point by name. It pairs each id the uninterrupted run minted after the point with at most one id the restored run minted, and two minted ids are equal when they are partners. An id minted before the point is in the snapshot under the name the uninterrupted run gave it, so it is its own partner in every restored run, and no other id pairs with it. Wherever a whole string is a minted id, as an `$Id`, a field, an array element, an object key or an event's `EntityId`, it equals only its partner. Ids the tool didn't mint, the seed's and an app's own, compare as written, and never equal a minted one.

An id minted after the point gets its partner in this order, and keeps it:

1. **The entity at the same place.** Where both final trees hold an object at the same place, reached by the same plain keys from the root and the same array indexes, and both its `$Id`s are minted, those two ids are partners.
2. **The id at the same place.** Where both final trees hold a minted id as a string at the same place, reached the same way, such as in a list of ids, those two ids are partners. An id written with the `~` of an `$Id` pairs only with another written with it.
3. **The order an id-keyed object was built in.** In an object whose keys are minted ids, a key whose id has a partner matches its partner's key. A key with no partner yet is paired with the next key of the other run's object that has none, each object's keys taken in the order they were added. An entity that sits under two matched keys then pairs as in 1.
4. **Where the two ids first meet.** Otherwise two ids are paired at the first place the comparison finds one in each tree, neither with a partner yet. The comparison takes the uninterrupted run's keys in that run's order.

An id met anywhere else against anything but its partner is a difference at that place, shown with both runs' real values. The two runs can use one name for different entities, so one path can show twice, with the uninterrupted run's entry as missing and the restored run's as extra, each naming a different entity. So:

- An entity the uninterrupted run minted after the point, which the repair recreates at the same place with the same contents, reads `same` under whatever name, and so does every field, key and event that names it.
- An entity that existed at the point keeps its id. A repair that replaces it with a new one, of whatever contents, differs at its `$Id`, and one the restored run removes or moves to another place differs at its place.
- A field that names another entity than in the uninterrupted run differs at that field: a selection moved to another entity shows at the selection, and nowhere else, whether the selection comes before or after the list the entities sit in. So does a selection left on an entity the restored run no longer has.
- Two entities that swap places differ in their contents at both places.
- A map from one entity to another that the restored run links the other way round, `{ [b]: a }` against `{ [a]: b }`, differs: the uninterrupted run's entry shows as missing and the restored run's as extra.
- An id-keyed object whose entities, or whose ids, sit in a list is matched through the list, so the order it was built in doesn't show, and one extra entry in it shows as that entry alone.
- One entity missing early in a list makes each entity after it pair with the one that took its index, so those differ in their contents, as any array compared index by index does. A field or event that names one of those entities then differs too, even when both runs name it with the same id.

The pairing has limits:

- An id inside a longer string, such as an error message, or one the app transforms, such as by upper-casing it, is compared as written.
- Ids that appear nowhere but as keys of objects keyed by id, and in what sits under those keys, are matched in the order the keys were added, so such objects built in another order can read as differing. A normalised map `{ [id]: { $Id: id, … } }` with no list of its ids beside it is one.
- An id minted after the point that neither run's final tree holds has no partner, so in an event any two such ids compare equal, and two events that differ only in which removed entity they name read the same.
- A list the app sorts by id comes out in another order in a restored run that minted under other names. That difference is the restore's doing, and shows.

A script step that names an entity by a literal id, such as `~step2-1`, names whatever each run minted under it, which in a restored run can be another entity or none. A script names an entity made during the flow by a function of the runtime, such as `(runtime) => runtime.state.Orders[0].$Id`.

#### Comparing with a data-only restore

**`compareDataOnly: true`** in `app` tests that [resume](./restart-and-records.md#resume) never leaves a restore worse than the restore an app without it makes. It is experimental, and may change in a minor version.

At each point the tool restores twice, in this order: the resumed run, as without the option, and then the data-only run. The data-only run plays the script to the point again from the seed, with `resume` still on, so its run is checked against the uninterrupted run's after each step as the resumed run's is, and with stubs of its own, so a stub that keeps state has seen the calls made before the point in each run. It restores its snapshot with `resume` left out of `options`, so every in-flight action drops with `resume-off`, and plays the rest of the script. Each point so costs about twice as much.

Each point gains:

- **`dataOnly`**, the data-only run's `result`, `skipped`, `differences` and `same`.
- **`comparison`**, with four fields:
  - **`worse`**, an `IDifferences` of what the resumed run differs by that the data-only run doesn't, and that nothing excuses. It is `{}` at a point where resume was never worse.
  - **`reported`**, an `IDifferences` of what `worse` would hold but for a resumed action the restore reported as carrying on beside dropped work, [below](#the-region-of-an-action-resumed-beside-dropped-work).
  - **`changed`**, the state paths both runs differ at, with another value in each, as `{ path, expected, actual, dataOnly }`, `actual` being the resumed run's value and `dataOnly` the data-only run's. They are not worse, and are listed so they can't hide: a test pins them.
  - **`diagCounts`**, for information only, as diags are compared below.

The report gains **`worse`**, the points whose `comparison.worse` isn't `{}`. Without the option the three fields are absent.

**What is compared.** An item is a state path, a failure event, an `onError` call, an action or held effect in `unfinished`, the repair's error, or a diag compared as below. An item of the resumed run is covered by one of the data-only run's of the same kind and side:

- A state path is covered by the same path or an ancestor of it, since the comparison stops where one side stops being an object: a record the data-only run lost covers a wrong field of it in the resumed run.
- An event in `missing` is covered by an equal event in the data-only run's `missing`, and one in `extra` by an equal one in its `extra`, each matched once.
- An unfinished action or held effect is covered by an equal entry in the data-only run's `unfinished`, each matched once.
- The repair's error is covered only by the same error.

Each restored run's ids are read through its own [pairing](#ids-across-a-restore) with the uninterrupted run. An id minted after the point is the same in both restored runs when each paired it with the same id of the uninterrupted run, and differs when only one did. Ids neither run paired are compared by the step that minted them, `stepk` or `restore`, since the two runs can use one name for different entities and different names for one. A path's segments are compared the same way.

**Diags are compared by presence,** by code and not by message, since a message names an entity that a "once" memory chose, and a restored runtime's "once" memories start empty. A code the resumed run raises after the point is an item when the data-only run doesn't raise it after the point and the uninterrupted run never raises it, before the point or after; the item lists its occurrences in `extra`. A code the uninterrupted run raises after the point is an item when the resumed run doesn't raise it after the point and the data-only run does; the item lists the uninterrupted run's occurrences in `missing`. Nothing else about diags is an item. `comparison.diagCounts` lists, for information, each code the three runs raised after the point a different number of times, as `{ code, uninterrupted, dataOnly, resumed }`. Diags whose code starts `resume/` are left out of every run: a data-only restore can't raise them, and [`resume/never-resumes`](./troubleshooting.md#resumenever-resumes) is raised for every designed drop. All of them stay in each run's `differences`.

##### The region of an action resumed beside dropped work

A resumed action carries on beside dropped work when the restore's `dropped` has an entry on its entity, an entity above it or one below it in the saved tree, or when its `resourceWork` is not empty: the work it carries on beside [is named for the repair](./restart-and-records.md#resume), and what follows from it is the restore's to report, not a resume made worse. Its region is its entity and every entity below it, in the uninterrupted run's final tree or the resumed run's. An item in the region goes to `reported` instead of `worse`:

- a state path at or under the place of an entity of the region;
- a failure event, `onError` call, unfinished action or held effect whose `EntityId` is an entity of the region;
- a diag item when every occurrence it lists names an entity of the region in its `data`.

The repair's error is never moved.

**What it doesn't see:**

- **`reported` is waived, not passed.** Nothing checks what it holds.
- **The region is where an entity sits in the tree,** the entity and what is below it. A fact about the entity kept anywhere else in the tree, such as a server's record of it read onto the root, is outside the region, so a difference there stays in `worse`.
- A resumed run that raises a code the other runs raise, a different number of times, shows only in `diagCounts`.
- **`skipped` is not an item.** A step the resumed run skips and the data-only run plays shows only through what it changed.
- Everything [the comparison with the uninterrupted run](#testing-every-restore-point) doesn't see, it doesn't see either.

#### What it refuses

It rejects, before running anything, with a `TypeError`:

- a `restoreTimeoutMs` that isn't a positive finite number;
- a seed whose root has no `$Id`;
- a held type declared `settles: "sync"`, which can't wait for a step; take it out of `hold`;
- `compareDataOnly` without `resume` and a `build` in `options`.

It rejects, before restoring anything:

- a step the uninterrupted run can't play, for any of the reasons a restored run skips one;
- a script that ends with an action running or an effect still held, since the uninterrupted run then has no outcome to compare with; add the steps that finish it;
- a held type the uninterrupted run never yields: either `hold` misnames it or the script doesn't reach it.

It rejects, in the uninterrupted run and for each restored point:

- a `generateGuid` stub, and a type both held and stubbed, each time `effectStubs` is read;
- an `effectStubs` function that returns a map, or a stub, it returned before, since the runs would then share it;
- a `setup` that returns a promise or another thenable: in the uninterrupted run with the `AsyncSetupError` a restore rejects it with, and in a point's run or its restore with an error that names the step after which the point lies and has the `AsyncSetupError` as its `cause`.

It rejects, naming the step after which the point lies:

- a point's run whose `setup` throws, with that error as the `cause`;
- a point's run that doesn't reach the state the uninterrupted run had, after `setup` or after any step before the point, or can't play a step the uninterrupted run played. The snapshot, its in-flight list and the held effects included and each timer's next due time, a clock reading, left out, is compared after each step, and the error names the first step after which they differ and the first place they do. A script, its stubs and the app's `setup` must do the same each time they run;
- a restore that rejects, such as one whose `setup` throws, with the restore's error as the `cause`;
- a restore that hasn't finished in `restoreTimeoutMs`. If effects are held open then, it lists them, since a repair that awaits work waiting on one never finishes. It disposes the restored runtime first.

### Testing a Solid component

A component test renders inside a real Solid root, under a `TreflexProvider`, with the host element in the document, since Solid delegates events like `onClick` to it:

```tsx
import { render } from "@solidjs/web";
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

The vitest config runs `@solidjs/vite-plugin`, `solid()`, and sets `test.environment: "jsdom"`, or sets `"node"` and the component test's file starts with `// @vitest-environment jsdom`, which runs that file alone in jsdom. Under `"node"`, the config also adds the `"browser"` condition to `resolve.conditions` and `ssr.resolve.conditions`; without it, `@solidjs/web` resolves to its server build, and the test file fails to load with `Client-only API called on the server side`. Component state needs a mounted component, so a headless test dispatches the action the component would call.

**A Solid signal's write lands at Solid's next flush,** a microtask later, so a test that types into an input the component keeps in a signal awaits `settled()` before the click that reads it.

## Caveats

- **The index walk runs on every reconciliation,** over the whole tree. A test that builds a large tree, a benchmark say, passes `verifyIndex: "budgeted"` or `false`.
- **The `inFlight` stub reacts to nothing,** so a memoized selector re-derives only on the record's own changes; read through `processSelector`, which doesn't memoize, after changing what the stub answers.
- **A stub answering from a real timer** hasn't answered yet: advance fake timers, under which `settled` still works, and then call it.
- **A restored runtime's `guids` under the same prefix** counts from 1 again, so it mints an `$Id` a restored entity already holds, and writing that entity throws `EntityReplacedError`.
- **A scripted resource type's setup and deliveries** run in the manager's microtask drain, so flush a microtask after opening before advancing fake timers.
