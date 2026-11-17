import { host } from "../Solid/host";

export class SolidServerBuildError extends Error {
	constructor() {
		super(
			`[treflex] solid-js resolved to its server build, where a memo never re-runs, so selectors, getData and watch would ` +
				`keep their first value through every write, in actions as well as views. Resolve solid-js with the "solid" and ` +
				`"browser" conditions: resolve.conditions: ["solid", "browser"] in a Vite or vitest config, with ` +
				`ssr.resolve.conditions as well under vitest, or node --conditions=browser for a plain Node process. solid-js lists ` +
				`"worker" ahead of "browser", so a "worker" condition picks the server build even beside "browser".`
		);
		this.name = "SolidServerBuildError";
	}
}

export function assertReactiveHost(): void {
	const version = host.createVersion();
	let runs = 0;
	const memo = host.createOwnedMemo(() => {
		version.track();
		runs++;
	});
	version.bump();
	memo.read();
	memo.dispose();
	if (runs < 2) {
		throw new SolidServerBuildError();
	}
}
