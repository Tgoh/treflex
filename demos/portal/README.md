# The demo portal

A set of apps that keep running while their view is unmounted, and come back after a reload.

- **Trip planner.** An agent searches flights, hotels and activities side by side, asks you to pick a flight while the other searches carry on, and holds the fare you pick for 15 minutes. Reload mid-run: the trips, quotes and hold come back, the searches that were running carry on from the provider each had reached, and an open flight question is asked again. The hold counts real time, so a hold that ran out while the page was closed comes back expired.
- **Aquarium.** Schools of fish, each fish an entity swimming on its own timer. Release a school and every fish in it goes with it. Leave and come back, or reload, and a fish that was mid-swim carries on from where it had got to.
- **Team chat.** Channels and direct messages with simulated teammates, whose messages stream in letter by letter. Reload while one is streaming and it carries on from the letter it reached; a message that was sending comes back as Didn't send, with Retry. Marcus sends a travel voucher: apply it from his message, or from its notice, and every trip, current and future, takes 10% off.

When an app's work finishes while its view isn't on screen, a notice says so over whichever app is open.

The guided tour across the top walks through it. The session card in the sidebar, a drawer behind the menu button on a phone or in a narrow window, saves to this browser, reloads and resets. The record stream toggle opens a live tail of what the runtime records.

## Running it

```bash
npm install          # at the repo root
npm run demo:portal         # the Solid build, on port 5173
npm run demo:react-portal   # the React build, on port 5174
npm run demo:portal-swap    # the swap build, on port 5175
npm --prefix demos/portal test
npm --prefix demos/react-portal test
npm --prefix demos/portal-swap test
```

On a dev server, `?fast` in the address, as in `http://localhost:5173/?fast`, runs the scripted chat and the fake backend's delays at a seventh of their length, so Marcus's voucher arrives a few seconds in, with the same cues in the same order ([`backend/fast.ts`](./src/backend/fast.ts)). It is read when the page loads, and a saved session keeps the cue interval it started with, so press Reset to switch. Production builds ignore it.

The portal's tests are headless: they run the apps on a runtime with no view. The React build's tests render its views in jsdom, and check that it loads one copy of treflex. The swap build's tests swap renderers in jsdom while a trip search runs, and check that it loads one copy of treflex and of each renderer.

