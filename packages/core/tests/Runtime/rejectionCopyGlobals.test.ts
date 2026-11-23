import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

type IGlobals = {
	DOMException?: unknown;
	AggregateError?: unknown;
	SuppressedError?: unknown;
	WebAssembly?: unknown;
};

type IErrorStatics = {
	isError?: unknown;
};

const NEWER_ERRORS = [
	"AggregateError",
	"SuppressedError",
	"WebAssembly"
] as const;

const platform = [
	...[
		"DOMException",
		...NEWER_ERRORS
	].map((key) => ({
		owner: globalThis as object,
		key
	})),
	{
		owner: Error as object,
		key: "isError"
	}
].map(({ owner, key }) => ({
	owner,
	key,
	descriptor: Object.getOwnPropertyDescriptor(owner, key)
}));

afterEach(() => {
	for (const { owner, key, descriptor } of platform) {
		if (descriptor === undefined) {
			delete (owner as Record<string, unknown>)[key];
		} else {
			Object.defineProperty(owner, key, descriptor);
		}
	}
	vi.resetModules();
});

async function loadWithout(remove: () => void) {
	remove();
	vi.resetModules();
	const { createRuntime } = await import("../../src/Runtime/createRuntime");
	const { rebuildThrow } = await import("../../src/Runtime/rebuildThrow");
	const { serializeThrow } = await import("../../src/Utility/serializeThrow");
	async function crossed(thrown: unknown): Promise<{
		caught: unknown;
		diags: IRuntimeEventOf<"diag">[];
	}> {
		const runtime = createRuntime(
			{
				$Id: "root"
			},
			{
				onError: () => {},
				implementations: {
					"t/fails": () => Promise.reject(thrown)
				}
			}
		);
		const diags: IRuntimeEventOf<"diag">[] = [];
		runtime.on("diag", (event) => diags.push(event));
		let caught: unknown = "nothing caught";
		await runtime.dispatch(function* fails(): IActionGenerator {
			try {
				yield {
					Type: "t/fails"
				} as never;
			} catch (error) {
				caught = error;
			}
		}, "root");
		return {
			caught,
			diags
		};
	}
	return {
		crossed,
		rebuildThrow,
		serializeThrow
	};
}

describe("an environment with no DOMException", () => {
	it("gives a value tagged DOMException as an Error with its name and message, reports nothing, and round-trips", async () => {
		const aborted = new AbortController();
		aborted.abort();
		const reason = aborted.signal.reason as Error;
		const { crossed, rebuildThrow, serializeThrow } = await loadWithout(() => {
			delete (globalThis as IGlobals).DOMException;
		});
		const { caught, diags } = await crossed(reason);
		const copy = caught as Error;
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect(copy.name).toBe("AbortError");
		expect(copy.message).toBe(reason.message);
		expect(diags.filter((diag) => diag.code.startsWith("effect/"))).toEqual([]);
		const form = serializeThrow(reason);
		expect(form).not.toHaveProperty("Native");
		expect(serializeThrow(rebuildThrow(form))).toEqual(form);
	});

	it("gives a polyfill named DOMException that doesn't extend Error as an Error with its name and message, and reports nothing", async () => {
		const DOMExceptionPolyfill = {
			DOMException: class DOMException {
				name = "AbortError";
				message = "stopped";
				get [Symbol.toStringTag]() {
					return "DOMException";
				}
			}
		}.DOMException;
		const { crossed } = await loadWithout(() => {
			delete (globalThis as IGlobals).DOMException;
		});
		const { caught, diags } = await crossed(new DOMExceptionPolyfill());
		const copy = caught as Error;
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect(copy.name).toBe("AbortError");
		expect(copy.message).toBe("stopped");
		expect(diags.filter((diag) => diag.code.startsWith("effect/"))).toEqual([]);
	});
});

describe("an environment with no AggregateError, SuppressedError or WebAssembly", () => {
	it("rebuilds a form naming one as an Error with its name, message and fields, and round-trips", async () => {
		const { rebuildThrow, serializeThrow } = await loadWithout(() => {
			for (const key of NEWER_ERRORS) {
				delete (globalThis as IGlobals)[key];
			}
		});
		for (const Native of [
			"AggregateError",
			"SuppressedError",
			"WebAssembly.RuntimeError"
		] as const) {
			const rebuilt = rebuildThrow({
				Thrown: "error",
				Name: Native,
				Message: "gone",
				Native,
				Fields: {
					code: 7
				},
				Errors: [],
				Error: {
					Thrown: "value",
					Data: "inner"
				}
			}) as Error & {
				code?: number;
			};
			expect(Object.getPrototypeOf(rebuilt)).toBe(Error.prototype);
			expect(rebuilt.name).toBe(Native);
			expect(rebuilt.message).toBe("gone");
			expect(rebuilt.code).toBe(7);
			const form = serializeThrow(rebuilt);
			expect(form).not.toHaveProperty("Native");
			expect(serializeThrow(rebuildThrow(form))).toEqual(form);
		}
	});
});

