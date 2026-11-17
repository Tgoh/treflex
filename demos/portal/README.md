# The demo portal

A set of apps that keep running while their view is unmounted, and come back after a reload.

- **Trip planner.** An agent searches flights, hotels and activities side by side, asks you to pick a flight while the other searches carry on, and holds the fare you pick for 15 minutes. Reload mid-run: the trips, quotes and hold come back, and the searches that were running come back interrupted, with what they had found. The hold counts real time, so a hold that ran out while the page was closed comes back expired.
- **Aquarium.** Schools of fish, each fish an entity swimming on its own timer. Release a school and every fish in it goes with it. Leave and come back, or reload, and a fish that was mid-swim carries on from where it had got to.
- **Team chat.** Channels and direct messages with simulated teammates, whose messages stream in letter by letter. Reload while one is streaming and it carries on from the letter it reached; a message that was sending comes back as Didn't send, with Retry. Marcus sends a travel voucher: apply it from his message, or from its notice, and every trip, current and future, takes 10% off.

When an app's work finishes while its view isn't on screen, a notice says so over whichever app is open.

The guided tour across the top walks through it. The session card in the sidebar saves to this browser, reloads and resets. The record stream toggle opens a live tail of what the runtime records.

## Running it

```bash
npm install          # at the repo root
npm run demo:portal         # the Solid build, on port 5173
npm run demo:react-portal   # the React build, on port 5174
npm --prefix demos/portal test
npm --prefix demos/react-portal test
```

The portal's tests are headless: they run the apps on a runtime with no view. The React build's tests render its views in jsdom, and check that it loads one copy of treflex.

The session card's Solid / React switch is a link to the other build, at the address in `VITE_OTHER_BUILD_URL`, read at build time (`otherBuildUrl` in [`shell/builds.ts`](./src/shell/builds.ts)). Unset, a dev server links to the other build's dev server, and a production build disables the other side. A session is shared only between builds served from the same origin, so the two dev servers, on different ports, each keep their own.

The live demo is built by [`.github/workflows/pages.yml`](../../.github/workflows/pages.yml), which serves this build at the site root and the React build under `react/`, on one origin, so a session saved in one restores in the other. The workflow sets each build's `VITE_OTHER_BUILD_URL` to the other's relative path.

## Where each capability lives

