// `index.ts` reads the plugin's version out of package.json at load, and
// `createRequire` is the only node API anything under eslint/ touches. This
// project's tsconfig declares `vite/client` types and not `node`, and adding
// `node` would retype the timer handles the runtime holds as numbers, so the
// one function used is declared here instead of pulling node's globals in.
declare module "node:module" {
	export function createRequire(path: string | URL): (id: string) => {
		version: string;
	};
}
