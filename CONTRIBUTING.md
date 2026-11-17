# Contributing

Issues are welcome: bugs, questions and ideas. Pull requests aren't being accepted for now.

## Building and testing

The repository needs Node 22 or later and npm 11 or later: the lockfile is written by npm 11, and the npm 10 that Node 22 ships reports it as out of sync. `npm install -g npm@11` upgrades it.

```bash
npm ci
npm run typecheck   # tsc over the packages, tests and the consumer config
npm run lint        # biome
npm test            # vitest, single run
npm run test:react18 # treflex-react's tests on React 18.3, installed into scripts/react18/
npm run build       # packages/*/dist: JavaScript and .d.ts
npm run test:pack   # packs every package and runs the tarballs in a fresh Vite app
```

The workspace reads the packages from `packages/*/src` through the `treflex-source` export condition, so the tests, the demos and the typecheck need no build. `test:pack` installs the packed tarballs into its app and fetches the third-party packages it needs from the npm registry, and `npm run test:pack -- --keep` leaves its app in the temp folder.
