# Effects

An **effect** is a request to something outside the runtime, described as plain data. An action yields a descriptor `{ Type, ...fields }`, the runtime hands it to the **implementation** registered for that `Type`, and the action resumes with a copy of what the implementation returned. Nothing sits between the yield and the implementation.

An implementation touches the outside world for one call. Something live that has to outlive the call, such as a socket, an observer or an object URL, is a [resource](./live-sources.md).

## Usage

The guide teaches effects in [2. An action, and holds](../guide/02-actions.md).

### Defining an effect

```ts
import { defineEffect, type IEffect } from "treflex";

export interface IFetchEffect extends IEffect {
    Type: "app/fetch";
    Url: string;
    Method: "get" | "post";
    Body?: unknown;
}

export const fetchJson = defineEffect<IFetchEffect, IFetchResult>("app/fetch");
```

An interface for the descriptor extends `IEffect`, which is `{ Type: string }`. `defineEffect<E, R>(type, options?)` declares the type at module load and returns the **creator**. It takes the descriptor's fields as one payload object (none, when the descriptor has no fields of its own) and is called with `yield*`:

```ts
const result = yield* fetchJson({ Url: "/api/rows", Method: "get" });
```

### Implementations

```ts
import { implementation } from "treflex";

export const implement = implementation(fetchJson, async (effect, action) => {
    const response = await fetch(effect.Url, { method: effect.Method, signal: action?.signal });
    return { Status: response.status, Body: await response.json() };
});

runtime.registerImplementation(implement);
```

