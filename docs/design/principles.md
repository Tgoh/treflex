# Design principles

The seven principles treflex is built on, each with its reason and where its rules live. The [reference](../README.md#reference) states every rule, and every rule means the same with a record tap or without, and in every build; a development build adds checks ([troubleshooting](../reference/troubleshooting.md)). How treflex is built to these principles is in [implementation choices](./choices.md).

## The state tree is the application's structure

The application's structure is the state tree, not the component tree, so the app keeps running with the renderer off: its work, its coordination and its timers. Views read state and dispatch actions ([views](../reference/views.md)), and state only a view needs lives in [component state](../reference/state-tree.md#component-state).

## An entity is the unit

A node with an `$Id` is what dispatch, messages, timers, resources and lookup address ([entities](../reference/state-tree.md#entities)). It lives until it's removed from the tree, and removal ends its work ([removal](../reference/state-tree.md#removal-ends-everything-attached)). Lookup, `publishToNearest` and failures walk up from it to the nearest container that handles them, such as the window a feature closes, the toast host or the nearest error boundary ([lookup](../reference/lookup.md), [`publishToNearest`](../reference/messaging.md#publishtonearest), [the failure route](../reference/failure.md#the-route)); a `publish` reaches whoever is bound to hear it. Where one entity's jobs need different granularity, the work splits across entities ([one entity or two](../patterns.md#one-entity-or-two)).

## State is plain data with one owner

State is plain data, and each node has one parent, which decides what its removal ends. Anything else that refers to a node holds its `$Id` ([the tree rule](../reference/state-tree.md#the-tree-rule)), everything but its own entity's draft and transients reaches an action as a copy ([what crosses into an action](../reference/write-path.md#what-crosses-into-an-action)), and so the tree saves as one envelope ([restart and records](../reference/restart-and-records.md)).

## An action holds its entity

An action holds its entity from start to end, so what it read there stays as it read it across a wait, with no re-check ([the reading rule](../reference/actions.md#holds)). Letting other work in during a wait is explicit, with [`open(...)`](../reference/actions.md#letting-other-work-in-open) at that one call; a repeat queues behind the hold, and [`leading`](../reference/actions.md#arrival-marks) drops it.

## Authority flows down

An action changes its own entity and what's below it, never above: its draft reaches its entity's subtree and nothing more. A parent may write into a child; a write into a child another action holds can change what that action read, so development reports it ([writing into a child entity](../reference/actions.md#writing-into-a-child-entity)).

## Inputs arrive as answers

An action given the same answers to its yields runs the same way. So ids, the clock and randomness reach an action as answers to yields, never from a call it makes itself, and reads are yields for the same reason ([non-determinism](../reference/effects.md#non-determinism)). An [outside value](../reference/derived-reads.md#outside-values) is one of those answers: it comes from outside the action as an effect's settlement does, so the action's `step` record carries the value it read, or only the key for a provider that redacts.

## Running work isn't state

What a restart brings back is the tree, and running work doesn't come back, so a flag in the tree saying work is running would come back set, with nothing to clear it. Data about running work is a [transient](../reference/state-tree.md#transients), never saved, and whether work runs is [`inFlight`](../reference/actions.md#inflight).
