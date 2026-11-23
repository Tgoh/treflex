# Checkout

A checkout written as one action, and what a reload does to it.

```bash
npm run demo:checkout    # from the repo root
```

## A flow as code

`checkout` in [`src/shop/shop.ts`](./src/shop/shop.ts) is one generator that runs from the first question to the payment, in straight-line code. It asks for an address, has the server quote delivery for it, asks which delivery to take, makes a payment key, reserves the stock, asks the person to confirm the total, and pays. The answers live in its local variables, and nothing in state says how far it has got: the view shows the page of whichever question is open, found by its `Path` through `pendingAsks`, or a busy line while the flow waits on the server.

Other work runs on the order while a question is open: a quantity changes, a voucher is checked. The confirmation re-reads the total when it is answered and asks again if it changed. Reserving the stock, paying and checking a voucher hold the order, so other work on it, a quantity change included, waits until they end; a quantity change that waited behind the payment finds the order paid and does nothing.

## What a reload does

The page saves its session a moment after each change and as it is hidden, and restores it at boot ([`src/session.ts`](./src/session.ts)), with [resume](../../docs/reference/restart-and-records.md#resume) on. A restore gives back the state, and `checkout` is marked `resumable`, so a flow caught at a question, at the delivery quote or at the stock reservation comes back where it was, with its answers: the question is asked again, and the quote or the reservation is sent again, since both are declared `idempotent`.

The rest drops, and the restore reports it:

- a flow caught at the payment, which isn't safe to send twice;
- the work that isn't marked: a voucher check, the suggestions, a quantity change and a read of the server, which boot does again;
- a flow queued behind work that dropped, or waiting to get its hold back after a question.

A save resumes only into the build that wrote it. On the dev server the build id changes with every edit, so a reload after an edit drops everything.

The repair in [`src/shop/repair.ts`](./src/shop/repair.ts) reads what was dropped:

- **A dropped checkout with a payment key and no receipt** may have paid. The repair asks the server what became of the key: a charge gives the receipt, and no charge releases the stock and clears the key before the flow starts again. A reload during that check drops the check, and the next repair does it again.
- **Any other dropped checkout** starts again at the first question, and the order's notice says the page reloaded.
- **Dropped suggestions** are fetched again, from the basket in state.
- **A dropped voucher check** can't be redone, since its code was an argument and a dropped action carries none, so on an order not yet paid the notice asks for it again.
- **A dropped quantity change** can't be redone either, for the same reason, and the notice asks for it the same way.

The flow can carry on and pay after the repair. Once the order has a receipt, the view leaves out the notes asking for a voucher or a quantity change again.

The fake server ([`src/server/fakeServer.ts`](./src/server/fakeServer.ts)) stands for a real one. It keeps its charges and orders in the browser's storage under its own key, apart from the session, so it outlives a reload, and answers each request after a short delay. It takes a request when it arrives, so a payment cut short by a reload has still been charged. It doesn't dedupe payments: each one it receives is a charge. `readServer` reads what it holds about the order into the order, its status, reserved lines and charges, and the panel on the right shows them. It lines up behind the flow's hold on the order, so a charge the server takes during the payment shows in the panel only once the flow lets go of the order.

**Start over** clears the session and the server.

## The tests

```bash
npm --prefix demos/checkout test
```

[`src/shop/restorePoints.test.ts`](./src/shop/restorePoints.test.ts) runs scripts of the flow through `differentialRestore` with `compareDataOnly`, reloads at every point where work is in flight, once with resume and once without, and pins two tables per script: what was running at the point, and how each reloaded run ends against the run that wasn't interrupted, its receipt, the charges at the server, what is left unfinished and the notice. It checks that the run with resume is never worse than the one without. Each run gets its own fake server, which outlives that run's reload, and the tables read each run's server directly. Each script still ends by reading the server into the order, so the comparison of the two reloaded runs sees a payment made twice as a difference.
