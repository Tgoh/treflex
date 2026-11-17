# Views

The runtime knows nothing about rendering. Solid components reach it through `treflex-solid`, React components through `treflex-react`, and both bindings offer the same things with the same meaning. The root entry, `treflex`, carries no binding and no JSX. This page states the model in Solid's terms and then [what React changes](#react).

**Components are projections of state.** A component reads state through a read-only view and changes it only by dispatching actions. It owns no app state, subscribes to nothing by hand, and cleans nothing up: when an entity leaves the tree, the [dispose cascade](./state-tree.md#removal-ends-everything-attached) ends its work.

**The render tree is not the state tree.** Moving a component in the JSX, or rendering it through a portal, moves no state. Cross-cutting reads walk the state tree ([lookup](./lookup.md)), so refactoring the JSX can't break scoped configuration.

## Usage

The guide teaches views in [3. Views](../guide/03-views.md), and a list of row entities in [4. Rows](../guide/04-rows.md).

### TreflexProvider

The root of the binding. It puts a runtime from `createRuntime` in context for every feature and hook below it:

```tsx
const runtime = createRuntime<ITodoList>({ $Id: "App", Draft: "", Todos: [] });

render(
    () => (
        <TreflexProvider value={runtime}>
            <App state={runtime.state} />
        </TreflexProvider>
    ),
    document.getElementById("root")!
);
```

The root needs an `$Id`: with none, every action a feature dispatches on it rejects ([runtime](./runtime.md#dispatch)). One provider per page is the standard shape.

A runtime can also serve several providers, of either binding, side by side or one after another, such as a React tree unmounted and a Solid tree mounted in its place. Each mount owns its [component state](#component-states-lifetime) and its own view effects, and unmounting ends those, and what the DOM held such as scroll and focus, and nothing else: the rest of the tree, the actions running on it, timers, resources and the records carry on, and the next provider shows them as they stand. Every Solid tree must run on the runtime's copy of `solid-js` ([the Solid build](./runtime.md#the-solid-build)).

### Features

A **feature** turns an entity type's actions and selectors into a provider and a `use()`:

```ts
// Features/TodoList/Context.ts
import { createEntityFeature } from "treflex-solid";
import * as actions from "./Actions";
import * as selectors from "./Selectors";
import type { ITodoList } from "./State";

export default createEntityFeature<ITodoList>("Features/TodoList")(actions, selectors);
```

`createEntityFeature<T>(id?)` pins the state type, which extends `IEntity`, and the second call takes the modules and returns `{ provider, use }`, typed `IEntityFeature`.

#### provider

`Feature.provider(Body)` returns a component mounted with the entity's node as `state`, plus whatever props `Body` declares:

```tsx
export const App = Todo.provider(() => {
    const todo = Todo.use();
    return (
        <div>
            <input value={todo.state.Draft} onInput={(e) => todo.setDraft(e.currentTarget.value)} />
            <button onClick={() => todo.add()}>Add</button>
            <div>{todo.remaining()} remaining</div>
        </div>
    );
});
```

#### use

`Feature.use()`, called below the provider, returns:

- **`state`**, the entity's read-only view, reactive.
- **One method per action**, `(...args) => Promise<R | undefined>`, dispatching on the provider's `state`; the promise settles as [a dispatch's does](./actions.md#a-dispatchs-result). Views usually discard it. A failure takes [the failure route](./failure.md#the-route) from the entity; handling meant for one call is a `catch` in the action.
- **One method per selector**, `() => R`, read through the entity's [memo](./derived-reads.md#memos).

### Mounting a child feature

A parent mounts a child's provider with the child's node:

```tsx
<For each={workspace.state.Windows}>
    {(window) => (
        <Show when={window.App}>
            {(app) => <AppView state={app()} />}
        </Show>
    )}
</For>
```

**The node is the target.** Each action dispatches on `props.state` as it reads at the call, so a moved entity keeps working with nothing at the mount site to keep in sync. The same feature works as the whole app or as one slot of a parent. **Gate a slot that can be empty** with `<Show>`.

**A Solid view reads through into a child entity's fields,** so the workspace above can show `window.App?.Title` from its own `state`. A React view doesn't ([entity views](#entity-views)).

### useInFlight

`useInFlight(reading, owner)` is a view's read of [`inFlight`](./actions.md#inflight): whether work of an action, a [work tag](./actions.md#work-tags), or any of a list of them, is running or queued on an entity the view holds. It needs no selector, and no feature for the entity:

```tsx
const saving = useInFlight(save, () => editor.state);

<button disabled={saving()} onClick={() => editor.save()}>Save</button>;

<For each={editor.state.Rows}>
    {(row) => {
        const busy = useInFlight(saveRow, row);
        return <li classList={{ busy: busy() }}>{row.Name}</li>;
    }}
</For>;
```

It returns an accessor. The owner is a node, or a function returning a node or `undefined`, which it follows; `undefined` reads `false`.

### Reading through selectors

A component can't yield, so apart from busy state it reads everything that is a read, [transients](./state-tree.md#transients), [`inFlight`](./actions.md#inflight) combined with other state, [`pendingAsks`](./conversations.md#rendering-the-open-asks) and [`getData`](./lookup.md#reading), through a selector, and reacts to it:

```tsx
function* uploaded(draft: IEditor): ISelectorGenerator<number> {
    const { Sent, Total } = yield* upload(draft);
    return Total === 0 ? 0 : Sent / Total;
}

<progress value={editor.uploaded()} />;
```

### useComponentState

For state only the view needs, such as an open dialog's copy of what it edits, column widths or a selection:

```tsx
function* increment(draft: { $Id: string; Count: number }): IActionGenerator {
    draft.Count++;
}

function Counter() {
    const counter = useComponentState(() => ({ Count: 0 }));
    return <button onClick={() => counter.dispatch(increment)}>{counter.state.Count}</button>;
}
```

`useComponentState(factory)` mounts an entity in [`ComponentState`](./state-tree.md#component-state) and returns `{ id, state, dispatch }`, typed `IUseComponentState`: its `$Id`, its read-only view, and a dispatch of an action on it, the only way it changes.

## Rules

### The provider

A root with no `$Id` rejects each dispatch with `TypeError: [treflex] dispatch: the target is not an entity`.

A component's or view effect's throw below the provider never fails an action; it is raised as [a view crash](./failure.md#a-views-throw), so a throw this page names, such as `use()` outside its provider, arrives that way rather than out of `render`.

The bindings need the provider. `useComponentState`, `createComponentFeature`, `useInFlight`, `useDispatch` and `useLocate` throw an error that names the missing provider, as every React hook and provider does.

### Busy state

- **Busy is for display.** `useInFlight` catches up with a dispatch late: in Solid a microtask after it, as a selector's memo does, and in React at the re-render after it. So `if (!saving()) editor.save()` lets through a second dispatch in the same turn, and guards nothing dispatched elsewhere. Mark the action [`leading`](./actions.md#arrival-marks), which drops a repeat from any caller.
- **Busy combined with other state is a selector** reading `inFlight`, as in [`inFlight`'s usage](./actions.md#inflight).
- **A node is fixed, a function is followed.** Pass `() => feature.state` for a feature's own entity, since its provider can come to show another; a row under `<For>` is fixed for its component's life.
- **The owner is a live node.** A copy or other plain object throws, naming the hook; React reads any owner by its `$Id` ([below](#features-in-react)). A node that leaves the tree reads `false`, and its work again if it comes back. Another runtime's node reads that runtime's work.
- **The test runtime's [`inFlight` stub](./testing.md#stubbing-inflight)** answers it, as it answers a selector.

### Feature types and calls

The mount site takes exactly `state` and the props `Body` declares: an undeclared prop, or a missing declared one, is a compile error. Children are a prop like any other. The types are `IProviderProps<T, P>` and `IBodyProps<P>`.

`use()` outside its provider throws. The methods read the modules at call time, so an edited action or selector applies on its next call, and a new export is callable without remounting.

- **A dispatch refuses any node but the one the index holds under its `$Id`** with `dispatch/node-mismatch`: a superseded node, a copy that kept its `$Id`, or another runtime's node ([runtime](./runtime.md#dispatch)).
- **A dispatch through a provider mounted on an `$Id` the tree doesn't hold** rejects with `dispatch/unresolved-entity`.

### Hot reload and the id

The `id`, a string the app picks for each feature, such as `"Features/Cart"`, keys a registry on `globalThis` that keeps the feature's context across a hot update: mounted providers stay valid, and the actions and selectors are swapped in place. The id is normalised by dropping a query string and hash, so duplicate module loads converge on one entry.

- **One id is one factory call.** A second call with the same id overwrites the first's actions and selectors, silently, and the first feature's views then dispatch the second's actions. Give each feature an id no other uses.
- **Pick the id by hand, not `import.meta.url`.** Two factory calls in one module share its `import.meta.url`, so the second overwrites the first. A URL-shaped id also registers in development only: in a production build `import.meta.url` is the URL of the chunk a module landed in, shared by every module in it, so there each call gets its own context, and a bundle built in development mode gives a chunk's modules one URL, where the ids collide. A hand-picked id registers in every build.
- **Keep context factories in a `.ts` file that exports no components,** a raw `createContext` included. A component file is re-evaluated on every edit, and a Vite duplicate load evaluates a module twice; a raw context made there gets a new identity each time, and its consumers stop finding it. The registry protects a treflex feature that has an id, and the same habit covers both.
- **The module that boots the app must not run again.** An edit Vite can't apply in place goes up to the modules importing the edited one, and an entry module that runs again builds a second runtime beside the first. Declare no component in the entry module, so an update that reaches it reloads the page, and have the module that builds the runtime accept updates of the feature modules it imports, with `import.meta.hot?.accept(["./counter/counter"], () => {})`, so an edit to an action or a selector stops there. In Solid, the entry mounts the views through a component declared in a file of its own, as the template's `AppView` does: a view made by `provider(...)` is no solid-refresh boundary, so an entry that mounts one directly reloads the page at every edit. In React, a module that declares a `provider(...)` view is a Fast Refresh boundary itself, so the entry may mount the view directly. An app from `npm create treflex` does all of this ([the quickstart](../quickstart.md#create-the-app)).

Covered by hot reload: editing an action, a selector or a component, and adding an action or selector.

### Dispatching from a component

A feature's own actions go through its `use()`. For an entity a component holds no provider for, such as [an ask's owner](./conversations.md#rendering-the-open-asks), `useDispatch()` returns `runtime.dispatch`, typed `IDispatch`, which takes the target as an `$Id` or a live node. `useLocate()` returns `runtime.locate`.

#### A form over part of an entity

A shared form edits whatever node it is mounted on:

```tsx
<AddressForm state={record.state.Address} />
<AddressForm state={record.state.Billing.Address} />
```

Its write asks where the node stands and dispatches one ordinary action on the entity there:

```ts
function* setField(draft: IEntity, at: ILocation, field: string, value: string): IActionGenerator {
    let node: any = at.TransientName === undefined ? draft : yield* transient(draft, at.TransientName, {});
    for (const key of at.Path) node = node?.[key];
    if (node !== null && typeof node === "object") node[field] = value;
}

function AddressForm(props: { state: IAddress }) {
    const locate = useLocate();
    const dispatch = useDispatch();
    const set = (field: string, value: string) => {
        const at = locate(props.state);
        if (!at) return;
        void dispatch(setField, at.EntityId, at, field, value);
    };
    return <input value={props.state.Street} onChange={(e) => set("Street", e.currentTarget.value)} />;
}
```

**`locate(node)`** answers `{ EntityId, Path }`: the nearest entity at or above the node, in any root, and the key path down from it. For a node in a transient it adds `TransientName`, and `Path` starts inside the transient. Otherwise:

- **`undefined`** for no node, or a node that has left the tree. The form stays silent, as a field that writes on blur does while its form unmounts.
- **A throw** for anything no dispatch can address, so a wrong mount site is loud: a copy or plain object, another runtime's node, a node with no entity above it, or the default a read of an unwritten transient answered.

**Rows a form edits by position are entities.** The path is taken at the dispatch and walked when the action starts, so a write queued behind a [hold](./actions.md#holds) lands on whatever row then stands at that index. Make the rows with `entity()` and mount the form on each row: `locate` answers the row's own `$Id` with an empty path, and no shift of the array moves the write. Nested plain data nothing reorders, such as an address, needs no entity.

### Reading without a feature

A component that holds a node but no feature for it reads busy state with `useInFlight`, and any other selector with a Solid memo over `runtime.processSelector(selector, () => node)`, which runs the selector fresh each time the memo re-runs ([memos](./derived-reads.md#memos)).

### A list over a selector

A selector that returns fresh objects remounts a keyed list, and the remount loses what was typed in it:

```tsx
function* rows(draft: IList): ISelectorGenerator<IRowView[]> {
    return draft.Rows.map((r) => ({ Id: r.$Id, Name: r.Name }));
}

<For each={list.rows()}>{(r) => <input value={r.Name} />}</For>;
```

`<For>` keys on object identity, and every re-run returns new objects, so every row is rebuilt, including rows nothing happened to. Return the nodes themselves, `draft.Rows.filter((r) => !r.Done)`, or key the list on strings, `draft.Rows.map((r) => r.$Id)`.

### Component state's lifetime

- **It mounts when the component runs,** before its children, outside any action, so it is there at the first render and never waits for a held entity.
- **It mounts under the nearest feature provider's entity** when that entity is in `AppState` or `TransientState`, or under the root with none. A provider over an entity in component state passes its own outer owner on, so component mounts are flat.
- **It goes when the component unmounts or the owner leaves,** whichever is first, and the cascade ends its work. A keyed list can unmount a row's component while the row stays: it scrolls out of a virtualized list, the selection changes, or a selector returns fresh objects. State that must outlive the row's component goes on the owner ([per-row view state](../patterns.md#per-row-view-state-lives-on-the-owner)).
- **`id` and `state` can change,** so read them where they are used, as props are, rather than destructuring them.
- **The factory holds no `$Id` at any depth** ([`$Id` rules](./state-tree.md#rules-on-an-id)), and holds plain data, so a grid's column renderers are props and its state names a column by its field. To edit a copy of a row, seed from a [copy without its ids](./state-tree.md#an-id-names-one-node).
- **Only view state.** A sort or filter that decides which rows a screen loads is the screen's state, which the grid takes as props. The grid keeps column widths, selection, expansion, and a sort over rows already loaded.

### Holds in a widget

An action on component state [holds](./actions.md#holds) the widget's entity, so input dispatched to the widget during a long action of its own waits.

- **A load keyed on a prop** would queue a second load behind the first and show the stale result for a round trip. Mark it [`latest`](./actions.md#arrival-marks).
- **A long wait of the widget's own,** such as an upload while the user types, goes inside [`open(...)`](./actions.md#letting-other-work-in-open).
- **Work that is the screen's,** such as a save, is the screen's action. It holds the screen and leaves the widget free: a dialog calls the screen's action with its copy, shows busy with `useInFlight` on the screen's entity, and shows a failure the action returns as data.

### createComponentFeature

The component-bound sibling of `createEntityFeature`, typed `IComponentFeature`: the same `provider` and `use()`, but the provider mounts an entity as `useComponentState` does, from a factory, instead of taking one as a prop.

```ts
export const GridFeature = createComponentFeature<IGridState>("Widgets/Grid")(actions, selectors);
export const Grid = GridFeature.provider(GridBody, () => ({ Widths: {}, Selected: [] }));
```

`Grid` takes exactly the props `GridBody` declares, and no `state`. Don't declare a `state` prop on a component feature's body: the mount site would then require one, the body would read the passed node, and `use().state` would return the mounted one, with nothing reporting it. Reach for `createComponentFeature` when a widget has actions and selectors of its own over state only its view needs.

### useResource

`useResource(owner, key)` is a view's one way to a [resource](./live-sources.md#supply-and-expose): it reads the live value the resource exposes, its status, and supplies live values to it.

### React

`treflex-react` runs on React 18.3 and later 18 releases, and on React 19.1 and later: its `react` peer range is `^18.3.0 || ^19.1.0`.

`treflex-react` offers `TreflexProvider`, `createEntityFeature`, `createComponentFeature`, `useComponentState`, `useInFlight`, `useResource`, `useDispatch` and `useLocate`, with Solid's meaning, plus `useEntity` and `useRoot`. The runtime under it is built on Solid's signals, from the `solid-js` that `treflex` depends on, so a React app's build and test configs resolve Solid's browser build ([runtime](./runtime.md#the-solid-build)).

**The one difference underneath the rest is what a component reads.** A Solid component reads the live tree through a reactive view. A React component reads **entity views**.

#### Entity views

An entity view, `IEntityView<T>`, is a frozen, read-only copy of one tree node. It keeps its reference until something under it is written, so React's reference checks and `memo` see exactly what changed.

- **A child entity inside a view is an entity ref,** `{ $Id }`, typed `IEntityRef<T>`. A write to a child changes the child's view and nothing above it, so it re-renders the child's component and not the parent's. Adding or removing a child changes the parent's list, and so the parent's view.
- **The types say the same:** reading a child's fields through its parent's view is a compile error. A slot typed as a union of entity types holds a ref with no discriminant; keep the discriminant beside the slot, or read it through a selector.
- **To read a child,** mount its provider with the ref, read its view with `useEntity<T>(id)`, which is `undefined` while the tree holds no such entity, or read it through a selector. `useRoot<T>()` returns the root's view.

```tsx
const runtime = createRuntime<ITodoList>({ $Id: "App", Draft: "", Todos: [] });

function Root() {
    return <App state={useRoot<ITodoList>()} />;
}

createRoot(document.getElementById("root")!).render(
    <TreflexProvider value={runtime}>
        <Root />
    </TreflexProvider>
);
```

#### Features in React

`createEntityFeature<T>(id?)(actions, selectors)` is curried as in Solid, and its `id` follows [Solid's registry rules](#hot-reload-and-the-id); with an id, Fast Refresh keeps mounted providers and their subtrees, component state included. Without one, each evaluation gets a fresh context.

- **The provider takes `state` as an `IEntityRef<T>`.** A view carries its `$Id`, so it is a ref too. A ref or view of another entity type is a compile error.
- **Actions dispatch on the node the ref was built from** in the last committed render, so they follow the entity wherever it moves. A ref from before its entity was replaced is refused as `superseded` until the parent re-renders; a copy of a view, `{ ...view }`, maps to nothing and is refused as `foreign`; a hand-written `{ $Id }` dispatches by its `$Id`.
- **`use().state` is the entity's view.** A component re-renders for it only once it has read it, so one that only calls actions doesn't re-render as the entity changes.
- **Selectors are `() => ISelected<R>`.** A component re-renders when a selector it has called changes, and never for one it hasn't. Every entity in a result is that entity's view, and a result keeps its reference until the selector re-runs or an entity in it changes.
- **Mount a provider only on an entity the tree holds.** `use()` throws at the first render otherwise, so gate a slot that can be empty. An entity that leaves after its provider mounted leaves the provider its last view until the parent re-renders it away, and a dispatch through it meanwhile rejects with `dispatch/unresolved-entity`.

`useDispatch()` takes an `$Id`, a ref or a view as the target, and `useLocate()` locates the node a ref or view was built from, so [a form](#a-form-over-part-of-an-entity) works the same over a view. A row that is an entity is a ref in its parent's view, so its form goes inside the row's own provider.

`useInFlight(reading, owner)` returns a boolean and re-renders when it changes. The owner is a view, a ref, an `$Id` or `undefined`, read by `$Id` in the provider's runtime, so a row's ref reads the row's work with no provider for it.

#### Component state in React

`useComponentState` and `createComponentFeature` behave as in Solid, with `state` an entity view. A render React discards must leave nothing behind, so the entity isn't seated during render: the first render reads a frozen copy of the factory's values, and the entity is seated by the component's mount, or earlier by a dispatch from a child's layout effect. An unmount removes it a microtask later unless the component has mounted again by then, so StrictMode's rehearsal unmount leaves it and its work running. Suspense hiding shown content removes that content's component state and stops its work; the reveal seats it again, under the owner the provider shows then.

#### Transients in React

A view is a plain copy, so it can't lead to a transient: read it through a selector, whose draft is live. A component holding only an id gates a provider on `useEntity(id)`.

### What reports a broken rule

| Rule | Reported by |
|---|---|
| A provider is mounted on the node the index holds | `dispatch/node-mismatch` at a dispatch, in both bindings |
| Gate a slot that can be empty | `dispatch/unresolved-entity` at a dispatch; in React, `use()` throws at the first render |
| A mount site passes the body's props and `state` | The compiler |
| A component feature's body declares no `state` prop | Nothing |
| Keep context factories in a `.ts` file with no components | Nothing |
| One id is one factory call | Nothing: where the id registers, the second call overwrites the first's actions and selectors |
| The module that boots the app must not run again | Nothing: a second runtime boots. React logs an error that `createRoot()` was called on a container passed to it before; Solid logs nothing, and can render a second app beside the first |
| A form writes through `locate`: silent for a node that has left, loud for one no dispatch can address | `locate` throws |
| Busy is for display, and `leading` drops a repeat | Nothing: a click guarded on busy misses a repeat in the same turn, and one dispatched elsewhere |
| Solid: `useInFlight` takes a live node | `useInFlight` throws |
| Rows a form edits by position are entities | Nothing: a queued write lands on the row that shifted into place |
| Component state holds only what the view needs | Nothing: it is gone after a restore and absent headless |
| A component factory holds no `$Id` | `HandWrittenIdError` |
| React: read a child through its own view | The compiler |
| React: don't write through a view | The compiler, and a `TypeError`, since every view is frozen |

## Caveats

- **A Solid provider with no `TreflexProvider` above:** an entity feature's provider, or `useResource`, mounted that way throws a bare `TypeError` that names no provider: in Chrome and Node, `Cannot read properties of undefined (reading 'get')`, and other engines word it differently. Mount a `TreflexProvider` at the root.
- **`use()` throws "outside the matching provider" with the provider visibly mounted,** in development only, coming and going with edits and cured by a dev-server restart: the context's identity has drifted, and the provider and the consumer hold two different contexts. The causes are a context made in a component file that an edit re-evaluated, and a module the dev server loaded twice under two URLs, which the browser treats as two modules. A treflex feature with an id keeps one context through both; a raw `createContext`, or a factory given no id, doesn't. Move the factory or `createContext` call into a `.ts` file with no components, and use one import specifier per module. The error names the factory's id, which tells you which feature it is.
- **A feature folder added after startup** isn't covered by hot reload: an app's startup registries don't see it until a full reload.
- **A dispatch made after the component unmounted,** such as from a blur handler firing as a dialog closes, seats the entity again so the action starts, and the removal a microtask later stops it.
- **When a provider comes to show another entity,** as an unkeyed provider, `<Show>` or `<Index>` can, the component state entity under it moves under the new owner with its state. If the old owner's removal already took it, a fresh one starts from the factory. Under an owner already gone, nothing is seated: `state` reads the factory's values, and a dispatch rejects.
- **React: a controlled input targets an entity no long action holds.** If its `onChange` dispatches onto a held entity, React resets the input before the queued action runs, and keystrokes are lost. Keep the text in component state or on a child entity, or put the long action's wait inside `open(...)`.
- **React: a hand-written `{ $Id }` literal** carries no type and is accepted by a provider.
- **React: a `Map` or `Set` in a selector result** is passed through unconverted.
- **React: owner changes while Suspense hides content** are invisible to React, so where Solid would start fresh because the owner the state sat under was removed meanwhile, React moves the state to the owner shown at the reveal.
