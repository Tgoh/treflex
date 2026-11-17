export function waitFor(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (check()) {
				resolve();
			} else if (Date.now() > deadline) {
				reject(new Error(`timed out waiting for ${what}, with the page reading "${document.body.textContent}"`));
			} else {
				setTimeout(tick, 10);
			}
		};
		tick();
	});
}

export function expect(condition: boolean, what: string): void {
	if (!condition) {
		throw new Error(`expected ${what}`);
	}
}

// run-built.mjs reads the result off the body.
export function report(run: () => Promise<Record<string, unknown>>): void {
	run().then(
		(details) => {
			document.body.dataset.result = JSON.stringify({
				ok: true,
				...details
			});
		},
		(error) => {
			document.body.dataset.result = JSON.stringify({
				ok: false,
				error: String(error?.stack ?? error)
			});
		}
	);
}
