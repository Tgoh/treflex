# Contributing

This repository doesn't accept issues or pull requests.

## Building and testing

```bash
npm ci
npm run typecheck   # tsc over the packages, tests and the consumer config
npm run lint        # biome
npm test            # vitest, single run
npm run build       # packages/*/dist: JavaScript and .d.ts
npm run test:pack   # packs every package and runs the tarballs in a fresh Vite app
```

The workspace reads the packages from `packages/*/src` through the `treflex-source` export condition, so the tests, the demos and the typecheck need no build. `test:pack` installs the packed tarballs into its app and fetches the third-party packages it needs from the npm registry, and `npm run test:pack -- --keep` leaves its app in the temp folder.
