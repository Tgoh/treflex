interface IReports {
	holding: boolean;
	held: Error[];
}

// On globalThis under a registered symbol, so a second copy of this module, the source and the
// built one say, shares the one registry.
const KEY = Symbol.for("treflex.testReports");

function registry(): IReports {
	const global = globalThis as {
		[KEY]?: IReports;
	};
	global[KEY] ??= {
		holding: false,
		held: []
	};
	return global[KEY];
}

export function holdReports(holding = true): void {
	registry().holding = holding;
}

export function report(error: Error): void {
	const reports = registry();
	if (reports.holding) {
		reports.held.push(error);
		return;
	}
	void Promise.reject(error);
}

export function drainReports(): Error[] {
	return registry().held.splice(0);
}

function framesOf(error: Error): string {
	const stack = error.stack ?? "";
	const header = `${error.name}: ${error.message}`;
	return stack.startsWith(`${header}\n`) ? stack.slice(header.length + 1) : "";
}

export function combineReports(errors: readonly Error[]): Error | undefined {
	if (errors.length <= 1) {
		return errors[0];
	}
	const aggregate = new AggregateError(
		errors,
		`[treflex] ${errors.length} reports:\n${errors.map((error, index) => `${index + 1}. ${error.message}`).join("\n")}`
	);
	const frames = framesOf(errors[0]!);
	aggregate.stack = `${aggregate.name}: ${aggregate.message}${frames === "" ? "" : `\n${frames}`}`;
	return aggregate;
}