`implementation(declaration, fn)` types `fn` against its declaration and returns a tag that `runtime.registerImplementation(tag)` takes. `fn` receives the descriptor and the [action context](#the-action-context), and returns the result or a promise of it, which the runtime awaits. The context is optional in the type, because a test or a direct call may pass none, so read it as `action?.signal`.

### The data-only rule

**Everything that crosses an implementation's boundary is plain data**, in both directions. Inside, an implementation may use anything: sockets, native APIs, module state. Convert at the boundary: return `{ Status, Headers: Record<string, string>, Body }`, never a `Response`; send a timestamp as epoch milliseconds; take `Dedupe: boolean`, never an `AbortController`.

The runtime copies the input and the result at the yield, so neither side holds the other's objects; what counts as plain, and how each copy is made, is on the [write path](./write-path.md#what-crosses-into-an-action).

### When to add an effect

Add an effect for mechanism: I/O against an external system, non-determinism the runtime must be able to stub, a side effect on the DOM. Composition of existing effects is a plain generator, not a new type:

```ts
export function* apiFetch(endpoint: string, method: "get" | "post", body?: unknown): IActionGenerator<unknown> {
    const session = yield* getSession();
    const result = yield* fetchJson({ Url: `${session.BaseUrl}${endpoint}`, Method: method, Body: body });
    if (result.Status === 401) {
        throw new Error("unauthorized");
    }
    return result.Body;
}
```

**An effect that does nothing external** is a function. Call it; don't yield it.

## Rules

### Declarations

- **The creator is typed `IEffectCreator<E, R>`**, or `ISyncEffectCreator<E, R>` for a [sync type](#sync-effects).
- **`E["Type"]` is one string literal.** A union of descriptors with different `Type`s is a compile error; a union sharing one `Type` keeps each variant's fields.
- **A creator with positional arguments** is a plain generator over the declaration:

  ```ts
  const delayEffect = defineEffect<IDelayEffect, void>("app/delay");
  export function* delay(ms: number) {
      return yield* delayEffect({ Ms: ms });
  }
  ```

- **Declarations are keyed by `Type` and shared by every runtime in the page.** Declaring a `Type` again with the same options does nothing, which is what a hot update does.
- **The names of the runtime's own [operations](#runtime-operations) and [reads](./derived-reads.md#the-reads) are reserved:** `defineEffect`, `registerImplementation`, `createRuntime`'s `implementations` and the test runtime's stubs all throw for one.

### Options

What a call site or the record relies on belongs to the declaration, because an implementation is swappable: a test stub may not honour it.

| Option | Means |
|---|---|
| `settles: "sync"` | The yield gives up no turn ([sync effects](#sync-effects)) |
| `redact: true` | The effect's records keep only its `Type` |
| `returns: "module"` | The result is not copied, and may carry module-level functions ([below](#module-results)) |

Any other option, or a bad value, throws `TypeError`.

**Redaction** keeps a payload out of the record stream and the snapshot: the `effect` record holds only `Type`, the `response` holds no value, a failure records `Error: { Thrown: "redacted" }`, and the live extras a record tap receives carry no result or error. Declare it for effects whose descriptors or results carry secrets, such as a session token. A type is redacted only by its declaration, so any implementation or stub of it is redacted alike.

#### Module results

**`returns: "module"`** exempts the result from the copy, so it may carry module-level functions: a lazy `import()` written as an effect, for code-splitting features by key. Use the module inside the action and store data from it. Writing the result itself into state, or anything holding a function, throws `NonPlainDataError`.

### Registering

- **The tag** is `{ Type, fn }`, typed `IImplementationTag`.
- **`registerImplementation(type, fn)` with a string** is the untyped form, as are `createRuntime`'s `implementations` option and a test runtime's stubs ([runtime](./runtime.md#options), [testing](./testing.md#effects-under-the-tests-control)).
- **A yield of a `Type` with no implementation** throws `No implementation registered for effect type: "X"` at the yield, in every build, and the action fails through its ordinary route. So a type nobody registered is a failed action, never a silent no-op.

### Sync effects

**A yield of a `settles: "sync"` type gives up no turn.** No waiting action resumes across it, and no timer, I/O callback or promise continuation from elsewhere runs. The yield still ends the step, so its writes are judged and flushed, and its records land. Inside [`reconcileRows`](./write-path.md#keys-and-the-refresh-step)'s `add` and `update` it doesn't end the step.

It is still an effect: recorded, stubbable, and not yieldable from a selector. Declare it only for value producers, such as ids, clocks and random numbers. Treflex ships one: `generateGuid`, which `entity()` yields.

- **The implementation returns its result, never a promise.** `implementation` rejects one that can return a promise at compile time. At runtime a thenable throws `SyncEffectPromiseError` at the yield and reports `effect/sync-returned-promise`, and its later rejection reports `effect/sync-promise-rejected`.
- **The implementation may not start an action or write state.** While it runs, any dispatch and any draft write throws `SyncEffectWorkError` at the call. The yield fails with it even if the implementation catches the throw.

Both are [refusals](./failure.md#refusals), thrown in every build.

### The action context

An implementation's second parameter is an `IActionContext`, one per fiber:

| Member | Is |
|---|---|
| `entityId` | The `$Id` of the entity the action runs on |
| `actionId` | The running action's id, as its records carry it |
| `signal` | An `AbortSignal` that fires when this fiber is [told to end](./fibers.md#stopping), and not when it completes or throws by itself |
| `get(key)` | A runtime service set with `runtime.set`, typed through `IRuntimeServiceRegistry`; it throws for a key nothing set ([runtime](./runtime.md#runtime-services)) |
| `processAction(action, getState, setState, idAccessor, ...args)` | The runtime's low-level dispatch, which needs accessors an implementation has no way to get |

**An implementation that must run an action on an entity** dispatches by `$Id` through `runtime.dispatch`: one it closes over where it is registered, or one the app puts in a runtime service with `runtime.set` and reads with `get`. A sync type's implementation can't dispatch at all. The action it starts is a new root action, and the effect's wait on it never ends when the action needs the yielding action's own entity, or one above it, since it queues behind the hold the yield keeps ([waits point down](./actions.md#waits-point-down)).

**What the signal governs is the work the effect left running,** since the fiber is gone either way and nothing receives the result. Each implementation decides. A read passes the signal to the wire, since its answer has no use once the fiber is gone. A write usually carries on, so a save the user closed the screen on still reaches the server. An implementation that loops, such as a retry with backoff, checks `signal.aborted` between attempts. A time limit on a call belongs in its implementation.

### Runtime operations

Treflex's own coordination is not made of effects. These are the runtime acting on itself, yielded with `yield*` like an effect:

- `start` ([actions](./actions.md#start)), `parallel`, `parallelSettled` ([fibers](./fibers.md#parallel-and-parallelsettled));
- `publish`, `publishToNearest` ([messaging](./messaging.md));
- `registerDataSource`, `unregisterDataSource` ([lookup](./lookup.md));
- `startTimer`, `stopTimer`, `openResource`, `closeResource`, and a resource method `resource(owner, key).method(...)` ([live sources](./live-sources.md#methods));
- `ask`, `answer` ([conversations](./conversations.md#ask-and-answer)).

Nothing is registered for an operation and nothing can replace one: the names are reserved, a resource method's being `"resource"`, so `defineEffect("resource")` throws, and a test observes an operation through its records and effects ([testing](./testing.md#runtime-operations-and-reads)). Each yield appends an `effect` record and its `response`, never redacted. Each checks its own rules where it runs. Their timing is in [actions](./actions.md#steps).

### Non-determinism

Route anything non-deterministic through an effect: ids, the clock, random numbers. Then a test can stub it, and the value is on the record stream. A fresh id for a field, such as a client-side key for a plain row, is `yield* generateGuid()`, which returns a bare uuid; `entity()` mints through it and adds the `~` that marks an `$Id`, so a `generateGuid()` value is never an `$Id`. A clock or a random source is an effect the app declares, usually `settles: "sync"`.

Treflex ships a Biome plugin, [`no-nondeterminism.grit`](../../packages/core/biome/no-nondeterminism.grit), which reports `Math.random`, `Date.now`, `performance.now`, `crypto.randomUUID`, `crypto.getRandomValues`, `new Date()` and `Date()`. Turn it on for feature code and exempt the implementation folders.

#### Lint setup

Register both plugins, `no-nondeterminism.grit` and [`require-yield-star.grit`](../../packages/core/biome/require-yield-star.grit), from the installed package, each in an override: a plugin declared at the top level runs on every file, and no override can leave a folder out of it. Turn Biome's `useYield` rule off for treflex code: an action that only sets fields, `function* toggle(d) { d.Open = !d.Open; }`, and a selector that reads nothing both have no yield.

```json
{
    "overrides": [
        {
            "includes": ["src/**"],
            "plugins": ["./node_modules/treflex/biome/require-yield-star.grit"],
            "linter": { "rules": { "correctness": { "useYield": "off" } } }
        },
        { "includes": ["src/**", "!src/**/implementations/**"], "plugins": ["./node_modules/treflex/biome/no-nondeterminism.grit"] }
    ]
}
```

`require-yield-star` runs without type information, so it matches treflex's own names, not resolved symbols. Where a local function shares one of its names, suppress that call with `// biome-ignore lint/plugin: <reason>`. An app's own effect creators and helper generators called and dropped are not reported. `treflex-eslint`'s [`no-discarded-generator`](../../packages/eslint/README.md#treflexno-discarded-generator) reads types instead, so it reports a generator a call creates and drops, an app's own included, with no names to list. It doesn't report a bare `yield` of a call or a read used as a condition; only the Biome plugin does. A project on Biome alone covers its own creators with a sibling plugin of the same shape that lists the app's names.

Run Biome from a pinned `@biomejs/biome` dev dependency: `npx biome` can resolve to an unrelated package that exits 0 without linting. The eslint rules, `treflex-eslint`'s `configs.recommended`, are registered as [its README](../../packages/eslint/README.md#registering-it) says.

### Policies and implementation state

- **A policy is an argument.** A function that lets callers choose caching or retries takes the choice as a parameter and passes it in the descriptor, where the implementation reads it. There is no middleware: nothing between the yield and the implementation sees an effect.
- **State an implementation keeps between calls** belongs in a runtime service, through `runtime.set` and `action.get`, so each runtime has its own. Module-level state works until a second runtime exists.

## Caveats

- **Declaring a `Type` again with different options** replaces the old declaration and the console warns; two modules declaring one `Type` should rename one.
- **Registering a `Type` again** replaces the implementation, and the console warns.
- **Redaction ends at the effect's own records:** a throw the action lets escape is recorded as the action's failure ([records](./restart-and-records.md#record-kinds)). Don't put a secret in an error message.
- **An effect whose creator is written by hand,** a generator yielding `{ Type, ...fields }` with no declaration, gives up a turn, has no typed implementation, and is never redacted. Its result is still copied. Declare it with `defineEffect`.
- **A sync type can't later take an asynchronous implementation** without changing what every call site can rely on. Declare `settles: "sync"` only where it will stay true.
- **The nondeterminism plugin doesn't see everything:** a call into a uuid library, or a direct `fetch` in an action, is not reported.