describe("a SuppressedError between an engine that has the type and one that doesn't", () => {
	const nested = {
		Error: {
			Thrown: "error",
			Name: "TypeError",
			Message: "dispose",
			Native: "TypeError"
		},
		Suppressed: {
			Thrown: "value",
			Data: "body"
		}
	} as const;

	it("rebuilds a form naming the type, without it, as an Error carrying its error and what it suppressed, whose form round-trips", async () => {
		const { rebuildThrow, serializeThrow } = await loadWithout(() => {
			delete (globalThis as IGlobals).SuppressedError;
		});
		const rebuilt = rebuildThrow({
			Thrown: "error",
			Name: "SuppressedError",
			Message: "both",
			Native: "SuppressedError",
			...nested
		}) as Error & {
			error: unknown;
			suppressed: unknown;
		};
		expect(Object.getPrototypeOf(rebuilt)).toBe(Error.prototype);
		expect(rebuilt.name).toBe("SuppressedError");
		expect(Object.getPrototypeOf(rebuilt.error)).toBe(TypeError.prototype);
		expect(rebuilt.suppressed).toBe("body");
		const form = serializeThrow(rebuilt);
		expect(form).toEqual({
			Thrown: "error",
			Name: "SuppressedError",
			Message: "both",
			...nested
		});
		expect(serializeThrow(rebuildThrow(form))).toEqual(form);
	});

	it.skipIf(typeof (globalThis as IGlobals).SuppressedError !== "function")(
		"rebuilds a form made without the type, where it is, as an Error carrying its error and what it suppressed, and round-trips",
		async () => {
			const { rebuildThrow, serializeThrow } = await loadWithout(() => {});
			const form = {
				Thrown: "error",
				Name: "SuppressedError",
				Message: "both",
				...nested
			} as const;
			const rebuilt = rebuildThrow(form) as Error & {
				error: unknown;
			};
			expect(rebuilt).not.toBeInstanceOf((globalThis as IGlobals).SuppressedError as Function);
			expect(Object.getPrototypeOf(rebuilt.error)).toBe(TypeError.prototype);
			expect(serializeThrow(rebuilt)).toEqual(form);
		}
	);
});

describe("an environment with no Error.isError", () => {
	it("still gives an error from another realm as an error, by its tag", async () => {
		const foreign = runInNewContext("new RangeError('far')") as Error;
		const { crossed } = await loadWithout(() => {
			delete (Error as IErrorStatics).isError;
		});
		const { caught, diags } = await crossed(foreign);
		const copy = caught as Error;
		expect(Object.getPrototypeOf(copy)).toBe(RangeError.prototype);
		expect(copy.message).toBe("far");
		expect(diags.filter((diag) => diag.code.startsWith("effect/"))).toEqual([]);
	});

	it("takes neither a value tagged Error nor a proxy of an error for an error, as Error.isError doesn't", async () => {
		class Tagged {
			readonly message = "tagged";
			get [Symbol.toStringTag](): string {
				return "Error";
			}
		}
		const { serializeThrow } = await loadWithout(() => {
			delete (Error as IErrorStatics).isError;
		});
		for (const value of [
			{
				[Symbol.toStringTag]: "Error",
				message: "tagged"
			},
			new Tagged(),
			new Proxy(runInNewContext("new Error('far')") as Error, {}),
			{
				[Symbol.toStringTag]: "DOMException",
				message: "tagged"
			}
		]) {
			expect(serializeThrow(value).Thrown).toBe("value");
		}
	});

	it("takes an error with no prototype, or whose class defines a tag, for an error", async () => {
		class Tagged extends Error {
			get [Symbol.toStringTag](): string {
				return "Tagged";
			}
		}
		const { serializeThrow } = await loadWithout(() => {
			delete (Error as IErrorStatics).isError;
		});
		for (const error of [
			Object.setPrototypeOf(new Error("bare"), null) as Error,
			new Tagged("tagged")
		]) {
			expect(serializeThrow(error).Thrown).toBe("error");
		}
	});
});
