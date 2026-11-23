# Patterns

Shapes that cross more than one concept, each with the reference rule it rests on. The [guide](./guide/01-entities.md) teaches the basics these build on.

## Ownership and holds

### One entity or two

**Situation.** An entity's jobs need different granularity: its id, its lifetime, its hold and the messages it hears don't all fit one node.

**Shape.** Usually one entity does all four jobs: a row has an id, goes when it's deleted, saves without blocking its siblings, and hears messages about itself. When those needs differ, split the work across entities:

- A list's order and membership belong to its parent: adding, removing and reordering rows are the parent's writes.
- Work that must end with something, or be cancelled on its own, runs on a child entity, whose removal ends it.
- A child entity that exists only so its work can hold it, or be replaced to cancel that work, is fine ([move long work onto a child entity](#move-long-work-onto-a-child-entity), [stop stale work by replacing its entity](#stop-stale-work-by-replacing-its-entity)).

**Why.** A hold, a removal and a binding each apply to a whole entity, so work that needs a different one of them needs an entity of its own. Rules: [writing into a child entity](./reference/actions.md#writing-into-a-child-entity), [work entities](./reference/fibers.md#work-entities).

### Rows as entities

**Situation.** A list's rows each have work of their own: a save per row, a request per query, a form per row.

**Shape.** Make each row an entity and dispatch its work on the row.

```ts
interface IRequest extends IEntity {
    Query: string;
    Result: string[] | null;
}

export function* run(draft: IRequest): IActionGenerator {
    draft.Result = yield* findItems({ Query: draft.Query });
}
leading(run);
```

A view shows each row busy with `useInFlight(run, request)` on the row it holds, with no feature for the row.

**Why.** A hold, `inFlight` and `leading` go by entity, not by argument, so each row's work holds, shows busy and drops a repeat for that row alone, and its removal ends it. An action on the parent that takes a row id and finds the row is the sign the work belongs on the row. Rows a form edits by position must be entities too, or a queued write can land on a row that shifted into place. Rules: [which entity owns an action](./reference/actions.md#which-entity-owns-an-action), [a form over part of an entity](./reference/views.md#a-form-over-part-of-an-entity).

### Move long work onto a child entity

**Situation.** An entity the person keeps using, a session, a screen, a list, waits on the network, and everything else on it queues behind the wait.

**Shape.** Give the work an entity of its own under the busy one, an upload or a request row, and start the work there: [work entities](./reference/fibers.md#work-entities) has the sample.

**Why.** The work holds only its own row, so the busy entity stays free, and cancelling is removing the row. An entity that needs many `open(...)` waits is usually doing work that belongs to its children.

### Decide per wait, and default to holding

**Situation.** An action waits, and something might need to happen on the same entity during the wait.

**Shape.** Hold, unless something must get in: typing while a send is in flight, a Stop button, updates the server pushes into the entity. Then wrap that wait, and re-check after it.

```ts
interface IDoc extends IEntity {
    Body: string;
    Version: number;
    Saved: boolean;
    SaveError: string;
}

export function* save(draft: IDoc) {
    const body = draft.Body;
    const saved = yield* open(postDoc({ Body: body }));
    draft.Version = saved.Version;
    draft.Saved = draft.Body === body;
}
leading(save);
```

**Why.** Holding is what makes re-checks after a wait unnecessary: no other work on the entity interleaves with the action, and the [reading rule](./reference/actions.md#holds) names the one writer that can still get in. A repeat queues behind the hold and runs after it; `leading` is what drops one, during an open wait too. An open wait still counts for `inFlight`. Rules: [holds](./reference/actions.md#holds), [`open`](./reference/actions.md#letting-other-work-in-open), [re-checking after a wait](./reference/actions.md#re-checking-after-a-wait).

### Busy is `inFlight`, not a flag

**Situation.** A button should disable while its action runs, and a repeat shouldn't run twice.

**Shape.** Read it in the view with `useInFlight(action, node)`, and mark the action `leading` to drop a repeat, as guide [page 3](./guide/03-views.md#components) does. A selector reads `inFlight` only where busy is combined with other state.

**Why.** Guide [page 3](./guide/03-views.md#three-mistakes) shows why a flag set in the action's first step fails while a click is queued. A flag cleared in a `finally` can also be lost: a stopped action's `finally` can't write the draft while it is let go inside `open(...)`. `inFlight` counts queued work and clears however the run ends. Rules: [`inFlight`](./reference/actions.md#inflight), [busy state](./reference/views.md#busy-state), [arrival marks](./reference/actions.md#arrival-marks).

### Stop stale work by replacing its entity

**Situation.** Work becomes stale before it ends: a search the person has retyped, a history window a reconnect has replaced.

**Shape.** Make the thing the work is for an entity, and replace it.

```ts
interface IQuery extends IEntity {
    Text: string;
    Results: string[] | null;
}

interface ISearch extends IEntity {
    Current: IQuery | null;
}

export function* search(draft: ISearch, text: string): IActionGenerator {
    const query = yield* entity<IQuery>({ Text: text, Results: null });
    draft.Current = query;
    yield* start(runQuery, query);
}

export function* runQuery(draft: IQuery): IActionGenerator {
    draft.Results = yield* findItems({ Query: draft.Text });
}
```

**Why.** Writing the new query over the slot removes the old one and stops its run; its fetch ends too when the effect's implementation honours the abort signal. A check after a wait that compares a cursor or a counter is the sign this is missing. Where the repeat is the same action on the same entity, [`latest`](./reference/actions.md#arrival-marks) does it with less. Rules: [removal](./reference/state-tree.md#removal-ends-everything-attached), [stopping](./reference/fibers.md#stopping).

### A `latest` action reads its inputs from state

**Situation.** An action marked `latest` needs a value, such as a filter, that changes between runs.

**Shape.** Write the value from a small unmarked action, then start the `latest` action, which reads it from the draft.

```ts
interface IList extends IEntity {
    Filter: string;
    Rows: string[];
}

export function* setFilter(draft: IList, filter: string): IActionGenerator {
    draft.Filter = filter;
    yield* start(reload, draft);
}

export function* reload(draft: IList) {
    draft.Rows = yield* open(findItems({ Query: draft.Filter }));
}
latest(reload);
```

**Why.** `latest` stops a queued instance as well as a running one, so a value passed only as an argument is lost when another start arrives first, such as a refresh just after a filter change. In state, every run reads the current value. Rule: [arrival marks](./reference/actions.md#arrival-marks).

## Parents and children

### A parent's receiver starts work on the child

**Situation.** A parent hears something that changes a child: a session hears that one of its documents changed on the server.

**Shape.** Where the child can be busy with work of its own, start the change on the child rather than writing its fields.

```ts
interface IDocument extends IEntity {
    DocId: string;
    Text: string;
}

interface ISession extends IEntity {
    readonly $Receiver?: IReceiverId<ISession>;
    Docs: IDocument[];
}

export function* applyChange(draft: IDocument, text: string): IActionGenerator {
    draft.Text = text;
}

export const SessionReceiver = receiver<ISession>("SessionReceiver")({
    *"Doc/Changed"(draft, message) {
        const doc = draft.Docs.find((d) => d.DocId === message.DocId);
        if (doc) yield* start(applyChange, doc, message.Text);
    }
});
```

**Why.** A start queues behind the child's hold, so the child's own action never finds its fields changed under it, and starts to one entity run in the order they were made. Guide [page 5](./guide/05-messages.md#start-work-for-a-child) builds the same shape from an action. Rule: [writing into a child entity](./reference/actions.md#writing-into-a-child-entity).

### A parent stops reading what it handed off

**Situation.** A parent starts work on a child and then wants to act on the outcome.

**Shape.** Put the decision in the child's action, or have the child send the outcome back as a message ([below](#results-and-endings-go-up-as-messages)).

**Why.** `start` doesn't wait, so on the parent's next line the child's work has at most begun. Rule: [`start`](./reference/actions.md#start).

### A refresh per entity type

**Situation.** Server data refreshes a subtree that holds entities.

**Shape.** One function per entity type, which writes the type's own fields and calls `reconcileRows` for each list, keyed by a server id, with `add` minting a row and `update` calling the row type's own function. A first load is the same call over an empty list. Where each row's refresh is its own action, keep `reconcileRows` for membership and order, with `update: () => {}`, then start each row's refresh, since writing a held child's fields from `update` is the write `entity/written-while-held` reports:

```ts
interface ICard extends IEntity {
    CardId: string;
    Title: string;
}

interface IColumn extends IEntity {
    ColumnId: string;
    Name: string;
    Cards: ICard[];
}

interface IBoard extends IEntity {
    Name: string;
    Columns: IColumn[];
}

export function* assignBoard(draft: IBoard, info: IBoardInfo): IActionGenerator {
    draft.Name = info.Name;
    yield* reconcileRows(draft.Columns, info.Columns, (row) => row.ColumnId, {
        add: (item) => entity<IColumn>({ ColumnId: item.ColumnId, Name: "", Cards: [] }),
        update: () => {}
    });
    for (const [i, column] of draft.Columns.entries()) {
        yield* start(assignColumn, column, info.Columns[i]);
    }
}

export function* assignColumn(draft: IColumn, info: IColumnInfo): IActionGenerator {
    draft.Name = info.Name;
    yield* reconcileRows(draft.Cards, info.Cards, (row) => row.CardId, {
        add: (item) => entity<ICard>({ CardId: item.CardId, Title: "" }),
        update: (card, item) => {
            card.Title = item.Title;
        }
    });
}
```

**Why.** A matched row keeps its node, `$Id`, work, binding and client-only fields; only the server's fields are written. After `reconcileRows` the list is in the incoming order with unmatched rows removed, so row `i` lines up with item `i`. A generic deep fold over state that holds entities is wrong: it deletes `$Id`, `$Receiver` and fields only the client writes, writes into child entities that may be held, and ends an entity's work through a bad match. A deep fold is right only over plain data the server owns, with no entities and no client-only fields; there, skip `$` keys, compare before assigning, and recurse rather than replace, since a replaced value re-runs every view that reads it. Rule: [refreshing rows](./reference/write-path.md#refreshing-rows).

### Load data when the app opens

**Situation.** Server data should load each time the app opens, whether the boot restores a save or starts fresh.

**Shape.** The boot dispatches the load once the runtime exists, after the restore or the fresh start, on both paths. No view starts it.

```ts
const fetchBoard = defineEffect<{ Type: "App/FetchBoard" }, IBoardInfo>("App/FetchBoard");

export function* refreshBoard(draft: IBoard): IActionGenerator {
    const info = yield* fetchBoard();
    yield* assignBoard(draft, info);
}
leading(refreshBoard);

export async function boot(): Promise<IRuntime<IBoard>> {
    const runtime = await restoreOrCreate();
    void runtime.dispatch(refreshBoard, "Board");
    return runtime;
}
```

**Why.** A restore doesn't run what the fresh path runs, such as an `init`, so a load placed there runs on the first open only, and a load a component dispatches when it mounts runs again at each mount. The boot discards the dispatch's promise, so a failed load needs the runtime's `onError` ([the dispatch promise](./reference/failure.md#the-dispatch-promise)). Rules: [restoring](./reference/restart-and-records.md#restoring), [arrival marks](./reference/actions.md#arrival-marks).

### Load a screen's data when its route opens

**Situation.** A screen's data should load when the user opens the screen.

**Shape.** The route is main state, since a restore should bring back the screen the user was on. The action that changes the route writes the location through the route resource's method and starts the screen's load, through an action that reads the route from the draft when it runs. A route that arrives from outside, from the URL or from back and forward, reaches the tree through what already carries it there, a [resource](./reference/live-sources.md#choosing-a-resource), and the receiver case that writes it starts the load the same way.

After a restore every resource reopens ([resources after a restore](./reference/restart-and-records.md#resources-after-a-restore)). A route resource that delivers the current location when it opens, as it must for a deep link to load on a fresh boot, starts the load by itself. A boot that starts it as well, [as on opening](#load-data-when-the-app-opens), dispatches `refreshScreen`, never a load with an id it read from the restored state. The location can differ from the snapshot's, and that load, landing after the resource's, would replace the right one through `latest`; `refreshScreen` reads the route when it runs, so either order loads the board on screen.

```ts
declare module "treflex" {
    interface IResourceTypeRegistry {
        route: { Params: {}; Methods: { push(path: string): void } };
    }
    interface IResourceRegistry {
        "App/Route": { Type: "route" };
    }
}

interface IBoardsApp extends IEntity {
    Screen: "Boards" | "Board";
    BoardId: string | null;
    Board: IBoard;
}

const fetchBoardById = defineEffect<{ Type: "App/FetchBoardById"; BoardId: string }, IBoardInfo>("App/FetchBoardById");

export function* loadBoard(draft: IBoard, boardId: string): IActionGenerator {
    const info = yield* fetchBoardById({ BoardId: boardId });
    yield* assignBoard(draft, info);
}
latest(loadBoard);

export function* refreshScreen(draft: IBoardsApp): IActionGenerator {
    if (draft.Screen === "Board" && draft.BoardId !== null) {
        yield* start(loadBoard, draft.Board, draft.BoardId);
    }
}

export function* openBoard(draft: IBoardsApp, boardId: string): IActionGenerator {
    draft.Screen = "Board";
    draft.BoardId = boardId;
    yield* resource(draft, "App/Route").push(`/boards/${boardId}`);
    yield* refreshScreen(draft);
}
```

**Why.** A load the screen's component dispatches when it mounts runs again at each mount; the navigation is the event behind it. A route written to the tree alone leaves the location behind, so a reload returns to the old link and in-app navigation makes no history entry. The load is keyed on what it loads, so it is marked `latest`: a second open stops a load still running for the first. Rules: [where an action starts](./reference/views.md#where-an-action-starts), [arrival marks](./reference/actions.md#arrival-marks).

### One owner for each fact, and others derive it

**Situation.** A parent shows state its children own: a run shows how many of its questions wait for an answer, a session shows whether its import is building.

**Shape.** Keep the state on the entity whose work writes it, and give the parent a selector that reads its children. Don't keep a copy on the parent and keep it in step by message.

```ts
interface IQuestion extends IEntity {
    Text: string;
    Answer: string | null;
}

interface IRun extends IEntity {
    Questions: IQuestion[];
}

export function* awaitingCount(draft: IRun): ISelectorGenerator<number> {
    return draft.Questions.filter((question) => question.Answer === null).length;
}
```

**Why.** A copy has two writers and a message between them: it lags the child, a later write can land before an earlier message, and it goes stale when the child is removed or a restore drops the work that would have sent the message. A selector reads the one source, so it can't disagree with it. A message up to the parent is for something the parent decides ([below](#results-and-endings-go-up-as-messages)), not for mirroring the child.

### Results and endings go up as messages

**Situation.** A child's work produces something the parent owns, or the child is done and should leave.

**Shape.** The child publishes to the parent, and the parent checks the sender against the rows it holds.

```ts
interface IJob extends IEntity {
    Name: string;
}

interface IJobs extends IEntity {
    readonly $Receiver?: IReceiverId<IJobs>;
    Jobs: IJob[];
    Results: string[];
}

export function* runJob(draft: IJob): IActionGenerator {
    const result = yield* sendFile({ Name: draft.Name });
    yield* publishToNearest(draft, "Job/Done", { Result: result.Id });
}

export const JobsReceiver = receiver<IJobs>("JobsReceiver")({
    *"Job/Done"(draft, message, { publisher }) {
        if (!draft.Jobs.some((job) => job.$Id === publisher.Id)) return;
        draft.Results.push(message.Result);
        draft.Jobs = draft.Jobs.filter((job) => job.$Id !== publisher.Id);
    }
});
```

**Why.** A row can't remove itself: its draft is the row, not the list it sits in. The sender check is for a worker removed after it sent ([work entities](./reference/fibers.md#work-entities)). Results that live and die with the child, and form a collection of their own, can stay on the child and be joined in a selector; results that must outlive it, or take a place in one ordered list with rows the parent owns, belong to the parent. Each message is a decision the parent makes, so a topic per kind of result is normal. Guide [page 5](./guide/05-messages.md#publishtonearest-up-to-the-owner) has a feed leaving this way. Rule: [`publishToNearest`](./reference/messaging.md#publishtonearest).

### Rows going back to the server

**Situation.** Rows that are entities are sent back to the server, or loaded from a server that gives them no key.

**Shape.** Strip the framework's fields in one save serializer. Mint keyless rows at load, and replace them whole on a reload.

```ts
interface ILine extends IEntity {
    Text: string;
    Done: boolean;
}

interface IChecklist extends IEntity {
    Name: string;
    Lines: ILine[];
}

export function toServer(list: IChecklist): IWithoutIds<IChecklist> {
    return withoutIds(list);
}

export function* loadChecklist(draft: IChecklist, info: { Name: string; Lines: { Text: string; Done: boolean }[] }): IActionGenerator {
    draft.Name = info.Name;
    draft.Lines = yield* mapGen(info.Lines, (line) => entity<ILine>(line));
}
```

**Why.** `withoutIds` drops every `$Id` and `$Receiver`, which mean nothing to a server, and one serializer is one place to get it right. Rows with no key can't be matched, and a match by position keeps the nodes but swaps their data, so a save waiting on one row would land on another. Rules: [an `$Id` names one node](./reference/state-tree.md#an-id-names-one-node), [refreshing rows](./reference/write-path.md#refreshing-rows), [yields inside a callback](./reference/derived-reads.md#yields-inside-a-callback).

## Time and live things

### A fixed delay is a timer

**Situation.** Something should happen once, a while from now: a refresh five seconds after a save.

**Shape.** Start a timer, and stop it in its own tick case.

```ts
interface INote extends IEntity {
    readonly $Receiver?: IReceiverId<INote>;
    Text: string;
}

export const NoteReceiver = receiver<INote>("NoteReceiver")({
    *"Note/RefreshSoon"(draft) {
        yield* stopTimer(draft, "Note/RefreshSoon");
        yield* refreshNote(draft);
    }
});

export function* saved(draft: INote): IActionGenerator {
    yield* startTimer(draft, "Note/RefreshSoon", NoteReceiver, 5_000);
}
```

**Why.** An action that waits on a delay holds its entity, and keeps `inFlight` true, for the whole delay, and a restore drops it. A timer row holds nothing between ticks and is saved. Rule: [timers](./reference/live-sources.md#timers).

### Debounce with a timer whose payload changes

**Situation.** Typing should search once the person pauses, not on every key.

**Shape.** Each keystroke writes the text and starts the same timer with the text as its payload. The tick stops the timer and starts the search, which is marked `latest`.

```ts
declare module "treflex" {
    interface ITimerRegistry {
        "Picker/Pause": { Text: string };
    }
}

interface IPicker extends IEntity {
    readonly $Receiver?: IReceiverId<IPicker>;
    Text: string;
    Found: string[];
}

export const PickerReceiver = receiver<IPicker>("PickerReceiver")({
    *"Picker/Pause"(draft) {
        yield* stopTimer(draft, "Picker/Pause");
        yield* start(find, draft);
    }
});

export function* setText(draft: IPicker, text: string): IActionGenerator {
    draft.Text = text;
    yield* startTimer(draft, "Picker/Pause", PickerReceiver, 300, { Text: text });
}

export function* find(draft: IPicker) {
    draft.Found = yield* open(findItems({ Query: draft.Text }));
}
latest(find);
```

**Why.** Starting the timer again with a changed payload restarts its interval, so each new text pushes the tick back until the text has stood for the interval; with no payload, every start would equal the first and change nothing. `latest` stops a search still running when the next one starts, so an older answer never lands after a newer one. Rules: [timers](./reference/live-sources.md#timers), [arrival marks](./reference/actions.md#arrival-marks).

### Timed rows live on an entity that never waits

**Situation.** Rows that must change on time, such as toasts that fade, belong to something that also runs long work.

**Shape.** Keep them on an entity of their own, which no long action holds: a toast list at the root rather than a field of the document.

**Why.** A tick queues behind its owner's hold like any work, so a toast on a document fades only once the document's held requests end. Rules: [timers](./reference/live-sources.md#timers), [holds](./reference/actions.md#holds).

### Cleanup that must survive a stop belongs to a resource

**Situation.** Something must be undone whatever ends the work, a stop included: a lock on the server, a server-side session.

**Shape.** Make it a resource whose type undoes it when the instance retires, opened on the row the work belongs to. The resource lasts as long as its owner: close it with `closeResource` where the work ends, or let the row's removal close it.

```ts
export function registerLocks(runtime: IRuntime<object>): void {
    runtime.registerResourceType("lock", (params, r) => {
        void fetch(`/locks/${params.DocId}`, { method: "POST" });
        r.signal.addEventListener("abort", () => {
            void fetch(`/locks/${params.DocId}`, { method: "DELETE", keepalive: true });
        });
    });
}

export function* startEditing(draft: IDocument): IActionGenerator {
    yield* openResource(draft, "Doc/Lock", { Type: "lock", DocId: draft.DocId });
}

export function* stopEditing(draft: IDocument): IActionGenerator {
    yield* closeResource(draft, "Doc/Lock");
}
```

**Why.** A stopped action runs its `finally` blocks but can't yield there, so cleanup that needs an effect can't run in one. A resource's `r.signal` aborts when it is closed or its owner leaves, however that happens; the action that opened it ending changes nothing. Cleanup that only has to run after success or failure, not a stop, can be a helper that catches, cleans up and rethrows. Rules: [the close](./reference/fibers.md#the-close), [closing](./reference/live-sources.md#closing).

### A child calls its parent's resource

**Situation.** Rows need a live thing their parent owns: a worker that renders each row's chart.

**Shape.** Keep the owner's `$Id` on the row when it is minted, and call the resource by it.

```ts
interface IChartRow extends IEntity {
    OwnerId: string;
    Points: number[];
    Svg: string;
}

export function* draw(draft: IChartRow): IActionGenerator {
    const svg = yield* resource(draft.OwnerId, "Chart/Worker").render(draft.Points);
    if (svg !== undefined) draft.Svg = svg;
}
```

**Why.** One resource serves every row. The call doesn't wait for the parent's hold, and removing the row cancels its call. Rule: [methods](./reference/live-sources.md#methods).

### Facts are messages, connection state is status

**Situation.** A resource learns things about the outside world, such as a process exiting, and has a connection that drops and comes back.

**Shape.** Emit the facts, and let the receiver write them into state. Report the connection through `r.status`, which a view reads with `useResource`. Guide [page 7](./guide/07-live-sources.md#a-resource)'s push stream has both.

**Why.** Status is for display. What the app decides on lands in state through a message, where it is recorded and survives a restore. Rules: [status](./reference/live-sources.md#status), [emit](./reference/live-sources.md#emit).

## Failures

### Catch only what you expect

**Situation.** An action handles some failures itself, such as a request the server refused.

**Shape.** The effect implementation answers a request failure with data, a failed `fetch` included. A `yield*` helper beside the effect throws an application error class from that answer, and the action catches that class and rethrows everything else, as guide [page 6](./guide/06-failures.md#its-own-failures) does.

**Why.** A failed `fetch` rejects with a `TypeError`, the class a coding error throws, so a `catch` that takes everything shows bugs as outages and keeps them off the failure route. Rules: [when an action throws](./reference/failure.md#when-an-action-throws), [a rejection crosses as a copy](./reference/effects.md#a-rejection-crosses-as-a-copy), [a failure the app handles](./reference/effects.md#a-failure-the-app-handles), [refusals](./reference/failure.md#refusals).

## Reads

### Work tags for a veil, and bare receiver cases

**Situation.** A view shows a veil while any of an entity's work runs, and that work grows over time.

**Shape.** Tag each action, read the tag, and give receiver cases as the action itself.

```ts
export const WindowWork = workTag("Window/Work");

interface IWindow extends IEntity {
    readonly $Receiver?: IReceiverId<IWindow>;
    Title: string;
}

export function* loadWindow(draft: IWindow): IActionGenerator {
    draft.Title = (yield* fetchTitle({ Id: draft.$Id })).Title;
}
WindowWork.mark(loadWindow);

export const WindowReceiver = receiver<IWindow>("WindowReceiver")({
    "Window/Reload": loadWindow
});
```

The window's view reads the veil with `useInFlight(WindowWork, () => window.state)`.

**Why.** A list of actions passed to `inFlight` misses one nobody added to it; a tag puts the membership on each action, beside its declaration. A case given bare counts as that action and its tags, while a case that calls the action with `yield*` counts only as itself. Mark in the module that defines the action, since a tag counts only work that arrives after the mark. Rule: [work tags](./reference/actions.md#work-tags).

### Per-row view state lives on the owner

**Situation.** A row's view state, such as whether it is expanded, must survive its component unmounting: the row scrolls out of a virtualized list, or the selection changes.

**Shape.** Keep it in a transient on the owner, keyed by row id, written by a small action and read through a selector.

```ts
interface ITree extends IEntity {
    Nodes: { $Id: string; Label: string }[];
}

const openRows = (draft: ITree) => transient(draft, "Tree/Open", { Ids: [] as string[] });

export function* toggleRow(draft: ITree, rowId: string): IActionGenerator {
    const open = yield* openRows(draft);
    open.Ids = open.Ids.includes(rowId) ? open.Ids.filter((id) => id !== rowId) : [...open.Ids, rowId];
}

function* openIds(draft: ITree): ISelectorGenerator<readonly string[]> {
    return [...(yield* openRows(draft)).Ids];
}
```

**Why.** Component state ends with its component, and the owner outlives its rows' components. A transient isn't saved; make it a field on the entity only if it must survive a reload. Rules: [`useComponentState`](./reference/views.md#usecomponentstate), [transients](./reference/state-tree.md#transients).