In the Solid and React builds, the session card's Solid / React switch is a link to the other build, at the address in `VITE_OTHER_BUILD_URL`, read at build time. Unset, a dev server links to the other build's dev server, and a production build disables the other side. In the swap build it swaps in place instead (`otherBuild` in [`shell/builds.ts`](./src/shell/builds.ts) decides, for both builds' cards). A session is shared only between builds served from the same origin, so the dev servers, on different ports, each keep their own.

The live demo is built by [`.github/workflows/pages.yml`](../../.github/workflows/pages.yml), which serves this build at the site root, the React build under `react/` and the swap build under `swap/`, on one origin, so a session saved in one restores in the others. Switching between the Solid and React builds there closes an open flight question. The workflow sets the Solid and React builds' `VITE_OTHER_BUILD_URL` to each other's relative path.

## Where each capability lives

| Capability | Where |
| --- | --- |
| Entities, and long work on a child entity | [`trips/Planner.ts`](./src/trips/Planner.ts) makes a trip with a child entity per leg, and [`trips/Leg.ts`](./src/trips/Leg.ts)' `search` runs on the leg |
| Effects a test can stub | [`backend/backend.ts`](./src/backend/backend.ts) declares the provider call, and [`backend/fakeBackend.ts`](./src/backend/fakeBackend.ts) implements it with seeded answers and delays |
| A retry policy as an argument, and catching only what you expect | `search` asks each provider with `Retries: 1`; `fakeBackend` in `fakeBackend.ts` asks again after a `ProviderError`, checking the action's signal between attempts, and lets anything else fail the search |
| `inFlight` and `leading` | A leg's status in `Leg.ts`, and the trip's facts in [`trips/Trip.ts`](./src/trips/Trip.ts) |
| Results going up as messages | A finished leg publishes `Leg/Finished` to its trip |
| An ask | `chooseFlight` in `Trip.ts`, rendered from `pendingAsks` by [`trips/FlightQuestion.tsx`](./src/trips/FlightQuestion.tsx) |
| Timers | `Trip/Clock`, which counts a trip's working seconds and ticks only while a search runs, and the fare hold's `Trip/Hold`, in `Trip.ts` |
| A deadline, not a tick count | The fare hold stores `HoldUntil`, read from `now` in `backend.ts`; each `Trip/Hold` tick measures the time left from it, and `holdLeftAt` gives the restore what it found |
| Broadcasts any app can hear | [`portal/topics.ts`](./src/portal/topics.ts): [`portal/Portal.ts`](./src/portal/Portal.ts) publishes the app switches and the restore, and `Trip.ts` and `Conversation.ts` publish `Portal/Finished` |
| A tour ticked from what the app does | [`tour/Tour.ts`](./src/tour/Tour.ts) |
| Snapshot, restore and the restore announcement | [`portal/session.ts`](./src/portal/session.ts) |
| Resuming an action a reload interrupted | `chooseFlight` in `Trip.ts` is marked `resumable`, and `startPortal` in [`shell/start.ts`](./src/shell/start.ts) turns [resume](../../docs/reference/restart-and-records.md#resume) on, with the build id that [`demos/checkout/buildId.ts`](../checkout/buildId.ts) serves to each build's Vite config. A flight question caught by a reload is asked again. Each build has its own id, so an open flight question comes back only in the build that saved it: on a dev server the id changes with every edit, so a reload after an edit closes it |
| Redoing the work a restore dropped, and the after-restore banner | `repairRestore` in `session.ts` announces what the restore resumed and dropped, then `carryOn` in `Planner.ts` starts each dropped search again, reading what to start from `dropped` and never from the tree. `whatTheRestoreFound` and the `Portal/Restored` cases in `Trip.ts` and `Planner.ts` record it, and [`trips/restoreLines.ts`](./src/trips/restoreLines.ts) words it. [`trips/restorePoints.test.ts`](./src/trips/restorePoints.test.ts) checks every point a reload could land, with resume and without, and that the run with resume is never worse |
| A transient for data about running work | `awayMark` in `Trip.ts` |
| Timer rows as a loop, and the dispose cascade | Each fish's `Fish/Swim` row in [`aquarium/Fish.ts`](./src/aquarium/Fish.ts), started by `addFish` in [`aquarium/Aquarium.ts`](./src/aquarium/Aquarium.ts), whose `releaseSchool` takes the fish and their rows with it |
| Animation a view picks up part-way | A swim records where and when it set off, and `swimInProgress` in `Fish.ts` tells a mounting view how far into the glide it is |
| Randomness through an effect | `random` in `backend.ts`, implemented by a seeded `fakeRandom` |
| A stream resource that resumes | `Chat/Stream`, declared in `backend.ts` and registered by `registerChatStream` in `fakeBackend.ts`; [`chat/Conversation.ts`](./src/chat/Conversation.ts) opens it with `ResumeFrom: "Applied"` and its receiver skips letters it has applied |
| An optimistic send | `send` and `deliver` in `Conversation.ts` and [`chat/Message.ts`](./src/chat/Message.ts): `sendStatus` reads "sending" from `inFlight` and "failed" from a message neither sent nor in flight |
| A notice from any app | Work publishes `Portal/Finished`; `PortalReceiver` in `Portal.ts` shows it unless its trip or conversation is on screen, in a transient cleared by a timer row |
| One app acting on another | `applyVoucher` in [`chat/Chat.ts`](./src/chat/Chat.ts) publishes `Portal/VoucherApplied`, and `PlannerReceiver` in `Planner.ts` records it whether or not its view is mounted; `priced` in `Planner.ts` discounts each trip's total |
| Something that plays once | The voucher's flourish: a planner view starts it when `callsForFlourish` in [`trips/flourish.ts`](./src/trips/flourish.ts) says so, and dispatches `flourishPlayed` as it starts; whether it is playing is the view's own state. `Played` is saved, so neither a remount nor a reload replays it. `tickerText` gives the countdown's values, and `runTicker` animates them |
| One restore banner across apps | Each app's `Portal/Restored` case records a note, and [`portal/restoreBanner.ts`](./src/portal/restoreBanner.ts) joins their lines |
| A record tap | [`portal/monitor.ts`](./src/portal/monitor.ts) |

## The React build

[`demos/react-portal`](../react-portal/) renders the same apps through `treflex-react`. The `.tsx` files and each folder's `contexts.ts` here are the Solid part, and `demos/react-portal/src` holds their React counterparts, folder for folder. Every other module here imports no renderer, so both builds run the same feature files, and the CSS in [`styles/`](./src/styles/) is plain global classes both use. Both start through `startPortal` in [`shell/start.ts`](./src/shell/start.ts), so they read and write one session key and envelope.

The feature files resolve `treflex` from this folder, and `treflex-react` from the React build's. `resolve.dedupe` in `demos/react-portal/vite.config.mts` holds them to one copy in its dev server, build and tests. `demos/react-portal/src/oneCopy.test.ts` checks three things: the node_modules lookups that tsc follows, from both demos and from treflex-react's source, find the linked `packages/core` and `packages/react`; the dev server resolves `treflex`, `treflex/snapshot`, `treflex/internal` and `treflex-react` to those packages' sources from a feature file, the app, the binding, and a folder with its own copy of both in its `node_modules`; and the production bundle, built in production mode, holds one copy each of treflex, treflex-react, react and react-dom, each its production build.

## The swap build

[`demos/portal-swap`](../portal-swap/) boots the portal once and mounts either build's views over the same runtime. The session card's switch unmounts one and mounts the other in place, so a trip search, a streaming message and the fish carry on through it; only what a view holds itself, such as an unsent draft, is lost. It opens in Solid, or in React with `?renderer=react`, and keeps the renderer in the address so a reload comes back to it. The other renderer's views load on the first swap.

- [`src/swap.ts`](../portal-swap/src/swap.ts) holds the runtime and swaps the views; it imports no renderer. Each renderer's `mount.tsx` mounts its views into the element `swap.ts` gives it. While the other renderer's views load, its button on the card is marked busy. When they don't load or fail to mount, the page reloads in the renderer it was in.
- [`vite.config.mts`](../portal-swap/vite.config.mts) gives the React views to `@vitejs/plugin-react` and every other `.tsx` to `@solidjs/vite-plugin`, and two tsconfigs, `tsconfig.solid.json` and `tsconfig.react.json`, check each side with its own JSX.
- [`src/oneCopy.test.ts`](../portal-swap/src/oneCopy.test.ts) checks the dev server's resolution and the production bundle as the React build's does, for both bindings, solid-js, `@solidjs/web`, `@solidjs/signals`, react, react-dom and scheduler, and that each `.tsx` goes through one JSX transform.
- [`robust/`](../portal-swap/robust/) is a version of the swap that recovers from failure instead of reloading: it keeps or remounts the current view, reports a swap as pending or failed, and says it failed in a dismissible bar above the portal. Its own tests run with the build's, but the demo doesn't use it.
