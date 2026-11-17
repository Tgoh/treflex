# The eslint plugin

The plugin's rules are [`treflex/no-discarded-generator`](#treflexno-discarded-generator),
[`treflex/no-yield-in-finally`](#treflexno-yield-in-finally),
[`treflex/no-edit-after-write`](#treflexno-edit-after-write),
[`treflex/no-hidden-open`](#treflexno-hidden-open) and
`treflex/no-global-open`, after the setup below.

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
sets every rule on this page to `error`, and turns eslint's `require-yield` off, because
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
