// This project's tsconfig declares `vite/client` types and not `node`, and adding
// `node` would retype the timer handles the runtime holds as numbers, so the few
// node APIs the package touches are declared here instead of pulling node's globals in.
declare module "node:module" {
	export function createRequire(path: string | URL): (id: string) => {
		version: string;
	};
}

declare module "node:fs" {
	export function readFileSync(path: string): Uint8Array;
}

declare module "node:process" {
	const process: {
		exitCode: number | undefined;
	};
	export default process;
}
