# The eslint plugin

The plugin's rules are [`treflex/no-discarded-generator`](#treflexno-discarded-generator),
[`treflex/no-yield-in-finally`](#treflexno-yield-in-finally),
[`treflex/no-edit-after-write`](#treflexno-edit-after-write),
[`treflex/no-hidden-open`](#treflexno-hidden-open),
[`treflex/no-returned-promise`](#treflexno-returned-promise),
`treflex/no-global-open`, [`treflex/named`](#treflexnamed) and
[`treflex/require-name`](#treflexrequire-name), after the setup below. Its
command, [`treflex-eslint name`](#treflex-eslint-name), names a project's actions.

## Registering it

```
npm install --save-dev treflex-eslint eslint typescript@^6 typescript-eslint
```

```js
// eslint.config.js
import treflex from "treflex-eslint";
import tseslint from "typescript-eslint";

export default [
	tseslint.configs.base,
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		}
	},
	treflex.configs.recommended
];
```

`treflex-eslint` is an ES module with no CommonJS entry, so the config is one
too: the project's `package.json` has `"type": "module"`, or the file is named
`eslint.config.mjs`.

`treflex.configs.recommended` covers `.ts` and `.tsx`. It registers the plugin,
sets every rule on this page but `treflex/require-name` to `error`, and turns eslint's `require-yield` off, because
selectors and receivers are generators by contract and one with no `yield` is
correct. Nothing about a file says it holds one, so the rule is off for every
file the config covers rather than per file. A preset that turns `require-yield`
on, such as `js.configs.recommended`, goes ahead of it. To change a rule's
level, add an object of your own after it
with the same `files`, because the plugin is only registered for those, and
without them linting a `.js` file crashes.

One dependency carries the rules' runtime: `@typescript-eslint/utils` at `^8.58.0`. That floor
is the typescript one. 8.58.0 is where the package widened its own typescript
peer from `<6.0.0` to `<6.1.0`, so anything below refuses to resolve against
typescript 6. Its eslint 10 support arrived earlier, at 8.56.0.

- **typescript 5.4 through 6.0**, a peer dependency, which the rules import
  for the compiler API. 5.4 is the release treflex's own declarations need,
  and the rules run there. The ceiling is typescript-eslint's, which peers
  `<6.1.0`, so typescript 7 can't run the rules. An unpinned
  `npm install typescript` reaches for 7, hence `typescript@^6` above.
  `treflex` itself declares no typescript peer, so it installs in a
  typescript 7 project.
- **eslint 9 or later**, a peer dependency, for the flat config the plugin's
  `configs.recommended` is written in.

A rule that needs type information gets it from `projectService` above.
Without it `ESLintUtils.getParserServices` throws saying so, rather than
passing everything silently. Use `projectService`, not the older `project`
option: on typescript 6, `project` can crash typescript-eslint when one run
parses a file twice, as `eslint --fix-dry-run` does, or under `CI=true`.

## `treflex/no-discarded-generator`

```js
"treflex/no-discarded-generator": "error"
```

Reports a call that creates a generator and drops it. A generator's body runs
only when something iterates it, so an effect called without `yield*` compiles,
dispatches nothing and reports nothing. The fix is to call it with `yield*`.

```ts
const sendChunk = defineEffect<IChunk, void>("app/chunk");

function* stream(draft: IDoc): IActionGenerator {
    yield* sendChunk({ Text: draft.Next });   // fine
    sendChunk({ Text: draft.Next });          // reported
}
```

The rule needs type information and no list of names. It reports a call typed
as the standard library's `Generator`, directly, through an alias such as
`IActionGenerator`, or through an interface that extends it, so it covers an
app's own effect creators from `defineEffect`, treflex's operations and reads,
and helper generators alike. A call typed `AsyncGenerator` is reported too, with
a message to iterate it with `for await`. The rule checks every function in the
files it covers, actions or not: a generator dropped anywhere runs nothing.

A call is dropped when it is:

- a statement of its own, alone or under `void`, `await`, `as` or `!`;
- in such a statement, the right side of `&&`, `||` or `??`, either branch of
  `?:`, or any element of a comma list;
- the initial value of a `const`, `let` or `var` that is never read and not
  exported.

A generator passed as an argument, as in `parallel(save(d), load(d))` or
`open(fetchIt())`, returned, iterated or read later is not reported. Not seen
either:

- A call typed `any`, or typed as a union that holds anything besides
  generators, `null` and `undefined`.
- An iterator whose type isn't a generator's, such as `IterableIterator`. A
  generator function annotated as returning `IterableIterator` is missed.
- A generator returned into a callback slot that drops it,
  `rows.forEach((r) => save(r))`.
- A generator assigned to an existing variable, `g = save(d);`, that is never
  read afterwards.
- A bare `yield` of a call, `yield save(d)`, which hands the runtime the
  generator unrun. In a function typed `IActionGenerator` it doesn't compile.

A MobX `flow` method runs as soon as it is called, but it is typed as a
generator, so call it through MobX's `flowResult(...)`, which the rule doesn't
report.

Inside a generator function, an editor offers the `yield*` as a suggestion.
It isn't an autofix, because running the effect changes what the code does.
There is no suggestion where `yield*` would be wrong: outside a generator, in a
class's static block, in a `finally`, where
[`treflex/no-yield-in-finally`](#treflexno-yield-in-finally) would report it,
for a call typed with `undefined` in it, where `yield*` throws on the value the
dropped call ignored, for an async generator in a function that isn't one, and
for a variable's initial value.

## `treflex/no-yield-in-finally`

```js
"treflex/no-yield-in-finally": "error"
```

Reports a `yield` or `yield*` in a `finally` block. A stopped action's
`finally` blocks run in a close that dispatches nothing
([the close](../../docs/reference/fibers.md#the-close)), so at runtime the yield
reports as `cancel/finally-yield`. The fix is to keep the `finally`
synchronous and move cleanup that needs an effect to a survivor
([cleanup belongs to the survivors](../../docs/reference/fibers.md#cleanup-belongs-to-the-survivors)).

```ts
try {
    yield* save(draft);
} finally {
    draft.Saving = false;             // fine
    yield* notify("done");            // reported
}
```

The rule needs no type information. It reports a yield whose own function is
the generator holding the `finally`, so a function defined inside the block is
checked on its own: a generator there is reported only for a `finally` of its
own. A `catch` is not checked.

`yield* transient(...)` is not reported, because a transient is given without
yielding during a close. The rule recognises `transient` by name, through an
import of any source under any alias, or as an unresolved global, so a helper
that wraps it is reported. `open(...)` is reported like any other call. The rule checks every generator in the files
it covers, actions or not.

## `treflex/no-edit-after-write`

```js
"treflex/no-edit-after-write": "error"
```

Reports an edit of a local after that local was written into the draft in the
same action. [A written object is frozen](../../docs/reference/write-path.md#copy-and-freeze),
so the edit compiles and then throws a `TypeError` if it runs. The fix is to set
the value before the write, or to change it through the draft.

```ts
const row = { a: 1 };
d.Rows.push(row);
row.b = 2; // reported
```

A write is an assignment to something rooted at the draft, an item passed to
`push`, `unshift` or `splice` on it, or a source passed to `Object.assign` with
a target rooted at it. The root can be the draft or a local holding a node of
it, reached by navigating or through `find`, `findLast` or `at`. `Object.assign` freezes what the source's properties hold
and leaves the source open, so after one only `row.a.b = 2` is reported, not
`row.b = 2`.

An edit is an assignment to a property at any depth, `delete`, `++` or `--`, or
`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill` or
`copyWithin` on the local or on anything under it.

An action, to this rule, is a generator whose **first parameter is structurally
an entity draft**: its type has a `$Id` that is string-like. A generator taking
`Id` instead, or taking the draft second, is not analysed at all. Reading that
type is why the rule needs type information.

The rule walks one function body in source order and follows nothing out of it.
The runtime error covers the rest. Any reassignment, even one in a branch,
forgets the local's earlier writes. Not seen:

- A parameter, a destructured binding or a loop binding, any of which may be a
  live node, or a part or an alias of one.
- A write through a loop binding,
  `for (const r of d.Rows) { const x = {}; r.Child = x; x.b = 2; }`.
- A local whose value came from a call handed the draft, since a helper may
  return a node, such as `structuredClone(d.X)`, or from a method on it, such as
  `d.Rows.map(...)`.
- A value written inside something else, `d.X = { row }`, `d.X = c ? a : b` or
  `d.Rows.push(...rows)`, or written with `fill` or `??=`.
- A second name for the value, `const b = row`, or a part of it,
  `const c = row.a`.
- A write or an edit inside a nested function, an inline generator included.
- A write on a loop's earlier iteration, where the edit sits above it.

A write in one arm of an `if`, a ternary or a `switch` does not report an edit in
another. Neither does a write inside a `return` or `throw`, or in a block that
ends by leaving, with `return`, `throw`, or a `break` or `continue` that also
leaves the edit behind. Correct code it still reports includes:

- A node from a helper that closes over the draft,
  `const get = () => d.Rows[0]; const n = get();`, or that is handed it inside a
  literal, `const n = lookup({ d });`.
- An element of a copy made with a spread, `const n = [...d.Rows][0];`.
- A live node reached through a wrapper,
  `const w = { n: d.Rows[0] }; d.X = w; w.n.x = 1;`, since a node inside a wrapper
  is not frozen.
- Arms tied together by a repeated condition,
  `if (c) d.X = row; if (!c) row.b = 2;`.
- An edit in the `catch` of a `try` whose write was refused, which leaves the
  value unfrozen.
- A write in a block that ends in an `if` whose arms both return,
  `if (a) { d.X = row; if (b) { return; } else { return; } } row.b = 2;`.

## `treflex/no-hidden-open`

```js
"treflex/no-hidden-open": "error"
```

A function that opens is open, and so is every function that calls it, and a
normal action, typed `IActionGenerator`, can't call one
([open](../../docs/reference/actions.md#letting-other-work-in-open)). The
compiler sees that through the yield type, and this rule covers the places a
type of `any` hides it. An open function calling another open function with a
plain `yield*` is the ordinary call, and isn't reported.

**A normal action calling something whose type can't say** (`unknownCall`).
In a generator typed `IActionGenerator`, a call to a helper typed `any` gets
past the compiler whether it opens or not:

```ts
declare const helper: any;

function* save(draft: IDoc): IActionGenerator {
    yield* helper(draft);            // reported
}
```

The fix is to give the call a type that says whether it opens. A selector,
typed `ISelectorGenerator`, isn't checked, since it yields no effects. A normal
action can still call a helper typed `Generator<any, …>` unreported, since its
yield type says nothing.

**A function whose yield type is `any`** (`anyCaller`). In a function whose
yield type is `any`, an `open(...)` marks nothing, and nor does a call to a
function that opens, so a normal action can call it. The rule reports either
in such a function:

```ts
declare const legacy: any;

function* load(doc: IDoc) {
    yield* open(fetchPreview(doc));  // reported: legacy makes load yield any
    yield* legacy(doc);
}
```

The fix is to give the function a yield type that carries the marker: type the
helper, or drop an `any` annotation.

The rule needs type information. It reads the types by name, `IOpenMark`,
`IActionYield` and `ISelectorGenerator`, and tells a call that opens by its
yield type. It also recognises `open` by name, through an import under any
alias or as an unresolved global, so an `open(...)` whose own type is `any` is
reported too.

## `treflex/named`

```js
"treflex/named": "error"
```

Reports a `named(action, name)` whose name is not a string literal, such as
`named(save, save.name)`, since a computed name changes when a bundler renames
the function, and a name a second `named` call in the same file has already
used ([durable names](../../docs/reference/actions.md#durable-names)). A
duplicate across files throws at the second module's load in development.

It also reports a `named` call that isn't a statement of its own at the top
level of its module: one inside a function or a block, or one whose result is
used, as in `const save = named(function* save() {...}, "Doc/Save")`. A mark
goes in the module that defines the action, as a statement after the
declaration, and an action a factory makes on each call can't be named.

The rule needs no type information. It recognises `named` by name, through an
import of any source under any alias, read off a namespace import such as
`T.named`, or as an unresolved global.

## `treflex/require-name`

```js
"treflex/require-name": "error"
```

Not in `configs.recommended`, since an app that never saves has no need of
names: an app that saves, and sets `requireNames`
([requireNames](../../docs/reference/runtime.md#requirenames)), turns it on
after the recommended config, with the same `files`.

Reports an action with no durable name where it is passed to `start`,
`dispatch` (a call named `dispatch`, or a method of that name), `leading`,
`latest`, a work tag's `mark`, or a feature's actions object,
`createEntityFeature(...)(actions)` or `createComponentFeature(...)(actions)`.
`start`, `leading`, `latest` and the two feature factories are recognised by
name: imported from any source under any alias, read off a namespace import
such as `T.leading`, or as a global that is unresolved or only declared, by
`declare`, `declare global` or a `.d.ts`; a global with a body is the app's own
function. A work tag's `mark` is
recognised by its object's type, `IWorkTag`. An actions object built in another module and passed by reference,
`createEntityFeature("Planner")(PlannerFeature.actions)`, has each of its
properties checked. An action is a function the type checker resolves to a
generator declaration, or a variable initialised with a generator function,
and it is named when its own module has a `named` call for it. An inline
generator function passed directly is reported too.

```ts
export function* increment(draft: ICounter): IActionGenerator {
    draft.Count++;
}
leading(increment);   // reported, until named(increment, "...") is in this module
```

**It fixes what it reports** in the module that declares the action, at top
level, with the file's own line break.

- **The mark,** `named(action, "<Prefix>/<Name>")`, goes on a new line at the
  end of the declaration's last line when only comments that close on that line
  follow the declaration there, and otherwise on a new line straight after the
  declaration. Either way it comes ahead of any `leading` or `latest` mark that
  follows, and an overloaded generator's goes after its implementation.
- **The import:** the fix adds `named` to the module's `treflex` import, uses
  `T.named` through a namespace import of `treflex`, or adds
  `import { named } from "treflex";` on a line of its own where Biome's
  `organizeImports` keeps it: after the module's last `treflex` import, a
  type-only one included, and otherwise ahead of its first relative import or
  import of a package that sorts after `treflex`, or else after its last
  import. A module with no imports at all gets no fix, and neither does one
  that already has another binding called `named`.

- **The prefix** is the last segment of the id of a `createEntityFeature("...")`
  or `createComponentFeature("...")` call in the module, `"TodoList"` for
  `"Features/TodoList"`, and otherwise the module's folder name in PascalCase,
  `"TodoList"` for `todo-list/`.
- **The name** is the function's own name in PascalCase, so `increment` in a
  `Counter` feature becomes `"Counter/Increment"`.
- **No fix** is offered for an action declared in another module, which
  [`treflex-eslint name`](#treflex-eslint-name) names, a variable
  with a type annotation (`const save: IAction<IDoc> = function* ...`), an inline
  or anonymous function, a declaration inside another function, whose every call
  would make a new function claiming the one name, a module whose feature id
  or folder name gives no prefix, such as an id ending in `/`, or a name
  another `named` call in the module already has or the fix already gave
  another action, as `saveDraft` and `save_draft` would both become
  `SaveDraft`. Nothing in a module is fixed while one of its `named` calls
  can't be read, as [`treflex-eslint name`](#treflex-eslint-name) defines it.

The fix chooses a name once. Changing it afterwards is like renaming a saved
field: records and saves made before the change name the old one.

Not seen: an action reached through a conditional, an array, a variable typed
`IAction` with no generator behind it, or an argument the type checker can't
follow. The rule doesn't know which entity an action runs on, so it also
reports an action dispatched only on component state, which the runtime would
exempt. It needs type information.

## `treflex-eslint name`

```
npx treflex-eslint name [--check] [-p <tsconfig.json or its folder>]
```

Names every action `treflex/require-name` reports in a project, including one
declared in another module than the one that uses it. It writes the mark and
the import the rule's fix would, in the module that declares the action, and
takes the prefix from that module too, so a module's actions share one prefix
whichever of them a feature in another module lists. The project is what its
`tsconfig.json` includes, in the current folder unless `-p` names another, and
every project its `references` reach, run as one: a solution-style
`tsconfig.json` with no files of its own, as Vite's is, stands for the projects
it references. The command prints each name it gave as `file: Feature/Action`,
the file relative to the project, and a second run changes nothing. An added
`import { named } from "treflex"` sits beside the module's `treflex` import, or
before its relative imports; in a module that uses path aliases (`@/`, `#`,
`~`) and has no `treflex` import, the formatter's import sort may need to run
after the command.

It leaves an action alone, and lists it with the reason, where the fix would
refuse it for a reason other than its being declared in another module: a
type annotation, an anonymous function, a method written inside an actions
object, a declaration below the top level, no prefix, a taken name, a module
with no imports or another binding called `named`. It does the same for an
action declared outside the project, such as in `node_modules`, and for one a
`named` call in another module names, since its mark belongs in the module
that declares it. A name is taken when a `named` call has it in any source
file the project compiles but a declaration file, installed packages and files
imported from outside the project included, or when the run has already given
it to another action.

A `named` call it can't read blocks the run: one whose action doesn't resolve
to a function declaration, or whose name isn't a known string, such as a
template string with a part computed at run time; a string constant, an
`as const` or a template string of constants is known. The command lists each
such call, writes nothing and exits 1, since any name could then clash. It
sees `named` itself, imported or read off a namespace import, and not a mark
made through the app's own wrapper around it.

It exits 1 when it leaves an action unnamed, which the rule still reports and
the runtime still refuses, or can't write a file, which it lists with the
reason, and 2 on bad arguments or when it can't read the project. `--check`
lists what it would name, writes nothing, and exits 1 when any action is
unnamed, for CI.

## `treflex/no-returned-promise`

```js
"treflex/no-returned-promise": "error"
```

Reports a `return` in a generator function whose value is a promise or a
thenable. [An action returns plain data](../../docs/reference/actions.md#a-dispatchs-result):
one that returns a promise, a `parallel` or `parallelSettled` branch included,
fails with `NonPlainDataError`, and only once it has run to its end. The fix is
to declare the async work as an effect and `yield*` it.

```ts
const save = defineEffect<ISave, string>("app/save");

function* store(draft: IDoc) {
    return api.save(draft.Text);                  // reported
}

function* storeThroughAnEffect(draft: IDoc) {
    return yield* save({ Text: draft.Text });     // fine
}
```

The rule needs type information. A value is a thenable when its type has a
callable `then`. A union is reported when any of its members is a promise or a
thenable, so `Promise<T> | T` is reported, and a type parameter is judged by its
constraint. The rule checks every generator in the files it covers, actions or
not, since a helper's promise reaches the action that called it as a value. A
`return` in a function nested inside the generator belongs to that function and
isn't checked.

An async generator isn't checked, because the language awaits a promise it
returns. Not seen:

- A value typed `any` or `unknown`. The runtime still refuses one that an
  action or a branch returns.
- A promise inside the returned value, `return { saved: api.save(x) }`.
