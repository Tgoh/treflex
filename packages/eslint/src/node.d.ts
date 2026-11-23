// This project's tsconfig declares `vite/client` types and not `node`, and adding
// `node` would retype the timer handles the runtime holds as numbers, so the few
// node APIs the package touches are declared here instead of pulling node's globals in.
declare module "node:module" {
	export function createRequire(path: string | URL): {
		(
			id: string
		): {
			version: string;
		};
		resolve(id: string): string;
	};
}

declare module "node:child_process" {
	export function spawnSync(
		command: string,
		args: string[],
		options: {
			cwd?: string;
			encoding: "utf8";
			timeout?: number;
		}
	): {
		status: number | null;
		stdout: string;
		stderr: string;
		error?: Error;
	};
}

declare module "node:fs" {
	export function readFileSync(path: string): Uint8Array;
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function statSync(
		path: string,
		options: {
			throwIfNoEntry: false;
		}
	):
		| {
				isFile(): boolean;
				mtimeMs: number;
		  }
		| undefined;
	export function mkdtempSync(prefix: string): string;
	export function mkdirSync(
		path: string,
		options?: {
			recursive?: boolean;
		}
	): void;
	export function writeFileSync(path: string, text: string): void;
	export function utimesSync(path: string, atime: Date, mtime: Date): void;
	export function rmSync(
		path: string,
		options?: {
			recursive?: boolean;
			force?: boolean;
		}
	): void;
}

declare module "node:os" {
	export function tmpdir(): string;
}

declare module "node:path" {
	export function dirname(path: string): string;
	export function join(...paths: string[]): string;
	export function resolve(...paths: string[]): string;
}

declare module "node:process" {
	const process: {
		exitCode: number | undefined;
		execPath: string;
		pid: number;
		env: Record<string, string | undefined>;
	};
	export default process;
}
