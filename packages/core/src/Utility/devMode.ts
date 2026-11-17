declare const process: {
	env: Record<string, string | undefined>;
};

let nodeEnv: string | undefined;
try {
	// Spelled bare: a bundler's define replaces only this form, and in a browser with no define `process` doesn't exist.
	nodeEnv = process.env.NODE_ENV;
} catch {}

export const DEV =
	(
		import.meta as {
			env?: {
				DEV?: boolean;
			};
		}
	).env?.DEV ?? (nodeEnv !== undefined ? nodeEnv !== "production" : true);
