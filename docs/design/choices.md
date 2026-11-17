# Implementation choices

How treflex is built to its [principles](./principles.md), each choice with its reason and where its rules live.

## Actions are generators

An action is a generator, so the runtime sees every yield and decides what it means. That lets it stop an action by closing the generator, record every step, and define what a held reference does at every yield ([held references](../reference/actions.md#held-references)). Steps run whole and interleave only at yields, so a snapshot never pauses the app ([steps](../reference/actions.md#steps)). A stop never throws into the action: `finally` runs, so cleanup happens, and `catch` doesn't, since a stop is not an error the action can answer ([stopping](../reference/fibers.md#stopping)). Cleanup that must happen on a stop belongs to whoever survives it ([cleanup belongs to the survivors](../reference/fibers.md#cleanup-belongs-to-the-survivors)).

## The creator mints the `$Id`

Every new `$Id` an action writes comes from `entity()`, through the runtime's `generateGuid` effect, so a test can stub ids and a record tap sees each mint ([making an entity](../reference/state-tree.md#making-an-entity)). The parent mints a child's `$Id` before the child lands, so the address exists before anything registers against it, the entity lands complete, and the parent can start the child's setup on it.

## Reads are not effects

A read answers from what the runtime holds; an effect brings in what it doesn't. So a read needs no implementation and no record and can feed a memo, while an effect has an implementation, a record and a stub ([derived reads](../reference/derived-reads.md)). Selectors are synchronous because a render reads a value, and take no parameters because there is one memo per entity and selector ([selectors take no parameters](../reference/derived-reads.md#selectors-take-no-parameters)).

## Recurring work is a timer row

An action is a finite transition. Recurring work is a timer row, a message the clock sends the entity, which is saved and re-armed on restore, rather than a generator looping on a delay for the entity's whole life ([timers](../reference/live-sources.md#timers)). Something live outside the tree is a resource: its row is saved, and its instance is rebuilt from the row ([resources](../reference/live-sources.md#resources)).

## No middleware

Nothing sits between a yield and its implementation. A policy such as caching or retries is a field of the descriptor, set at the call, where the source shows it ([when to add an effect](../reference/effects.md#when-to-add-an-effect)).

## Failure climbs to the nearest owner

A failure goes to the first thing that takes it: a `catch`, then the nearest error boundary above the failing entity, then `onError` ([the route](../reference/failure.md#the-route)). The owner that placed the work decides what its failure means, as a supervisor does in the actor model.

## Why Solid

treflex uses Solid for reading. Solid's reactivity is read-granular and independent of rendering, so a selector or a `getData` read can be a memo invalidated by exactly what it read. The tree is treflex's own, written through its draft and read through its views, so a node keeps its identity for its lifetime.

## Lineage

**The actor model** (Erlang, Akka): an entity is an actor, the tree is the supervision hierarchy, a receiver is an actor's behaviour, `publishToNearest` tells the nearest supervisor, removal ends the children, and `Action/Error` is escalation.

**Algebraic effects** (Koka, OCaml 5, Effect-TS): a generator yields a description of an effect, answered outside the code that yields it. treflex takes the descriptions and the runtime-owned continuation, and leaves out scoped handlers: an effect goes from its yield to its implementation.