| Capability | Where |
| --- | --- |
| Entities, and long work on a child entity | [`trips/Planner.ts`](./src/trips/Planner.ts) makes a trip with a child entity per leg, and [`trips/Leg.ts`](./src/trips/Leg.ts)' `search` runs on the leg |
| Effects a test can stub | [`backend/backend.ts`](./src/backend/backend.ts) declares the provider call, and [`backend/fakeBackend.ts`](./src/backend/fakeBackend.ts) implements it with seeded answers and delays |
| Catching only what you expect | `search` retries a `ProviderError` and lets anything else fail |
| `inFlight` and `leading` | A leg's status in `Leg.ts`, and the trip's facts in [`trips/Trip.ts`](./src/trips/Trip.ts) |
| Results going up as messages | A finished leg publishes `Leg/Finished` to its trip |
| An ask | `chooseFlight` in `Trip.ts`, rendered from `pendingAsks` by [`trips/FlightQuestion.tsx`](./src/trips/FlightQuestion.tsx) |
| Timers | `Trip/Clock`, which counts a trip's working seconds and ticks only while a search runs, and the fare hold's `Trip/Hold`, in `Trip.ts` |
| A deadline, not a tick count | The fare hold stores `HoldUntil`, read from `now` in `backend.ts`; each `Trip/Hold` tick measures the time left from it, and `holdLeftAt` gives the restore what it found |
| Broadcasts any app can hear | [`portal/topics.ts`](./src/portal/topics.ts): [`portal/Portal.ts`](./src/portal/Portal.ts) publishes the app switches and the restore, and `Trip.ts` and `Conversation.ts` publish `Portal/Finished` |
| A tour ticked from what the app does | [`tour/Tour.ts`](./src/tour/Tour.ts) |
| Snapshot, restore and the restore announcement | [`portal/session.ts`](./src/portal/session.ts) |
| Interrupted work and the after-restore banner | `legStatus` in `Leg.ts`, `whatWasLost` and the `Portal/Restored` cases in `Trip.ts` and `Planner.ts`, and [`trips/restoreLines.ts`](./src/trips/restoreLines.ts) |
| A transient for data about running work | `awayMark` in `Trip.ts` |
| Timer rows as a loop, and the dispose cascade | Each fish's `Fish/Swim` row in [`aquarium/Fish.ts`](./src/aquarium/Fish.ts), started by `addFish` in [`aquarium/Aquarium.ts`](./src/aquarium/Aquarium.ts), whose `releaseSchool` takes the fish and their rows with it |
| Animation a view picks up part-way | A swim records where and when it set off, and `swimInProgress` in `Fish.ts` tells a mounting view how far into the glide it is |
| Randomness through an effect | `random` in `backend.ts`, implemented by a seeded `fakeRandom` |
| A stream resource that resumes | `Chat/Stream`, declared in `backend.ts` and registered by `registerChatStream` in `fakeBackend.ts`; [`chat/Conversation.ts`](./src/chat/Conversation.ts) opens it with `ResumeFrom: "Applied"` and its receiver skips letters it has applied |
| An optimistic send | `send` and `deliver` in `Conversation.ts` and [`chat/Message.ts`](./src/chat/Message.ts): `sendStatus` reads "sending" from `inFlight` and "failed" from a message neither sent nor in flight |
| A notice from any app | Work publishes `Portal/Finished`; `PortalReceiver` in `Portal.ts` shows it unless its trip or conversation is on screen, in a transient cleared by a timer row |
| One app acting on another | `applyVoucher` in [`chat/Chat.ts`](./src/chat/Chat.ts) publishes `Portal/VoucherApplied`, and `PlannerReceiver` in `Planner.ts` records it whether or not its view is mounted; `priced` in `Planner.ts` discounts each trip's total |
| Something that plays once | The voucher's flourish: `Played` on the planner's voucher is saved, and the `Planner/Flourish` transient that tells the view to play isn't, so a reload doesn't replay it. `tickerText` gives the countdown's values, and `runTicker` in [`trips/flourish.ts`](./src/trips/flourish.ts) animates them |
| One restore banner across apps | Each app's `Portal/Restored` case records a note, and [`portal/restoreBanner.ts`](./src/portal/restoreBanner.ts) joins their lines |
| A record tap | [`portal/monitor.ts`](./src/portal/monitor.ts) |

## The React build

[`demos/react-portal`](../react-portal/) renders the same apps through `treflex-react`. The `.tsx` files and each folder's `contexts.ts` here are the Solid part, and `demos/react-portal/src` holds their React counterparts, folder for folder. Every other module here imports no renderer, so both builds run the same feature files, and the CSS in [`styles/`](./src/styles/) is plain global classes both use. Both start through `startPortal` in [`shell/start.ts`](./src/shell/start.ts), so they read and write one session key and envelope.

The feature files resolve `treflex` from this folder, and `treflex-react` from the React build's. `resolve.dedupe` in `demos/react-portal/vite.config.mts` holds them to one copy in its dev server, build and tests. `demos/react-portal/src/oneCopy.test.ts` checks three things: the node_modules lookups that tsc follows, from both demos and from treflex-react's source, find the linked `packages/core` and `packages/react`; the dev server resolves `treflex`, `treflex/snapshot`, `treflex/internal` and `treflex-react` to those packages' sources from a feature file, the app, the binding, and a folder with its own copy of both in its `node_modules`; and the production bundle holds one copy each of treflex, treflex-react, solid-js, react and react-dom.
