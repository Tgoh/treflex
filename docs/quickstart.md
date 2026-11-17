# Quickstart

A counter: one entity, one action that takes a second, and a button that shows the action is running. Each step shows React first, then Solid.

## Create the app

<!-- tabs -->

**React**

```sh
npm create treflex@latest counter -- --template react
cd counter
npm install
npm run dev
```

**Solid**

```sh
npm create treflex@latest counter -- --template solid
cd counter
npm install
npm run dev
```

<!-- /tabs -->

The app is an `App` root entity holding the counter below as a feature in its own folder, with a selector, tests, Biome and ESLint with treflex's lint rules, hot reload, and a count that survives a reload. Its `increment` is marked [`leading`](./reference/actions.md#arrival-marks), so a second `increment` dispatched while one runs is dropped rather than queued, which its test shows. The template requires a [durable name](./reference/actions.md#durable-names) on every action, so `increment` is marked `named(increment, "Counter/Increment")` too. Its `README.md` says what's where.

## Add treflex to an existing app

Start from a Vite app, or make one:

<!-- tabs -->

**React**

```sh
npm create vite@latest counter -- --template react-ts --no-interactive
cd counter
npm install treflex treflex-react
```

**Solid**

```sh
npm create vite@latest counter -- --template solid-ts --no-interactive
cd counter
npm install treflex treflex-solid solid-js
```

<!-- /tabs -->

[Requirements](./requirements.md) has what an app's build and tests need.

### Write the counter

Replace the entry file, `src/main.tsx` in React and `src/index.tsx` in Solid, with:

<!-- tabs -->

**React**

```tsx
import { createRoot } from "react-dom/client";
import { createRuntime, defineEffect, type IActionGenerator, type IEffect, type IEntity, implementation } from "treflex";
import { createEntityFeature, TreflexProvider, useInFlight, useRoot } from "treflex-react";

interface ICounter extends IEntity {
    Count: number;
}

interface IDelay extends IEffect {
    Type: "Counter/Delay";
    Ms: number;
}

const delay = defineEffect<IDelay, void>("Counter/Delay");
const delayImpl = implementation(delay, (effect) => new Promise<void>((resolve) => setTimeout(resolve, effect.Ms)));

function* increment(draft: ICounter): IActionGenerator {
    yield* delay({ Ms: 1000 });
    draft.Count++;
}

const Counter = createEntityFeature<ICounter>("Counter")({ increment });

const CounterView = Counter.provider(() => {
    const counter = Counter.use();
    const counting = useInFlight(increment, counter.state);
    return (
        <button disabled={counting} onClick={() => counter.increment()}>
            {counting ? "Counting..." : `Count: ${counter.state.Count}`}
        </button>
    );
});

const runtime = createRuntime<ICounter>({ $Id: "Counter", Count: 0 });
runtime.registerImplementation(delayImpl);

function Root() {
    return <CounterView state={useRoot<ICounter>()} />;
}

createRoot(document.getElementById("root")!).render(
    <TreflexProvider value={runtime}>
        <Root />
    </TreflexProvider>
);
```

**Solid**

```tsx
import { render } from "solid-js/web";
import { createRuntime, defineEffect, type IActionGenerator, type IEffect, type IEntity, implementation } from "treflex";
import { createEntityFeature, TreflexProvider, useInFlight } from "treflex-solid";

interface ICounter extends IEntity {
    Count: number;
}

interface IDelay extends IEffect {
    Type: "Counter/Delay";
    Ms: number;
}

const delay = defineEffect<IDelay, void>("Counter/Delay");
const delayImpl = implementation(delay, (effect) => new Promise<void>((resolve) => setTimeout(resolve, effect.Ms)));

function* increment(draft: ICounter): IActionGenerator {
    yield* delay({ Ms: 1000 });
    draft.Count++;
}

const Counter = createEntityFeature<ICounter>("Counter")({ increment });

const CounterView = Counter.provider(() => {
    const counter = Counter.use();
    const counting = useInFlight(increment, () => counter.state);
    return (
        <button disabled={counting()} onClick={() => counter.increment()}>
            {counting() ? "Counting..." : `Count: ${counter.state.Count}`}
        </button>
    );
});

const runtime = createRuntime<ICounter>({ $Id: "Counter", Count: 0 });
runtime.registerImplementation(delayImpl);

render(
    () => (
        <TreflexProvider value={runtime}>
            <CounterView state={runtime.state} />
        </TreflexProvider>
    ),
    document.getElementById("root")!
);
```

<!-- /tabs -->

Run `npm run dev` and click the button. It reads "Counting..." and stays disabled, then shows the new count.

One file keeps the parts together to read, and an edit to it starts the count over. An app from `npm create treflex` splits them, so an edit to an action, a selector or a view applies in place with the state kept.

## What each part is

- **`ICounter`** is an **entity**: an object in the state tree with an `$Id`. [1. An entity and its state](./guide/01-entities.md).
- **`delay`** is an **effect**, a request to the outside world as plain data, and `delayImpl` is what answers it. [2. An action, and holds](./guide/02-actions.md).
- **`increment`** is an **action**: a generator that writes to its entity through `draft` and calls effects with `yield*`. It holds the counter until it finishes, so a second `increment` queues behind it.
- **`Counter`** is a **feature**: `Counter.provider` mounts a view on the counter, and `Counter.use()` gives that view the counter's state and one method per action. [3. Views](./guide/03-views.md).
- **`useInFlight`** is true while `increment` runs or waits its turn on the counter. Nothing in the counter records it.

The [guide](./README.md#guide) builds a whole app this way, a step per page.
