# create-treflex

Scaffolds a [treflex](https://tgoh.github.io/treflex/docs/) app: a Vite app in React or Solid, with TypeScript `strict`, a root entity holding one feature, Vitest tests, Biome and ESLint with treflex's lint rules, hot reload, and restore across a reload.

```sh
npm create treflex@latest my-app -- --template react
npm create treflex@latest my-app -- --template solid
```

Without a folder or a template it asks for them, in a terminal. It refuses a folder that holds anything but `.git`, and it installs nothing: it prints the commands to run next.

What each template holds is in its README: [React](./templates/react/README.md), [Solid](./templates/solid/README.md).
