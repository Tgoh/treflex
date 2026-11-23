import type { IActionGenerator, IActionYield } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask as askEntity } from "../../src/Effects/ask";
import { defineEffect } from "../../src/Effects/defineEffect";
import { openResource } from "../../src/Effects/openResource";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { publish } from "../../src/Effects/publish";
import { resource } from "../../src/Effects/resource";
import { startTimer } from "../../src/Effects/startTimer";
import { select } from "../../src/Reads/select";
import { AskRefusedError } from "../../src/Runtime/askErrors";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { EntityGoneError } from "../../src/Runtime/entityGoneError";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open } from "../../src/Runtime/open";
import { rebuildThrow } from "../../src/Runtime/rebuildThrow";
import { receiver } from "../../src/Runtime/receiver";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { isRefusal, OutsideActionError, TreflexRefusal } from "../../src/Runtime/refusal";
import { runningStep } from "../../src/Runtime/runningStep";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { transient } from "../../src/Runtime/transient";
import { createTestRuntime, settled } from "../../src/Testing/createTestRuntime";
import {
	type ISerializedThrow,
	isPlatformClass,
	NESTED_THROW_COUNT,
	NESTED_THROW_DEPTH,
	PROTOTYPE_WALK_STEPS,
	serializeThrow
} from "../../src/Utility/serializeThrow";
import { isFrozenCopy } from "../../src/Utility/valueCodec";
import { deepNestingDepths, depthOf, nest, pendingAsksOf } from "../testHelpers";

interface INode {
	Value: number;
}

interface IRow {
	K: string;
	V?: number;
}

interface IWorld {
	$Id: string;
	Node: INode;
	Copy: INode | null;
	N: number;
	Log: string[];
	Rows: IRow[];
	Sub: {
		$Id: string;
	};
}

class ConflictError extends Error {
	readonly version: number;
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ConflictError";
		this.version = 3;
	}
}

class OfflineError extends TypeError {
	readonly retryIn: number;
	constructor(message: string) {
		super(message);
		this.name = "OfflineError";
		this.retryIn = 5;
	}
}

const openResourceAny = openResource as unknown as (entity: object, key: string, ...rest: unknown[]) => IActionGenerator;
const resourceAny = resource as unknown as (ownerId: string, key: string) => Record<string, (...args: unknown[]) => IActionGenerator>;
const publishAny = publish as unknown as (topic: string, data?: object) => IActionGenerator;
const startTimerAny = startTimer as unknown as (
	entity: object,
	key: string,
	handler: unknown,
	ms: number,
	payload?: object
) => IActionGenerator;
const reconcileRowsAny = reconcileRows as unknown as (
	current: IRow[],
	incoming: IRow[],
	key: (row: IRow) => string,
	options: {
		add?: (item: IRow) => Generator<any, IRow, any>;
		update: (row: IRow, item: IRow) => void;
	}
) => IActionGenerator;

interface IResourceRegistrar {
	registerResourceType(type: string, impl: (params: unknown, r: any) => void): void;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const hasSuppressedError = typeof globalThis.SuppressedError === "function";

const hasIsError =
	typeof (
		Error as {
			isError?: unknown;
		}
	).isError === "function";

function build(implementations: Record<string, (effect: any) => unknown> = {}) {
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Node: {
				Value: 1
			},
			Copy: null,
			N: 0,
			Log: [],
			Rows: [],
			Sub: {
				$Id: "sub"
			}
		},
		{
			onError: () => {},
			implementations
		}
	);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	const codes = (code: string) => diags.filter((diag) => diag.code === code);
	return {
		runtime,
		diags,
		codes
	};
}

function* ask(type: string, rest: Record<string, unknown> = {}): Generator<IActionYield, any, any> {
	return yield {
		Type: type,
		...rest
	} as IActionYield;
}

async function caughtBy(runtime: ReturnType<typeof build>["runtime"], type: string): Promise<unknown> {
	let caught: unknown = "nothing caught";
	await runtime.dispatch(function* catches(): IActionGenerator {
		try {
			yield* ask(type);
		} catch (error) {
			caught = error;
		}
	}, "root");
	return caught;
}

function conflict(): ConflictError {
	return new ConflictError("version 3 is taken", {
		cause: new TypeError("socket closed", {
			cause: "remote"
		})
	});
}

function expectConflictCopy(copy: unknown, original: ConflictError): void {
	expect(copy).not.toBe(original);
	expect(copy).toBeInstanceOf(Error);
	expect(copy).not.toBeInstanceOf(ConflictError);
	expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
	const error = copy as ConflictError;
	expect(error.name).toBe("ConflictError");
	expect(error.message).toBe("version 3 is taken");
	expect(error.version).toBe(3);
	expect(Object.keys(error)).toEqual([
		"version"
	]);
	expect(error.cause).toBeInstanceOf(TypeError);
	expect(error.cause).not.toBe(original.cause);
	expect((error.cause as Error).message).toBe("socket closed");
	expect((error.cause as Error).cause).toBe("remote");
	expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(false);
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("an implementation's rejection reaches the action as a copy", () => {
	it("from a promise that rejects: an app class arrives as its native base, with its name, fields and cause chain", async () => {
		const original = conflict();
		const h = build({
			"t/save": () => Promise.reject(original)
		});
		expectConflictCopy(await caughtBy(h.runtime, "t/save"), original);
	});

	it("from a synchronous throw", async () => {
		const original = conflict();
		const h = build({
			"t/save": () => {
				throw original;
			}
		});
		expectConflictCopy(await caughtBy(h.runtime, "t/save"), original);
	});

	it("from a settles: sync implementation's throw", async () => {
		const saveNow = defineEffect<
			{
				Type: "t/saveNow";
			},
			number
		>("t/saveNow", {
			settles: "sync"
		});
		const original = conflict();
		const h = build({
			"t/saveNow": () => {
				throw original;
			}
		});
		let caught: unknown;
		await h.runtime.dispatch(function* catches(): IActionGenerator {
			try {
				yield* saveNow();
			} catch (error) {
				caught = error;
			}
		}, "root");
		expectConflictCopy(caught, original);
	});

	it("from a resource method's handler", async () => {
		const original = conflict();
		const h = build();
		(
			h.runtime as unknown as {
				registerResourceType(type: string, impl: (params: unknown, r: any) => void): void;
			}
		).registerResourceType("t/feed", (_params, r) => {
			r.methods({
				async save() {
					throw original;
				}
			});
		});
		await h.runtime.dispatch(function* opens(draft: IWorld): IActionGenerator {
			yield* openResourceAny(draft, "T/Feed", {
				Type: "t/feed"
			});
		}, "root");
		await settled();
		let caught: unknown;
		await h.runtime.dispatch(function* calls(draft: IWorld): IActionGenerator {
			try {
				yield* (
					resource(draft.$Id, "T/Feed" as never) as unknown as {
						save(): IActionGenerator;
					}
				).save();
			} catch (error) {
				caught = error;
			}
		}, "root");
		expectConflictCopy(caught, original);
		expect(h.codes("effect/class-rejection")[0]!.data).toMatchObject({
			key: "T/Feed",
			method: "save",
			className: "ConflictError"
		});
	});

	it("keeps a native type, and an app class extending one arrives as that type", async () => {
		const range = new RangeError("too far");
		const offline = new OfflineError("no network");
		const h = build({
			"t/range": () => Promise.reject(range),
			"t/offline": () => Promise.reject(offline)
		});
		const rangeCopy = await caughtBy(h.runtime, "t/range");
		expect(rangeCopy).not.toBe(range);
		expect(Object.getPrototypeOf(rangeCopy)).toBe(RangeError.prototype);
		expect((rangeCopy as Error).message).toBe("too far");
		const offlineCopy = (await caughtBy(h.runtime, "t/offline")) as OfflineError;
		expect(Object.getPrototypeOf(offlineCopy)).toBe(TypeError.prototype);
		expect(offlineCopy).not.toBeInstanceOf(OfflineError);
		expect(offlineCopy.name).toBe("OfflineError");
		expect(offlineCopy.retryIn).toBe(5);
	});

	it("rebuilds an AggregateError's errors as copies", async () => {
		const inner = new RangeError("first");
		const original = new AggregateError(
			[
				inner,
				"second"
			],
			"both failed"
		);
		const h = build({
			"t/all": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/all")) as AggregateError;
		expect(copy).not.toBe(original);
		expect(copy).toBeInstanceOf(AggregateError);
		expect(copy.message).toBe("both failed");
		expect(copy.errors).toHaveLength(2);
		expect(copy.errors[0]).not.toBe(inner);
		expect(copy.errors[0]).toBeInstanceOf(RangeError);
		expect((copy.errors[0] as Error).message).toBe("first");
		expect(copy.errors[1]).toBe("second");
	});

	it("gives a thrown value as its JSON round trip, and undefined as undefined", async () => {
		const value = {
			Code: 409,
			At: [
				1,
				2
			]
		};
		const h = build({
			"t/value": () => Promise.reject(value),
			"t/undefined": () => Promise.reject(undefined)
		});
		const copy = await caughtBy(h.runtime, "t/value");
		expect(copy).not.toBe(value);
		expect(copy).toEqual(value);
		expect(await caughtBy(h.runtime, "t/undefined")).toBeUndefined();
	});

	it("gives an error from another realm as this realm's native type", async () => {
		const original = runInNewContext("new TypeError('from another realm')") as Error;
		expect(original).not.toBeInstanceOf(Error);
		const h = build({
			"t/realm": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/realm")) as Error;
		expect(Object.getPrototypeOf(copy)).toBe(TypeError.prototype);
		expect(copy.message).toBe("from another realm");
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	it("gives a WebAssembly.RuntimeError from another realm as this realm's", async () => {
		const original = runInNewContext("new WebAssembly.RuntimeError('trap')") as Error;
		expect(original).not.toBeInstanceOf(Error);
		const h = build({
			"t/realm": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/realm")) as Error;
		expect(Object.getPrototypeOf(copy)).toBe(WebAssembly.RuntimeError.prototype);
		expect(copy.message).toBe("trap");
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	for (const name of [
		"TypeError",
		"RangeError",
		"RuntimeError",
		"CompileError",
		"LinkError"
	]) {
		it(`gives an app class from another realm named ${name} as an Error, and reports the class`, async () => {
			const original = runInNewContext(
				`class ${name} extends Error { constructor(message) { super(message); this.name = "${name}"; this.code = 7; } }; new ${name}("boom")`
			) as Error;
			const h = build({
				"t/realm": () => Promise.reject(original)
			});
			const copy = (await caughtBy(h.runtime, "t/realm")) as Error;
			expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
			expect(copy.name).toBe(name);
			expect(h.codes("effect/class-rejection").map((diag) => diag.data)).toEqual([
				{
					effectType: "t/realm",
					className: name,
					arrivedAs: "Error"
				}
			]);
		});
	}

	it("gives a plain object tagged Error or DOMException as its JSON form, and reports nothing", async () => {
		const tagged = {
			[Symbol.toStringTag]: "Error",
			name: "N",
			message: "m"
		};
		const taggedDOMException = {
			[Symbol.toStringTag]: "DOMException",
			name: "AbortError",
			message: "m"
		};
		const bare = Object.create(null) as Record<PropertyKey, unknown>;
		bare[Symbol.toStringTag] = "Error";
		bare.message = "bare";
		for (const value of [
			tagged,
			taggedDOMException,
			bare
		]) {
			expect(serializeThrow(value).Thrown).toBe("value");
		}
		const h = build({
			"t/tagged": () => Promise.reject(tagged),
			"t/taggedDOMException": () => Promise.reject(taggedDOMException),
			"t/bare": () => Promise.reject(bare)
		});
		const copy = await caughtBy(h.runtime, "t/tagged");
		expect(copy).not.toBeInstanceOf(Error);
		expect(copy).toEqual({
			name: "N",
			message: "m"
		});
		expect(await caughtBy(h.runtime, "t/taggedDOMException")).toEqual({
			name: "AbortError",
			message: "m"
		});
		expect(await caughtBy(h.runtime, "t/bare")).toEqual({
			message: "bare"
		});
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	it("doesn't take a bound function or a proxy named after a native type for a realm's built-in", () => {
		const bound = TypeError.bind(null);
		Object.defineProperty(bound, "name", {
			value: "TypeError"
		});
		for (const made of [
			bound,
			new Proxy(TypeError, {})
		]) {
			const error = Object.setPrototypeOf(
				new Error("posing"),
				Object.create(Object.prototype, {
					constructor: {
						value: made
					}
				})
			) as Error;
			expect(serializeThrow(error)).not.toHaveProperty("Native");
		}
	});

	it("gives a DOMException from another realm as this realm's DOMException", async () => {
		const Foreign = runInNewContext(
			"(class DOMException extends Error { constructor(message, name) { super(message); this.name = name; } get [Symbol.toStringTag]() { return 'DOMException'; } })"
		) as new (
			message: string,
			name: string
		) => Error;
		const h = build({
			"t/realm": () => Promise.reject(new Foreign("stopped", "AbortError"))
		});
		const copy = (await caughtBy(h.runtime, "t/realm")) as DOMException;
		expect(copy).toBeInstanceOf(DOMException);
		expect(copy.name).toBe("AbortError");
		expect(copy.code).toBe(20);
		expect(copy.message).toBe("stopped");
	});

	it("gives an app class extending TypeError whose toStringTag getter throws as a TypeError, and reports the class", async () => {
		class Hostile extends TypeError {
			get [Symbol.toStringTag](): string {
				throw new Error("tag refused");
			}
		}
		const h = build({
			"t/hostile": () => Promise.reject(new Hostile("hostile"))
		});
		const copy = (await caughtBy(h.runtime, "t/hostile")) as Error;
		expect(Object.getPrototypeOf(copy)).toBe(TypeError.prototype);
		expect(copy.message).toBe("hostile");
		expect(h.codes("effect/class-rejection").map((diag) => diag.data)).toEqual([
			{
				effectType: "t/hostile",
				className: "Hostile",
				arrivedAs: "TypeError"
			}
		]);
	});

	it("gives an instance of a class tagged Error that doesn't extend it as its JSON form, and reports the class", async () => {
		class Failure {
			readonly message = "failed";
			readonly code = 7;
			get [Symbol.toStringTag](): string {
				return "Error";
			}
		}
		const h = build({
			"t/failure": () => Promise.reject(new Failure())
		});
		const copy = await caughtBy(h.runtime, "t/failure");
		expect(copy).not.toBeInstanceOf(Error);
		expect(copy).toEqual({
			message: "failed",
			code: 7
		});
		expect(h.codes("effect/class-rejection").map((diag) => diag.data)).toEqual([
			{
				effectType: "t/failure",
				className: "Failure",
				arrivedAs: "JSON"
			}
		]);
	});

	it("gives an error with no prototype as an Error, and reports nothing", async () => {
		const bare = Object.setPrototypeOf(new Error("bare"), null) as Error;
		const h = build({
			"t/bare": () => Promise.reject(bare)
		});
		const copy = (await caughtBy(h.runtime, "t/bare")) as Error;
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect(copy.message).toBe("bare");
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	it("gives an app class named DOMException that extends the platform's as a DOMException, and reports the class", async () => {
		const AppDOMException = class DOMException extends globalThis.DOMException {
			readonly extra = 1;
		};
		const h = build({
			"t/app": () => Promise.reject(new AppDOMException("no such row", "NotFoundError"))
		});
		const copy = (await caughtBy(h.runtime, "t/app")) as DOMException;
		expect(Object.getPrototypeOf(copy)).toBe(DOMException.prototype);
		expect(copy.name).toBe("NotFoundError");
		expect(h.codes("effect/class-rejection").map((diag) => diag.data)).toEqual([
			{
				effectType: "t/app",
				className: "DOMException",
				arrivedAs: "DOMException"
			}
		]);
	});

	it("gives an app class extending DOMException as a DOMException, and reports the class", async () => {
		class NotFound extends DOMException {}
		const h = build({
			"t/notFound": () => Promise.reject(new NotFound("no such row", "NotFoundError"))
		});
		const copy = (await caughtBy(h.runtime, "t/notFound")) as DOMException;
		expect(Object.getPrototypeOf(copy)).toBe(DOMException.prototype);
		expect(copy.name).toBe("NotFoundError");
		expect(copy.code).toBe(8);
		expect(copy.message).toBe("no such row");
		expect(h.codes("effect/class-rejection").map((diag) => diag.data)).toEqual([
			{
				effectType: "t/notFound",
				className: "NotFound",
				arrivedAs: "DOMException"
			}
		]);
	});

	it.skipIf(!hasSuppressedError)("rebuilds a SuppressedError with copies of its error and what it suppressed", async () => {
		const original = new SuppressedError(new TypeError("dispose"), new RangeError("body"), "both");
		const h = build({
			"t/using": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/using")) as SuppressedError;
		expect(copy).not.toBe(original);
		expect(copy).toBeInstanceOf(SuppressedError);
		expect(copy.message).toBe("both");
		expect(copy.error).not.toBe(original.error);
		expect(copy.error).toBeInstanceOf(TypeError);
		expect((copy.error as Error).message).toBe("dispose");
		expect(copy.suppressed).toBeInstanceOf(RangeError);
		expect((copy.suppressed as Error).message).toBe("body");
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	it("rebuilds each WebAssembly error as itself", async () => {
		const h = build({
			"t/compile": () => Promise.reject(new WebAssembly.CompileError("bad module")),
			"t/link": () => Promise.reject(new WebAssembly.LinkError("bad import")),
			"t/trap": () => Promise.reject(new WebAssembly.RuntimeError("unreachable"))
		});
		expect(Object.getPrototypeOf(await caughtBy(h.runtime, "t/compile"))).toBe(WebAssembly.CompileError.prototype);
		expect(Object.getPrototypeOf(await caughtBy(h.runtime, "t/link"))).toBe(WebAssembly.LinkError.prototype);
		const trap = (await caughtBy(h.runtime, "t/trap")) as Error;
		expect(Object.getPrototypeOf(trap)).toBe(WebAssembly.RuntimeError.prototype);
		expect(trap.message).toBe("unreachable");
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	it("gives a thrown object that is neither an error nor plain data as its JSON form, and says so", async () => {
		const h = build({
			"t/response": () =>
				Promise.reject(
					new Response("conflict", {
						status: 409
					})
				)
		});
		expect(await caughtBy(h.runtime, "t/response")).toEqual({});
		expect(h.codes("effect/class-rejection").map((diag) => diag.data)).toEqual([
			{
				effectType: "t/response",
				className: "Response",
				arrivedAs: "JSON"
			}
		]);
		expect(h.codes("effect/class-rejection")[0]!.message).toContain("its JSON form");
	});

	it("prints nothing on the console for a thrown value with no exact JSON form", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = build({
			"t/dated": () =>
				Promise.reject({
					At: new Date(0)
				})
		});
		h.runtime.on("record", () => {});
		expect(await caughtBy(h.runtime, "t/dated")).toEqual({
			At: "1970-01-01T00:00:00.000Z"
		});
		expect(warn.mock.calls.filter(([text]) => String(text).includes("does not survive JSON"))).toEqual([]);
	});

	it("from a resource method's stub on a test runtime", async () => {
		const original = Object.assign(new RangeError("bad"), {
			code: 7
		});
		const Up = receiver<IWorld>("t/stubbedFeed")({
			*"T/Stubbed"() {}
		} as never);
		const runtime = createTestRuntime<IWorld>(
			{
				$Id: "root",
				Node: {
					Value: 1
				},
				Copy: null,
				N: 0,
				Log: [],
				Rows: [],
				Sub: {
					$Id: "sub"
				}
			},
			{},
			{
				resources: {
					methods: {
						"T/Stubbed": {
							up: () => Promise.reject(original)
						}
					}
				}
			} as never
		);
		runtime.registerReceiver(Up as never);
		await runtime.dispatch(function* opens(draft: IWorld): IActionGenerator {
			yield* openResourceAny(draft, "T/Stubbed", Up, {
				Type: "t/stubbed"
			});
		}, "root");
		let caught: unknown;
		await runtime.dispatch(function* calls(draft: IWorld): IActionGenerator {
			try {
				yield* resourceAny(draft.$Id, "T/Stubbed").up!();
			} catch (error) {
				caught = error;
			}
		}, "root");
		expect(caught).not.toBe(original);
		expect(Object.getPrototypeOf(caught)).toBe(RangeError.prototype);
		expect((caught as typeof original).code).toBe(7);
		runtime.dispose();
	});
});

describe("an error the platform throws", () => {
	async function rejectionOf(run: () => Promise<unknown>): Promise<Error> {
		try {
			await run();
		} catch (error) {
			return error as Error;
		}
		throw new Error("did not reject");
	}

	const effectDiags = (h: ReturnType<typeof build>) => h.diags.filter((diag) => diag.code.startsWith("effect/"));

	it("gives Node's TypeError for a bad argument, whose prototypes above TypeError's own name it, as a TypeError, and reports nothing", async () => {
		const original = await rejectionOf(() => readFile(5 as never));
		expect(Object.getPrototypeOf(original)).not.toBe(TypeError.prototype);
		expect(Object.getPrototypeOf(original).constructor).toBe(TypeError);
		const h = build({
			"t/read": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/read")) as Error & {
			code?: unknown;
		};
		expect(Object.getPrototypeOf(copy)).toBe(TypeError.prototype);
		expect(copy.message).toBe(original.message);
		expect(copy.code).toBe("ERR_INVALID_ARG_TYPE");
		expect(effectDiags(h)).toEqual([]);
	});

	it("passes a test runtime's strict diags with a stub that rejects with Node's TypeError for a bad argument", async () => {
		const original = await rejectionOf(() => readFile(5 as never));
		const runtime = createTestRuntime<IWorld>(
			{
				$Id: "root",
				Node: {
					Value: 1
				},
				Copy: null,
				N: 0,
				Log: [],
				Rows: [],
				Sub: {
					$Id: "sub"
				}
			},
			{
				"t/read": () => Promise.reject(original)
			} as never
		);
		await runtime.dispatch(function* reads(draft: IWorld): IActionGenerator {
			try {
				yield* ask("t/read");
			} catch (error) {
				draft.Log.push((error as Error).name);
			}
		}, "root");
		await settled();
		expect(runtime.state.Log).toEqual([
			"TypeError"
		]);
		runtime.dispose();
	});

	it("gives a rejected access of a missing file as an Error with its errno, code, syscall and path, and reports nothing", async () => {
		const missing = join(tmpdir(), "treflex-no-such-folder", "no-such-file");
		const original = (await rejectionOf(() => access(missing))) as NodeJS.ErrnoException;
		const h = build({
			"t/access": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/access")) as NodeJS.ErrnoException;
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect({
			errno: copy.errno,
			code: copy.code,
			syscall: copy.syscall,
			path: copy.path
		}).toEqual({
			errno: original.errno,
			code: "ENOENT",
			syscall: "access",
			path: missing
		});
		expect(effectDiags(h)).toEqual([]);
	});

	it("gives Node's AbortError, a class that isn't a global, as an Error with its name and code, and reports nothing", async () => {
		const original = await rejectionOf(() =>
			sleep(10, undefined, {
				signal: AbortSignal.abort()
			})
		);
		const made = Object.getPrototypeOf(original).constructor as Function;
		expect(made).not.toBe(Error);
		expect((globalThis as Record<string, unknown>)[made.name]).not.toBe(made);
		const h = build({
			"t/sleep": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/sleep")) as Error & {
			code?: unknown;
		};
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect(copy.name).toBe("AbortError");
		expect(copy.code).toBe("ABORT_ERR");
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	it("reports nothing for a class set as a global under its own name, and reports the same class when it isn't one", async () => {
		const Platform = class TreflexPlatformProbe extends TypeError {};
		const globals = globalThis as Record<string, unknown>;
		const set = build({
			"t/platform": () => Promise.reject(new Platform("from the platform"))
		});
		globals.TreflexPlatformProbe = Platform;
		try {
			expect(Object.getPrototypeOf(await caughtBy(set.runtime, "t/platform"))).toBe(TypeError.prototype);
		} finally {
			delete globals.TreflexPlatformProbe;
		}
		expect(set.codes("effect/class-rejection")).toEqual([]);
		const unset = build({
			"t/platform": () => Promise.reject(new Platform("from the app"))
		});
		await caughtBy(unset.runtime, "t/platform");
		expect(unset.codes("effect/class-rejection").map((diag) => diag.data)).toEqual([
			{
				effectType: "t/platform",
				className: "TreflexPlatformProbe",
				arrivedAs: "TypeError"
			}
		]);
	});

	const QuotaExceeded = (
		globalThis as {
			QuotaExceededError?: new (message: string) => Error;
		}
	).QuotaExceededError;

	it.skipIf(QuotaExceeded === undefined)("gives the platform's QuotaExceededError as a DOMException, and reports nothing", async () => {
		const h = build({
			"t/quota": () => Promise.reject(new QuotaExceeded!("full"))
		});
		const copy = (await caughtBy(h.runtime, "t/quota")) as DOMException;
		expect(Object.getPrototypeOf(copy)).toBe(DOMException.prototype);
		expect(copy.name).toBe("QuotaExceededError");
		expect(copy.message).toBe("full");
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	it("takes this realm's native for the type the copy arrives as, or another constructor that prints as native code, for the platform's", () => {
		expect(Function.prototype.toString.call(Intl.Collator)).toMatch(/\[native code\]/);
		expect((globalThis as Record<string, unknown>).Collator).toBeUndefined();
		expect(isPlatformClass(Intl.Collator, "TypeError")).toBe(true);
		expect(isPlatformClass(TypeError, "TypeError")).toBe(true);
		expect(isPlatformClass(TypeError, "Error")).toBe(false);
		expect(isPlatformClass(class Collator extends TypeError {}, "TypeError")).toBe(false);
	});

	it("reports nothing for an error whose constructor prints as native code", async () => {
		const original = Object.setPrototypeOf(
			new TypeError("collated"),
			Object.create(TypeError.prototype, {
				constructor: {
					value: Intl.Collator
				}
			})
		) as Error;
		const h = build({
			"t/collated": () => Promise.reject(original)
		});
		expect(Object.getPrototypeOf(await caughtBy(h.runtime, "t/collated"))).toBe(TypeError.prototype);
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});
});

describe("what the runtime throws in itself", () => {
	it("is the object the runtime made: a refused step", async () => {
		const refused = vi.spyOn(runningStep, "refused");
		const h = build({
			"t/echo": () => Promise.resolve("ok")
		});
		let caught: unknown;
		await h.runtime.dispatch(function* aliases(draft: IWorld): IActionGenerator {
			try {
				draft.Copy = draft.Node;
				yield* ask("t/echo");
			} catch (error) {
				caught = error;
			}
		}, "root");
		expect(caught).toBeInstanceOf(StateAliasError);
		expect(refused.mock.calls.some(([made]) => made === caught)).toBe(true);
	});

	it("is the object the runtime made: an ask's refusal", async () => {
		const refused = vi.spyOn(runningStep, "refused");
		const { ask: askEffect } = await import("../../src/Effects/ask");
		const h = build();
		let caught: unknown;
		await h.runtime.dispatch(function* asksOutsideOpen(draft: IWorld): IActionGenerator {
			try {
				yield* askEffect(draft, {
					Path: "Confirm"
				});
			} catch (error) {
				caught = error;
			}
		}, "root");
		expect(caught).toBeInstanceOf(AskRefusedError);
		expect(refused.mock.calls.some(([made]) => made === caught)).toBe(true);
	});

	it("is the object the runtime made: a settles: sync implementation's result that isn't plain", async () => {
		const readNow = defineEffect<
			{
				Type: "t/readNow";
			},
			unknown
		>("t/readNow", {
			settles: "sync"
		});
		// A rebuild never runs the constructor, so only the runtime's own object passes through this setter.
		const constructed = new WeakSet<object>();
		const names = new WeakMap<object, unknown>();
		Object.defineProperty(NonPlainDataError.prototype, "name", {
			get(this: object) {
				return names.get(this);
			},
			set(this: object, value: unknown) {
				constructed.add(this);
				names.set(this, value);
			},
			configurable: true
		});
		try {
			const h = build({
				"t/readNow": () => new Date(0)
			});
			let caught: unknown;
			await h.runtime.dispatch(function* reads(): IActionGenerator {
				try {
					yield* readNow();
				} catch (error) {
					caught = error;
				}
			}, "root");
			expect(caught).toBeInstanceOf(NonPlainDataError);
			expect(constructed.has(caught as object)).toBe(true);
		} finally {
			delete (NonPlainDataError.prototype as Partial<Error>).name;
		}
	});
});

describe("parallel", () => {
	it("rethrows the object a branch ended with, for the branch's own throw", async () => {
		const own = new ConflictError("mine");
		const h = build({
			"t/echo": () => Promise.resolve("ok")
		});
		let caught: unknown;
		await h.runtime.dispatch(function* fansOut(): IActionGenerator {
			try {
				yield* parallel(
					(function* (): IActionGenerator {
						yield* ask("t/echo");
						throw own;
					})(),
					ask("t/echo")
				);
			} catch (error) {
				caught = error;
			}
		}, "root");
		expect(caught).toBe(own);
	});

	it("rethrows the object a branch ended with, for a copied rejection", async () => {
		const original = new Error("down");
		const h = build({
			"t/fails": () => Promise.reject(original),
			"t/echo": () => Promise.resolve("ok")
		});
		let branchSaw: unknown;
		let caught: unknown;
		await h.runtime.dispatch(function* fansOut(): IActionGenerator {
			try {
				yield* parallel(
					(function* (): IActionGenerator {
						try {
							yield* ask("t/fails");
						} catch (error) {
							branchSaw = error;
							throw error;
						}
					})(),
					ask("t/echo")
				);
			} catch (error) {
				caught = error;
			}
		}, "root");
		expect(branchSaw).not.toBe(original);
		expect(caught).toBe(branchSaw);
	});
});

describe("treflex's own errors", () => {
	it("an app class extending one arrives as that class, and its form names it", async () => {
		class GoneForGood extends EntityGoneError {
			constructor() {
				super("gone", "gone for good");
				this.name = "GoneForGood";
			}
		}
		const original = new GoneForGood();
		expect(serializeThrow(original)).toMatchObject({
			Name: "GoneForGood",
			Class: "treflex/EntityGoneError"
		});
		const h = build({
			"t/gone": () => Promise.reject(original)
		});
		const copy = await caughtBy(h.runtime, "t/gone");
		expect(Object.getPrototypeOf(copy)).toBe(EntityGoneError.prototype);
		expect(copy).not.toBeInstanceOf(GoneForGood);
		expect((copy as EntityGoneError).name).toBe("GoneForGood");
		expect((copy as EntityGoneError).id).toBe("gone");
		expect(h.codes("effect/class-rejection")[0]!.data).toMatchObject({
			className: "GoneForGood",
			arrivedAs: "EntityGoneError"
		});
	});

	it("an EntityGoneError from a dispatch an implementation awaited arrives as an EntityGoneError with its id", async () => {
		let original: unknown;
		const h = build({
			"t/dispatchGone": () => {
				const dispatched = h.runtime.dispatch(function* nothing(): IActionGenerator {}, "gone");
				dispatched.catch((error: unknown) => {
					original = error;
				});
				return dispatched;
			}
		});
		const copy = await caughtBy(h.runtime, "t/dispatchGone");
		expect(original).toBeInstanceOf(EntityGoneError);
		expect(copy).not.toBe(original);
		expect(copy).toBeInstanceOf(EntityGoneError);
		expect((copy as EntityGoneError).id).toBe("gone");
		expect((copy as EntityGoneError).message).toBe((original as EntityGoneError).message);
	});

	it("a refusal from another action answers isRefusal, as its class, without its constructor running", async () => {
		const h = build({
			"t/dispatchChild": () => h.runtime.dispatch(child, "sub")
		});
		let original: unknown;
		function* child(): IActionGenerator {
			original = new OutsideActionError("child()");
			throw original;
		}
		const refused = vi.spyOn(runningStep, "refused");
		const copy = await caughtBy(h.runtime, "t/dispatchChild");
		await settled();
		expect(copy).not.toBe(original);
		expect(copy).toBeInstanceOf(OutsideActionError);
		expect(copy).toBeInstanceOf(TreflexRefusal);
		expect(isRefusal(copy)).toBe(true);
		expect((copy as Error).name).toBe("OutsideActionError");
		expect(refused.mock.calls.some(([made]) => made === copy)).toBe(false);
	});
});

describe("another action's failure through a dispatch an implementation awaited", () => {
	it("arrives as its native base, and the class it was is not reported", async () => {
		const child = function* child(): IActionGenerator {
			yield* ask("t/echo");
			throw conflict();
		};
		const h = build({
			"t/echo": () => Promise.resolve("ok"),
			"t/dispatchChild": () => h.runtime.dispatch(child, "sub")
		});
		const copy = (await caughtBy(h.runtime, "t/dispatchChild")) as ConflictError;
		await settled();
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect(copy.name).toBe("ConflictError");
		expect(copy.version).toBe(3);
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	class Money {
		constructor(readonly cents: number) {}
	}

	for (const [what, make] of [
		[
			"an instance of a class",
			() => new Money(5)
		],
		[
			"a Map",
			() =>
				new Map([
					[
						"a",
						1
					]
				])
		],
		[
			"a Date",
			() => new Date(0)
		]
	] as const) {
		it(`arrives as its JSON form, and is not reported, for ${what}`, async () => {
			const thrown = make();
			const child = function* child(): IActionGenerator {
				throw thrown;
			};
			const h = build({
				"t/dispatchChild": () => h.runtime.dispatch(child, "sub")
			});
			const copy = await caughtBy(h.runtime, "t/dispatchChild");
			await settled();
			expect(copy).toEqual(JSON.parse(JSON.stringify(thrown)));
			expect(h.codes("effect/class-rejection")).toEqual([]);
		});
	}

	it("is not reported for a function", async () => {
		const thrown = () => 1;
		const child = function* child(): IActionGenerator {
			throw thrown;
		};
		const h = build({
			"t/dispatchChild": () => h.runtime.dispatch(child, "sub")
		});
		expect(await caughtBy(h.runtime, "t/dispatchChild")).toBeUndefined();
		await settled();
		expect(h.codes("effect/class-rejection")).toEqual([]);
	});

	it("is reported for a bigint or a symbol, which the runtime can't tell from an implementation's own", async () => {
		for (const thrown of [
			7n,
			Symbol("failed")
		]) {
			const child = function* child(): IActionGenerator {
				throw thrown;
			};
			const h = build({
				"t/dispatchChild": () => h.runtime.dispatch(child, "sub")
			});
			expect(await caughtBy(h.runtime, "t/dispatchChild")).toBeUndefined();
			await settled();
			expect(h.codes("effect/class-rejection")).toHaveLength(1);
		}
	});

	it("passes a test runtime's strict diags", async () => {
		const child = function* child(): IActionGenerator {
			throw conflict();
		};
		const runtime = createTestRuntime<IWorld>(
			{
				$Id: "root",
				Node: {
					Value: 1
				},
				Copy: null,
				N: 0,
				Log: [],
				Rows: [],
				Sub: {
					$Id: "sub"
				}
			},
			{
				"t/dispatchChild": () => runtime.dispatch(child, "sub")
			} as never,
			{
				allowFailures: [
					child
				]
			} as never
		);
		await runtime.dispatch(function* waits(draft: IWorld): IActionGenerator {
			try {
				yield* ask("t/dispatchChild");
			} catch (error) {
				draft.Log.push((error as Error).name);
			}
		}, "root");
		await settled();
		expect(runtime.state.Log).toEqual([
			"ConflictError"
		]);
		runtime.dispose();
	});
});

describe("action/refusal-swallowed and a refusal that crossed", () => {
	function* child(): IActionGenerator {
		throw new OutsideActionError("child()");
	}

	it("stays quiet on an action that catches another action's refusal through an effect and carries on", async () => {
		const h = build({
			"t/dispatchChild": () => h.runtime.dispatch(child, "sub")
		});
		await h.runtime.dispatch(function* carriesOn(draft: IWorld): IActionGenerator {
			try {
				yield* ask("t/dispatchChild");
			} catch {}
			draft.Log.push("carried on");
		}, "root");
		await settled();
		expect(h.runtime.state.Log).toEqual([
			"carried on"
		]);
		expect(h.codes("action/refusal-swallowed")).toEqual([]);
	});

	it("stays quiet on an action that catches a refusal two dispatches deep and carries on", async () => {
		function* middle(): IActionGenerator {
			yield* ask("t/dispatchChild");
		}
		const runtime = createRuntime(
			{
				$Id: "root",
				Log: [] as string[],
				Middle: {
					$Id: "middle"
				},
				Child: {
					$Id: "child"
				}
			},
			{
				onError: () => {},
				implementations: {
					"t/dispatchChild": () => runtime.dispatch(child, "child"),
					"t/dispatchMiddle": () => runtime.dispatch(middle, "middle")
				}
			}
		);
		const swallowed: unknown[] = [];
		runtime.on("diag", (event) => {
			if (event.code === "action/refusal-swallowed") {
				swallowed.push(event.data);
			}
		});
		await runtime.dispatch(function* outer(draft: { Log: string[] }): IActionGenerator {
			try {
				yield* ask("t/dispatchMiddle");
			} catch {}
			draft.Log.push("carried on");
		}, "root");
		await settled();
		await settled();
		expect(runtime.state.Log).toEqual([
			"carried on"
		]);
		expect(swallowed).toEqual([]);
	});

	function registerRefusingFeed(h: ReturnType<typeof build>): void {
		(h.runtime as unknown as IResourceRegistrar).registerResourceType("t/refusingFeed", (_params, r) => {
			r.methods({
				go: () => Promise.reject(new OutsideActionError("handler()"))
			});
		});
	}

	function* callsRefusingFeed(draft: IWorld, rethrow: boolean): IActionGenerator {
		yield* openResourceAny(draft, "T/RefusingFeed", {
			Type: "t/refusingFeed"
		});
		try {
			yield* resourceAny(draft.$Id, "T/RefusingFeed").go!();
		} catch (error) {
			if (rethrow) {
				throw error;
			}
		}
	}

	it("reports a resource method handler's own refusal when the action swallows it", async () => {
		const h = build();
		registerRefusingFeed(h);
		await h.runtime.dispatch(callsRefusingFeed, "root", false);
		await settled();
		expect(h.codes("action/refusal-swallowed").map((diag) => diag.data)).toMatchObject([
			{
				actionName: "callsRefusingFeed",
				count: 1
			}
		]);
	});

	it("stays quiet on an action that catches another action's refusal through a resource method and carries on", async () => {
		const h = build();
		(h.runtime as unknown as IResourceRegistrar).registerResourceType("t/refusingFeed", (_params, r) => {
			r.methods({
				go: () => h.runtime.dispatch(child, "sub")
			});
		});
		await h.runtime.dispatch(callsRefusingFeed, "root", false);
		await settled();
		expect(h.codes("action/refusal-swallowed")).toEqual([]);
	});

	it("stays quiet on a resource method handler's own refusal the action rethrows", async () => {
		const h = build();
		registerRefusingFeed(h);
		const failure = await h.runtime.dispatch(callsRefusingFeed, "root", true).then(
			() => undefined,
			(error: unknown) => error
		);
		await settled();
		expect(isRefusal(failure)).toBe(true);
		expect(h.codes("action/refusal-swallowed")).toEqual([]);
	});

	it("reports an async implementation's own refusal when the action swallows it, and not when it rethrows it", async () => {
		const h = build({
			"t/refusesLater": async () => {
				const refusal = new OutsideActionError("impl()");
				await null;
				throw refusal;
			}
		});
		await h.runtime
			.dispatch(function* rethrows(): IActionGenerator {
				yield* ask("t/refusesLater");
			}, "root")
			.catch(() => {});
		await settled();
		expect(h.codes("action/refusal-swallowed")).toEqual([]);
		await h.runtime.dispatch(function* swallows(): IActionGenerator {
			try {
				yield* ask("t/refusesLater");
			} catch {}
		}, "root");
		await settled();
		expect(h.codes("action/refusal-swallowed").map((diag) => diag.data)).toMatchObject([
			{
				actionName: "swallows",
				count: 1
			}
		]);
	});

	const refuseNow = defineEffect<
		{
			Type: "t/refuseNow";
		},
		number
	>("t/refuseNow", {
		settles: "sync"
	});

	function* reconciles(draft: IWorld, rethrow: boolean): IActionGenerator {
		yield* reconcileRowsAny(
			draft.Rows,
			[
				{
					K: "a"
				}
			],
			(row) => row.K,
			{
				*add(item) {
					try {
						yield* refuseNow();
					} catch (error) {
						if (rethrow) {
							throw error;
						}
					}
					return {
						K: item.K
					};
				},
				update() {}
			}
		);
	}

	it("counts a copy of a refusal a settles: sync implementation made in the action's step as that refusal, so a rethrow clears it", async () => {
		const h = build({
			"t/refuseNow": () => {
				throw new OutsideActionError("impl()");
			}
		});
		const failure = await h.runtime.dispatch(reconciles, "root", true).then(
			() => undefined,
			(error: unknown) => error
		);
		await settled();
		expect(isRefusal(failure)).toBe(true);
		expect(h.codes("action/refusal-swallowed")).toEqual([]);
	});

	it("reports that refusal when the action swallows it", async () => {
		const h = build({
			"t/refuseNow": () => {
				throw new OutsideActionError("impl()");
			}
		});
		await h.runtime.dispatch(reconciles, "root", false);
		await settled();
		expect(h.codes("action/refusal-swallowed")).toHaveLength(1);
	});

	it("reports a refusal an implementation made outside any step when the action swallows it, and not when it rethrows it", async () => {
		const h = build({
			"t/refuses": () => Promise.reject(new TreflexRefusal("the implementation's own"))
		});
		await h.runtime.dispatch(function* swallows(): IActionGenerator {
			try {
				yield* ask("t/refuses");
			} catch {}
		}, "root");
		await settled();
		expect(h.codes("action/refusal-swallowed")).toHaveLength(1);
		await h.runtime
			.dispatch(function* rethrows(): IActionGenerator {
				try {
					yield* ask("t/refuses");
				} catch (error) {
					if (isRefusal(error)) {
						throw error;
					}
				}
			}, "root")
			.catch(() => {});
		await settled();
		expect(h.codes("action/refusal-swallowed")).toHaveLength(1);
	});

	it("stays quiet on an action that swallows a copy of its own refusal and then throws the original", async () => {
		let kept: OutsideActionError | undefined;
		const h = build({
			"t/rejectsKept": () => Promise.reject(kept)
		});
		const failure = await h.runtime
			.dispatch(function* throwsOriginal(): IActionGenerator {
				kept = new OutsideActionError("made in the step");
				try {
					yield* ask("t/rejectsKept");
				} catch {}
				throw kept;
			}, "root")
			.then(
				() => undefined,
				(error: unknown) => error
			);
		await settled();
		expect(failure).toBe(kept);
		expect(h.codes("action/refusal-swallowed")).toEqual([]);
	});

	it("stays quiet on an action that swallows a copy of a settles: sync implementation's refusal and then throws the original", async () => {
		let kept: OutsideActionError | undefined;
		const h = build({
			"t/refuseNow": () => {
				kept = new OutsideActionError("impl()");
				throw kept;
			}
		});
		const failure = await h.runtime
			.dispatch(function* throwsOriginal(draft: IWorld): IActionGenerator {
				yield* reconciles(draft, false);
				throw kept;
			}, "root")
			.then(
				() => undefined,
				(error: unknown) => error
			);
		await settled();
		expect(failure).toBe(kept);
		expect(h.codes("action/refusal-swallowed")).toEqual([]);
	});

	it("reports a refusal an implementation caches on the first action to swallow it only", async () => {
		const cached = new TreflexRefusal("cached");
		const h = build({
			"t/refusesCached": () => Promise.reject(cached)
		});
		await h.runtime.dispatch(function* first(): IActionGenerator {
			try {
				yield* ask("t/refusesCached");
			} catch {}
		}, "root");
		await h.runtime.dispatch(function* second(): IActionGenerator {
			try {
				yield* ask("t/refusesCached");
			} catch {}
		}, "root");
		await settled();
		expect(h.codes("action/refusal-swallowed").map((diag) => diag.data)).toMatchObject([
			{
				actionName: "first",
				count: 1
			}
		]);
	});

	it("stays quiet on every waiter of a refusal three dispatches deep, each holding a copy of a copy", async () => {
		const runtime = createRuntime(
			{
				$Id: "root",
				Log: [] as string[],
				One: {
					$Id: "one"
				},
				Two: {
					$Id: "two"
				},
				Three: {
					$Id: "three"
				}
			},
			{
				onError: () => {},
				implementations: {
					"t/dispatchOne": () => runtime.dispatch(passes("t/dispatchTwo"), "one"),
					"t/dispatchTwo": () => runtime.dispatch(passes("t/dispatchThree"), "two"),
					"t/dispatchThree": () => runtime.dispatch(child, "three")
				}
			}
		);
		function passes(type: string) {
			return function* passesOn(): IActionGenerator {
				yield* ask(type);
			};
		}
		const swallowed: unknown[] = [];
		runtime.on("diag", (event) => {
			if (event.code === "action/refusal-swallowed") {
				swallowed.push(event.data);
			}
		});
		let caught: unknown;
		await runtime.dispatch(function* outer(draft: { Log: string[] }): IActionGenerator {
			try {
				yield* ask("t/dispatchOne");
			} catch (error) {
				caught = error;
			}
			draft.Log.push("carried on");
		}, "root");
		await settled();
		await settled();
		expect(isRefusal(caught)).toBe(true);
		expect(runtime.state.Log).toEqual([
			"carried on"
		]);
		expect(swallowed).toEqual([]);
	});

	it("still reports the action's own refusal", async () => {
		const h = build({
			"t/echo": () => Promise.resolve("ok")
		});
		await h.runtime.dispatch(function* swallows(draft: IWorld): IActionGenerator {
			try {
				draft.Copy = draft.Node;
				yield* ask("t/echo");
			} catch {}
		}, "root");
		expect(h.codes("action/refusal-swallowed")).toHaveLength(1);
	});
});

describe("the form round trip", () => {
	function roundTrips(thrown: unknown): void {
		const form = serializeThrow(thrown);
		const rebuilt = rebuildThrow(form);
		expect(serializeThrow(rebuilt)).toEqual(form);
		const fromRecord = JSON.parse(JSON.stringify(form));
		expect(serializeThrow(rebuildThrow(fromRecord))).toEqual(form);
	}

	for (const Native of [
		Error,
		TypeError,
		RangeError,
		SyntaxError,
		ReferenceError,
		EvalError,
		URIError
	]) {
		it(`rebuilds ${Native.name} as itself`, () => {
			const original = new Native("broke");
			roundTrips(original);
			const rebuilt = rebuildThrow(serializeThrow(original));
			expect(Object.getPrototypeOf(rebuilt)).toBe(Native.prototype);
			expect(Object.prototype.toString.call(rebuilt)).toBe("[object Error]");
		});
	}

	it("rebuilds a DOMException with its name and code", () => {
		const original = new DOMException("stopped", "AbortError");
		roundTrips(original);
		const rebuilt = rebuildThrow(JSON.parse(JSON.stringify(serializeThrow(original)))) as DOMException;
		expect(rebuilt).toBeInstanceOf(DOMException);
		expect(rebuilt.name).toBe("AbortError");
		expect(rebuilt.code).toBe(20);
		expect(rebuilt.message).toBe("stopped");
	});

	it("rebuilds an AggregateError and its errors", () => {
		roundTrips(
			new AggregateError(
				[
					new TypeError("a"),
					new AggregateError(
						[
							"b"
						],
						"inner"
					)
				],
				"outer"
			)
		);
	});

	it.skipIf(!hasSuppressedError)("rebuilds a SuppressedError, its error and what it suppressed", () => {
		roundTrips(new SuppressedError(new TypeError("dispose"), new SuppressedError("inner", undefined, "nested"), "both"));
		const form = serializeThrow(new SuppressedError(new TypeError("dispose"), "body", "both"));
		expect(form).toMatchObject({
			Native: "SuppressedError",
			Error: {
				Thrown: "error",
				Native: "TypeError",
				Message: "dispose"
			},
			Suppressed: {
				Thrown: "value",
				Data: "body"
			}
		});
		const looped = new SuppressedError(undefined, undefined, "holds itself");
		looped.error = looped;
		roundTrips(looped);
	});

	it("reads and rebuilds the error and what it suppressed of a SuppressedError a compiler's helper made", async () => {
		const helperMade = Object.assign(new Error("both"), {
			name: "SuppressedError",
			error: new TypeError("dispose"),
			suppressed: new RangeError("body")
		});
		roundTrips(helperMade);
		const form = serializeThrow(helperMade);
		expect(form).not.toHaveProperty("Native");
		expect(form).not.toHaveProperty("Fields");
		expect(form).toMatchObject({
			Name: "SuppressedError",
			Error: {
				Native: "TypeError",
				Message: "dispose"
			},
			Suppressed: {
				Native: "RangeError",
				Message: "body"
			}
		});
		const h = build({
			"t/using": () => Promise.reject(helperMade)
		});
		const copy = (await caughtBy(h.runtime, "t/using")) as Error & {
			error: unknown;
			suppressed: unknown;
		};
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect(copy.name).toBe("SuppressedError");
		expect(Object.getPrototypeOf(copy.error)).toBe(TypeError.prototype);
		expect(Object.getPrototypeOf(copy.suppressed)).toBe(RangeError.prototype);
		expect(h.diags.filter((diag) => diag.code.startsWith("effect/"))).toEqual([]);
	});

	it("reads an error named SuppressedError with only one of the two as having fields", () => {
		const half = Object.assign(new Error("half"), {
			name: "SuppressedError",
			error: "dispose"
		});
		expect(serializeThrow(half)).toMatchObject({
			Fields: {
				error: "dispose"
			}
		});
		expect(serializeThrow(half)).not.toHaveProperty("Error");
	});

	it("rebuilds each WebAssembly error", () => {
		for (const Native of [
			WebAssembly.CompileError,
			WebAssembly.LinkError,
			WebAssembly.RuntimeError
		]) {
			const original = new Native("wasm");
			roundTrips(original);
			expect(Object.getPrototypeOf(rebuildThrow(serializeThrow(original)))).toBe(Native.prototype);
		}
	});

	it("leaves Error.stackTraceLimit as it was, a number or undefined", () => {
		const errorStatics = Error as {
			stackTraceLimit?: number;
		};
		const before = errorStatics.stackTraceLimit;
		try {
			errorStatics.stackTraceLimit = 7;
			rebuildThrow(serializeThrow(new Error("x")));
			expect(errorStatics.stackTraceLimit).toBe(7);
			errorStatics.stackTraceLimit = undefined;
			rebuildThrow(serializeThrow(new Error("x")));
			expect(errorStatics.stackTraceLimit).toBeUndefined();
		} finally {
			errorStatics.stackTraceLimit = before;
		}
	});

	it("leaves Error.stackTraceLimit as it was when the constructor throws", () => {
		const errorStatics = Error as {
			stackTraceLimit?: number;
		};
		const before = errorStatics.stackTraceLimit;
		const form = serializeThrow(new Error("x"));
		const construct = vi.spyOn(Reflect, "construct").mockImplementation(() => {
			throw new Error("construct failed");
		});
		try {
			errorStatics.stackTraceLimit = 7;
			expect(() => rebuildThrow(form)).toThrow("construct failed");
			expect(errorStatics.stackTraceLimit).toBe(7);
		} finally {
			construct.mockRestore();
			errorStatics.stackTraceLimit = before;
		}
	});

	it("rebuilds an app class with fields as its native base", () => {
		const original = new OfflineError("no network");
		roundTrips(original);
		const rebuilt = rebuildThrow(serializeThrow(original)) as OfflineError;
		expect(Object.getPrototypeOf(rebuilt)).toBe(TypeError.prototype);
		expect(rebuilt.retryIn).toBe(5);
	});

	it("follows a cause chain to the depth limit and no further", () => {
		let error: Error = new Error("bottom");
		for (let i = 0; i < NESTED_THROW_DEPTH + 3; i++) {
			error = new Error(`level ${i}`, {
				cause: error
			});
		}
		roundTrips(error);
		let form = serializeThrow(error);
		let depth = 0;
		while (form.Thrown === "error" && form.Cause !== undefined) {
			form = form.Cause;
			depth++;
		}
		expect(depth).toBe(NESTED_THROW_DEPTH);
	});

	function errorFormsIn(form: ISerializedThrow | undefined): number {
		if (form === undefined || form.Thrown !== "error") {
			return 0;
		}
		return (
			1 +
			errorFormsIn(form.Cause) +
			errorFormsIn(form.Error) +
			errorFormsIn(form.Suppressed) +
			(form.Errors ?? []).reduce((sum, item) => sum + errorFormsIn(item), 0)
		);
	}

	it("reads an error shared between branches no more than the total limit allows", () => {
		let reads = 0;
		const counted = (error: Error): Error => {
			void error.stack;
			const name = error.name;
			Object.defineProperty(error, "name", {
				get() {
					reads++;
					return name;
				},
				enumerable: false
			});
			return error;
		};
		let error = counted(new Error("leaf"));
		for (let level = 0; level < NESTED_THROW_DEPTH; level++) {
			error = counted(new AggregateError(Array(3).fill(error), `level ${level}`));
		}
		const form = serializeThrow(error);
		expect(reads).toBe(NESTED_THROW_COUNT + 1);
		expect(errorFormsIn(form)).toBe(NESTED_THROW_COUNT + 1);
	});

	it("round-trips a form the total limit cut short", () => {
		const shared = new RangeError("shared");
		const error = new AggregateError(
			Array.from(
				{
					length: NESTED_THROW_COUNT
				},
				(_, i) =>
					new TypeError(`item ${i}`, {
						cause: shared
					})
			),
			"wide"
		);
		const form = serializeThrow(error);
		expect(errorFormsIn(form)).toBe(NESTED_THROW_COUNT + 1);
		expect(form.Thrown === "error" && form.Errors!.length).toBe(NESTED_THROW_COUNT / 2);
		roundTrips(error);
	});

	it("reads an AggregateError's errors up to the total limit, whatever they are", () => {
		const values = new AggregateError(
			Array.from(
				{
					length: NESTED_THROW_COUNT + 50
				},
				(_, i) => `item ${i}`
			),
			"values"
		);
		const valuesForm = serializeThrow(values);
		expect(valuesForm.Thrown === "error" && valuesForm.Errors!.length).toBe(NESTED_THROW_COUNT);
		roundTrips(values);
		const holes: unknown[] = [];
		holes.length = 1_000_000;
		const sparse = new AggregateError(holes, "sparse");
		const sparseForm = serializeThrow(sparse);
		expect(sparseForm.Thrown === "error" && sparseForm.Errors!.length).toBe(NESTED_THROW_COUNT);
		roundTrips(sparse);
		let reads = 0;
		const claiming = new AggregateError([], "claims a length");
		Object.defineProperty(claiming, "errors", {
			value: new Proxy([], {
				get(target, key) {
					if (key === "length") {
						return 50_000_000;
					}
					if (typeof key === "string" && /^\d+$/.test(key)) {
						reads++;
						return undefined;
					}
					return Reflect.get(target, key);
				}
			}),
			configurable: true,
			writable: true
		});
		serializeThrow(claiming);
		expect(reads).toBe(NESTED_THROW_COUNT);
	});

	it("stops at an error already on the path", () => {
		const error = new Error("loops") as Error & {
			cause: unknown;
		};
		error.cause = error;
		const form = serializeThrow(error);
		expect(form).not.toHaveProperty("Cause");
		roundTrips(error);
		const aggregate = new AggregateError([], "holds itself");
		aggregate.errors.push(aggregate);
		roundTrips(aggregate);
	});

	it("carries a field with no JSON form as its JSON round trip", () => {
		const original = Object.assign(new Error("dated"), {
			at: new Date(0),
			drop: () => 1
		});
		const form = serializeThrow(original);
		expect(form).toMatchObject({
			Fields: {
				at: "1970-01-01T00:00:00.000Z"
			}
		});
		roundTrips(original);
	});

	it("gives a field named __proto__ as an own field", () => {
		const original = new Error("odd");
		Object.defineProperty(original, "__proto__", {
			value: {
				x: 1
			},
			enumerable: true
		});
		const rebuilt = rebuildThrow(JSON.parse(JSON.stringify(serializeThrow(original)))) as Error;
		expect(Object.getPrototypeOf(rebuilt)).toBe(Error.prototype);
		expect(Object.getOwnPropertyDescriptor(rebuilt, "__proto__")?.value).toEqual({
			x: 1
		});
		roundTrips(original);
	});

	it("round-trips a thrown value that isn't an Error", () => {
		roundTrips({
			Code: 1
		});
		roundTrips("text");
		roundTrips(undefined);
	});

	it("rebuilds one of treflex's classes as itself, without running its constructor", () => {
		const refused = vi.spyOn(runningStep, "refused");
		const original = new EntityGoneError("e1", "gone");
		roundTrips(original);
		const rebuilt = rebuildThrow(JSON.parse(JSON.stringify(serializeThrow(original)))) as EntityGoneError;
		expect(rebuilt).toBeInstanceOf(EntityGoneError);
		expect(rebuilt.id).toBe("e1");
		const refusal = new StateAliasError([], [], 0, "");
		refused.mockClear();
		roundTrips(refusal);
		const rebuiltRefusal = rebuildThrow(serializeThrow(refusal));
		expect(rebuiltRefusal).toBeInstanceOf(StateAliasError);
		expect(refused).not.toHaveBeenCalled();
	});
});

describe("a prototype chain that doesn't end", () => {
	const GIVE_UP = 100_000;

	function endless(): {
		head: object;
		steps: () => number;
	} {
		let steps = 0;
		const next = (): object =>
			new Proxy(
				{},
				{
					getPrototypeOf() {
						steps++;
						if (steps > GIVE_UP) {
							throw new Error("the walk did not stop");
						}
						return next();
					}
				}
			);
		return {
			head: next(),
			steps: () => steps
		};
	}

	it("reads an error whose chain goes on as an Error, within the bound, and reports nothing", async () => {
		const chain = endless();
		const error = Object.setPrototypeOf(new Error("deep"), chain.head) as Error;
		const form = serializeThrow(error);
		expect(chain.steps()).toBe(PROTOTYPE_WALK_STEPS);
		expect(form).toMatchObject({
			Thrown: "error",
			Message: "deep"
		});
		expect(form).not.toHaveProperty("Native");
		const h = build({
			"t/deep": () => Promise.reject(error)
		});
		const copy = (await caughtBy(h.runtime, "t/deep")) as Error;
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect(h.codes("effect/class-rejection")).toEqual([]);
		expect(chain.steps()).toBe(2 * PROTOTYPE_WALK_STEPS);
	});

	it("reads a value whose chain goes on as a value, within the bound", () => {
		const chain = endless();
		expect(serializeThrow(Object.setPrototypeOf({}, chain.head))).toEqual({
			Thrown: "value",
			Data: {}
		});
		expect(chain.steps()).toBe(PROTOTYPE_WALK_STEPS);
	});

	function looping(): {
		error: Error;
		steps: () => number;
	} {
		let steps = 0;
		const target = Object.create(null) as object;
		const loop = new Proxy(target, {
			getPrototypeOf(inner) {
				steps++;
				if (steps > GIVE_UP) {
					throw new Error("the walk did not stop");
				}
				return Reflect.getPrototypeOf(inner);
			}
		});
		Object.setPrototypeOf(target, loop);
		return {
			error: Object.setPrototypeOf(new Error("loops"), loop) as Error,
			steps: () => steps
		};
	}

	// Without Error.isError the error's tag can't be read through the loop, so it reads as a value.
	it("stops at a prototype it read before", () => {
		const looped = looping();
		expect([
			"error",
			"value"
		]).toContain(serializeThrow(looped.error).Thrown);
		expect(looped.steps()).toBe(1);
	});

	it.skipIf(!hasIsError)("reads an error whose chain comes back to a prototype as an Error", () => {
		expect(serializeThrow(looping().error)).toMatchObject({
			Thrown: "error",
			Message: "loops"
		});
	});
});

describe("a throw at the edges of what the copy reads", () => {
	const GIVE_UP = 1_000_000;
	const { carried, uncarried } = deepNestingDepths();

	function indexReads(answer: () => unknown): {
		errors: unknown[];
		reads: () => number;
	} {
		let reads = 0;
		return {
			errors: new Proxy([] as unknown[], {
				get(target, key) {
					if (key === "length") {
						return 2 ** 32 - 1;
					}
					if (typeof key === "string" && /^\d+$/.test(key)) {
						reads++;
						if (reads > GIVE_UP) {
							throw new Error("the read did not stop");
						}
						return answer();
					}
					return Reflect.get(target, key);
				}
			}),
			reads: () => reads
		};
	}

	it("reads at most the total limit of an AggregateError's errors when each is the aggregate itself", () => {
		const aggregate = new AggregateError([], "holds itself");
		const read = indexReads(() => aggregate);
		Object.defineProperty(aggregate, "errors", {
			value: read.errors
		});
		const form = serializeThrow(aggregate);
		expect(read.reads()).toBe(NESTED_THROW_COUNT);
		expect(form).toMatchObject({
			Thrown: "error",
			Errors: []
		});
		expect(serializeThrow(rebuildThrow(form))).toEqual(form);
	});

	it("reads at most the total limit of an AggregateError's errors when an array's prototype answers each with an ancestor", () => {
		const outer = new Error("outer");
		const aggregate = new AggregateError([], "inner");
		outer.cause = aggregate;
		let reads = 0;
		const errors: unknown[] = [];
		errors.length = 2 ** 32 - 1;
		Object.setPrototypeOf(
			errors,
			new Proxy(Array.prototype, {
				get(target, key, receiver) {
					if (typeof key === "string" && /^\d+$/.test(key)) {
						reads++;
						if (reads > GIVE_UP) {
							throw new Error("the read did not stop");
						}
						return outer;
					}
					return Reflect.get(target, key, receiver);
				}
			})
		);
		Object.defineProperty(aggregate, "errors", {
			value: errors
		});
		serializeThrow(outer);
		expect(reads).toBe(NESTED_THROW_COUNT);
	});

	it.skipIf(carried === undefined)(
		"gives a thrown value its JSON carries and nested too deep to compare as itself, and reports nothing",
		async () => {
			const h = build({
				"t/deep": () => Promise.reject(nest(carried!))
			});
			const caught = await caughtBy(h.runtime, "t/deep");
			expect(depthOf(caught)).toBe(carried);
			expect(h.codes("effect/class-rejection")).toEqual([]);
			expect(
				depthOf(
					(
						serializeThrow(nest(carried!)) as {
							Data?: unknown;
						}
					).Data
				)
			).toBe(carried);
		}
	);

	it.skipIf(carried === undefined)("keeps a field its JSON carries and nested too deep to compare, and reports nothing", async () => {
		const original = Object.assign(new Error("deep field"), {
			list: nest(carried!)
		});
		const h = build({
			"t/deep": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/deep")) as Error & {
			list: unknown;
		};
		expect(depthOf(copy.list)).toBe(carried);
		expect(h.diags.filter((diag) => diag.code.startsWith("effect/"))).toEqual([]);
	});

	it.skipIf(uncarried === undefined)("gives a thrown value nested too deep for JSON as undefined", async () => {
		const h = build({
			"t/deep": () => Promise.reject(nest(uncarried!))
		});
		expect(await caughtBy(h.runtime, "t/deep")).toBeUndefined();
		expect(serializeThrow(nest(uncarried!))).toEqual({
			Thrown: "value"
		});
	});

	it.skipIf(uncarried === undefined)("drops a field nested too deep for JSON, and reports it lost", async () => {
		const original = Object.assign(new Error("deep field"), {
			list: nest(uncarried!)
		});
		const h = build({
			"t/deep": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/deep")) as Error;
		expect(copy.message).toBe("deep field");
		expect(Object.hasOwn(copy, "list")).toBe(false);
		expect(h.codes("effect/rejection-field-lost").map((diag) => diag.data?.field)).toEqual([
			"list"
		]);
	});

	it("reads a field once, and keeps it when its check can't read it again", async () => {
		let fieldReads = 0;
		let innerReads = 0;
		const original = new Error("second read throws");
		Object.defineProperty(original, "data", {
			enumerable: true,
			get() {
				fieldReads++;
				return {
					get x() {
						innerReads++;
						if (innerReads > 1) {
							throw new Error("second read");
						}
						return 1;
					}
				};
			}
		});
		const h = build({
			"t/odd": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/odd")) as Error & {
			data: unknown;
		};
		expect(copy.data).toEqual({
			x: 1
		});
		expect(fieldReads).toBe(1);
		expect(h.codes("effect/rejection-field-lost")).toEqual([]);
	});

	it("still reports a Map field, whose JSON form is the same data as a plain object's", async () => {
		const original = Object.assign(new Error("mapped"), {
			lookup: new Map()
		});
		const h = build({
			"t/mapped": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/mapped")) as Error & {
			lookup: unknown;
		};
		expect(copy.lookup).toEqual({});
		expect(h.codes("effect/rejection-field-lost").map((diag) => diag.data?.field)).toEqual([
			"lookup"
		]);
	});

	it("rebuilds an AggregateError while Array.prototype[Symbol.iterator] throws", async () => {
		const original = new AggregateError(
			[
				new TypeError("inner")
			],
			"outer"
		);
		const form = serializeThrow(original);
		const iterate = Array.prototype[Symbol.iterator];
		let rebuilt: unknown;
		try {
			Array.prototype[Symbol.iterator] = () => {
				throw new Error("patched");
			};
			rebuilt = rebuildThrow(form);
		} finally {
			Array.prototype[Symbol.iterator] = iterate;
		}
		expect(rebuilt).toBeInstanceOf(AggregateError);
		const errors = Object.getOwnPropertyDescriptor(rebuilt, "errors");
		expect(errors).toMatchObject({
			enumerable: false,
			writable: true,
			configurable: true
		});
		expect(Object.getPrototypeOf((errors!.value as unknown[])[0])).toBe(TypeError.prototype);
		expect(serializeThrow(rebuilt)).toEqual(form);
	});

	it("throws the action a plain Error with the name and message when the copy can't be built", async () => {
		const original = new OfflineError("no network");
		const h = build({
			"t/save": () => Promise.reject(original)
		});
		const failure = new Error("construct failed");
		let caught: unknown = "nothing caught";
		await h.runtime.dispatch(function* catches(): IActionGenerator {
			const construct = vi.spyOn(Reflect, "construct").mockImplementation(() => {
				throw failure;
			});
			try {
				yield* ask("t/save");
			} catch (error) {
				caught = error;
			} finally {
				construct.mockRestore();
			}
		}, "root");
		expect(caught).not.toBe(original);
		expect(caught).not.toBe(failure);
		expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
		expect((caught as Error).name).toBe("OfflineError");
		expect((caught as Error).message).toBe("no network");
	});

	it("gives an error tagged DOMException with no DOMException up its chain as what its chain is", () => {
		const tagged = new TypeError("own tag");
		Object.defineProperty(tagged, Symbol.toStringTag, {
			value: "DOMException"
		});
		expect(serializeThrow(tagged)).toMatchObject({
			Native: "TypeError"
		});
		expect(Object.getPrototypeOf(rebuildThrow(serializeThrow(tagged)))).toBe(TypeError.prototype);
		class Tagged extends Error {
			get [Symbol.toStringTag]() {
				return "DOMException";
			}
		}
		const form = serializeThrow(new Tagged("class tag"));
		expect(form).not.toHaveProperty("Native");
		expect(Object.getPrototypeOf(rebuildThrow(form))).toBe(Error.prototype);
	});

	it("doesn't take this realm's own native, set as a prototype's constructor, for the error's type", async () => {
		const original = Object.setPrototypeOf(new Error("faked"), {
			constructor: TypeError
		}) as Error;
		expect(serializeThrow(original)).not.toHaveProperty("Native");
		const h = build({
			"t/faked": () => Promise.reject(original)
		});
		const copy = await caughtBy(h.runtime, "t/faked");
		expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
		expect(h.codes("effect/class-rejection").map((diag) => diag.data?.arrivedAs)).toEqual([
			"Error"
		]);
	});

	it("reports a thrown value the check can't read: a getter that throws, and a revoked proxy", async () => {
		const revocable = Proxy.revocable({}, {});
		revocable.revoke();
		for (const thrown of [
			{
				get broken(): number {
					throw new Error("no read");
				}
			},
			revocable.proxy
		]) {
			const h = build({
				"t/unreadable": () => Promise.reject(thrown)
			});
			expect(await caughtBy(h.runtime, "t/unreadable")).toBeUndefined();
			expect(h.codes("effect/class-rejection").map((diag) => diag.data?.className)).toEqual([
				"Object"
			]);
		}
	});
});

describe("the record holds what the action saw", () => {
	function withoutStacks(form: ISerializedThrow): unknown {
		if (form.Thrown !== "error") {
			return form;
		}
		const { Stack: _stack, Cause, Errors, ...rest } = form;
		return {
			...rest,
			...(Cause === undefined
				? {}
				: {
						Cause: withoutStacks(Cause)
					}),
			...(Errors === undefined
				? {}
				: {
						Errors: Errors.map(withoutStacks)
					})
		};
	}

	async function recorded(rejection: unknown) {
		const h = build({
			"t/save": () => Promise.reject(rejection)
		});
		const records: IRecord[] = [];
		h.runtime.on("record", (record) => records.push(record));
		const caught = await caughtBy(h.runtime, "t/save");
		const response = records.find((record) => record.Kind === "response") as {
			Error: ISerializedThrow;
		};
		expect(withoutStacks(response.Error)).toEqual(withoutStacks(serializeThrow(rejection)));
		const rebuilt = rebuildThrow(JSON.parse(JSON.stringify(response.Error)));
		return {
			caught,
			rebuilt
		};
	}

	function expectSame(rebuilt: unknown, caught: unknown): void {
		expect(Object.getPrototypeOf(rebuilt)).toBe(Object.getPrototypeOf(caught));
		const a = rebuilt as Error;
		const b = caught as Error;
		expect(a.name).toBe(b.name);
		expect(a.message).toBe(b.message);
		expect({
			...a
		}).toEqual({
			...b
		});
		expect(serializeThrow(a)).toEqual(serializeThrow(b));
		if (b.cause !== undefined) {
			expectSame(a.cause, b.cause);
		}
	}

	it("for an app class with fields and a cause", async () => {
		const { caught, rebuilt } = await recorded(conflict());
		expectSame(rebuilt, caught);
	});

	it("for a native error", async () => {
		const { caught, rebuilt } = await recorded(new RangeError("too far"));
		expectSame(rebuilt, caught);
	});

	it("for one of treflex's classes", async () => {
		const { caught, rebuilt } = await recorded(new EntityGoneError("e1", "gone"));
		expect(rebuilt).toBeInstanceOf(EntityGoneError);
		expectSame(rebuilt, caught);
	});
});

describe("the copy adds no promise hop", () => {
	it("settles a rejection ahead of a resolution parked after it, as before", async () => {
		const h = build({
			"t/fails": () => Promise.reject(new Error("down")),
			"t/echo": () => Promise.resolve("ok")
		});
		await h.runtime.dispatch(function* fansOut(draft: IWorld): IActionGenerator {
			yield* parallelSettled(
				(function* (): IActionGenerator {
					try {
						yield* ask("t/fails");
					} catch {
						draft.Log.push("rejected");
					}
				})(),
				(function* (): IActionGenerator {
					yield* ask("t/echo");
					draft.Log.push("resolved");
				})()
			);
		}, "root");
		expect(h.runtime.state.Log).toEqual([
			"rejected",
			"resolved"
		]);
	});
});

describe("the copy's stack", () => {
	it("is read from the original when the copy's is first read, not when the copy is made", async () => {
		const original = new Error("down");
		const stack = vi.fn(() => "Error: down\n    at somewhere");
		Object.defineProperty(original, "stack", {
			get: stack,
			configurable: true
		});
		const h = build({
			"t/fails": () => Promise.reject(original)
		});
		const copy = (await caughtBy(h.runtime, "t/fails")) as Error;
		expect(stack).not.toHaveBeenCalled();
		expect(copy.stack).toBe("Error: down\n    at somewhere");
		expect(copy.stack).toBe("Error: down\n    at somewhere");
		expect(stack).toHaveBeenCalledTimes(1);
	});

	async function copyOf(stack: string): Promise<Error> {
		const original = new Error("down");
		Object.defineProperty(original, "stack", {
			value: stack,
			configurable: true
		});
		const h = build({
			"t/fails": () => Promise.reject(original)
		});
		return (await caughtBy(h.runtime, "t/fails")) as Error;
	}

	it("reads on a frozen copy without throwing, and stays an accessor", async () => {
		const copy = Object.freeze(await copyOf("Error: down\n    at frozen"));
		expect(copy.stack).toBe("Error: down\n    at frozen");
		expect(copy.stack).toBe("Error: down\n    at frozen");
		expect(Object.getOwnPropertyDescriptor(copy, "stack")?.get).toBeTypeOf("function");
	});

	it("reads and takes an assignment on a sealed copy", async () => {
		const copy = Object.seal(await copyOf("Error: down\n    at sealed"));
		expect(copy.stack).toBe("Error: down\n    at sealed");
		copy.stack = "replaced";
		expect(copy.stack).toBe("replaced");
	});

	it("gives back what was assigned, read before or not", async () => {
		const unread = await copyOf("Error: down\n    at unread");
		unread.stack = "replaced";
		expect(unread.stack).toBe("replaced");
		const read = await copyOf("Error: down\n    at read");
		expect(read.stack).toBe("Error: down\n    at read");
		read.stack = "replaced";
		expect(read.stack).toBe("replaced");
	});
});

describe("the diags", () => {
	it("reports a class that can't cross once per name, naming the class and the effect", async () => {
		const h = build({
			"t/save": () => Promise.reject(conflict()),
			"t/other": () => Promise.reject(conflict()),
			"t/offline": () => Promise.reject(new OfflineError("no network")),
			"t/plain": () => Promise.reject(new TypeError("plain"))
		});
		await caughtBy(h.runtime, "t/save");
		await caughtBy(h.runtime, "t/save");
		await caughtBy(h.runtime, "t/other");
		await caughtBy(h.runtime, "t/offline");
		await caughtBy(h.runtime, "t/plain");
		expect(h.codes("effect/class-rejection").map((diag) => diag.data)).toEqual([
			{
				effectType: "t/save",
				className: "ConflictError",
				arrivedAs: "Error"
			},
			{
				effectType: "t/offline",
				className: "OfflineError",
				arrivedAs: "TypeError"
			}
		]);
	});

	it("reports each field the JSON round trip drops or changes, once per name and field, and nothing throws", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const original = (): Error => {
			const error = Object.assign(new Error("odd fields"), {
				at: new Date(0),
				ids: new Map(),
				cyclic,
				kept: 1
			});
			Object.defineProperty(error, "unreadable", {
				get() {
					throw new Error("no");
				},
				enumerable: true
			});
			return error;
		};
		const h = build({
			"t/odd": () => Promise.reject(original())
		});
		const copy = (await caughtBy(h.runtime, "t/odd")) as Error & Record<string, unknown>;
		await caughtBy(h.runtime, "t/odd");
		expect(copy.message).toBe("odd fields");
		expect(copy.at).toBe("1970-01-01T00:00:00.000Z");
		expect(copy.ids).toEqual({});
		expect(copy).not.toHaveProperty("cyclic");
		expect(copy).not.toHaveProperty("unreadable");
		expect(copy.kept).toBe(1);
		expect(h.codes("effect/rejection-field-lost").map((diag) => diag.data)).toEqual([
			{
				effectType: "t/odd",
				name: "Error",
				field: "at"
			},
			{
				effectType: "t/odd",
				name: "Error",
				field: "ids"
			},
			{
				effectType: "t/odd",
				name: "Error",
				field: "cyclic"
			},
			{
				effectType: "t/odd",
				name: "Error",
				field: "unreadable"
			}
		]);
	});

	it("reports a value that isn't an object and has no JSON form once per type, named by its type", async () => {
		const h = build({
			"t/arrow": () => Promise.reject(() => 1),
			"t/function": () => Promise.reject(function named() {}),
			"t/symbol": () => Promise.reject(Symbol("s")),
			"t/bigint": () => Promise.reject(5n),
			"t/nan": () => Promise.reject(Number.NaN),
			"t/text": () => Promise.reject("text"),
			"t/undefined": () => Promise.reject(undefined)
		});
		const copies: unknown[] = [];
		for (const type of [
			"t/arrow",
			"t/function",
			"t/symbol",
			"t/bigint",
			"t/nan",
			"t/text",
			"t/undefined"
		]) {
			copies.push(await caughtBy(h.runtime, type));
		}
		expect(copies).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			null,
			"text",
			undefined
		]);
		expect(h.codes("effect/class-rejection").map((diag) => diag.data)).toEqual(
			[
				"t/arrow",
				"t/symbol",
				"t/bigint",
				"t/nan"
			].map((effectType, i) => ({
				effectType,
				className: [
					"function",
					"symbol",
					"bigint",
					"number"
				][i],
				arrivedAs: "JSON"
			}))
		);
		expect(h.codes("effect/class-rejection")[0]!.message).toContain("rejected with a function,");
	});

	it("leaves out a field of the error's cause: the thrown error's own fields only", async () => {
		const h = build({
			"t/odd": () =>
				Promise.reject(
					new Error("outer", {
						cause: Object.assign(new Error("inner"), {
							at: new Date(0)
						})
					})
				)
		});
		const copy = (await caughtBy(h.runtime, "t/odd")) as Error;
		expect((copy.cause as Record<string, unknown>).at).toBe("1970-01-01T00:00:00.000Z");
		expect(h.codes("effect/rejection-field-lost")).toEqual([]);
	});
});

describe("a -0 crosses as 0", () => {
	it("for a result, an argument, an effect input and a read", async () => {
		const inputs: unknown[] = [];
		const h = build({
			"t/zero": (effect: { Input: number }) => {
				inputs.push(effect.Input);
				return Promise.resolve({
					Z: -0
				});
			}
		});
		await h.runtime.dispatch(function* sets(draft: IWorld): IActionGenerator {
			draft.N = -0;
		}, "root");
		expect(Object.is(h.runtime.state.N, -0)).toBe(true);
		function* readN(state: IWorld): ISelectorGenerator<number> {
			return state.N;
		}
		const seen: unknown[] = [];
		await h.runtime.dispatch(
			function* crosses(_draft: IWorld, arg: number): IActionGenerator {
				seen.push(arg);
				const result: {
					Z: number;
				} = yield* ask("t/zero", {
					Input: -0
				});
				seen.push(result.Z);
				seen.push(yield* select(readN));
			},
			"root",
			-0
		);
		expect(seen.map((value) => Object.is(value, 0))).toEqual([
			true,
			true,
			true
		]);
		expect(Object.is(inputs[0], 0)).toBe(true);
	});

	it("for an answer to an ask", async () => {
		const h = build();
		let reply: unknown;
		const asking = h.runtime.dispatch(function* asks(draft: IWorld) {
			reply = yield* open(
				askEntity<{
					Z: number;
				}>(draft.Sub, {
					Path: "Zero"
				})
			);
		}, "root");
		await tick();
		const id = pendingAsksOf(h.runtime, h.runtime.state)[0]!.Id;
		await h.runtime.dispatch(function* answers(): IActionGenerator {
			yield* answer(id as never, {
				Z: -0
			});
		}, "sub");
		await asking;
		expect(
			Object.is(
				(
					reply as {
						Z: number;
					}
				).Z,
				0
			)
		).toBe(true);
	});

	it("for a timer's payload", async () => {
		vi.useFakeTimers();
		try {
			const h = build();
			const heard: unknown[] = [];
			const Ticks = receiver<IWorld>("t/zeroTicks")({
				*"T/ZeroTick"(
					_draft: IWorld,
					event: {
						Z: number;
					}
				) {
					heard.push(event.Z);
				}
			} as never);
			h.runtime.registerReceiver(Ticks);
			await h.runtime.dispatch(function* arms(draft: IWorld): IActionGenerator {
				yield* startTimerAny(draft, "T/ZeroTick", Ticks, 1000, {
					Z: -0
				});
			}, "root");
			await vi.advanceTimersByTimeAsync(1100);
			expect(heard).toHaveLength(1);
			expect(Object.is(heard[0], 0)).toBe(true);
			h.runtime.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("for a publish payload", async () => {
		const h = build();
		const heard: unknown[] = [];
		const Listener = receiver<IWorld>("t/zeroListener")({
			*"T/ZeroSaid"(
				_draft: IWorld,
				event: {
					Z: number;
				}
			) {
				heard.push(event.Z);
			}
		} as never);
		h.runtime.registerReceiver(Listener);
		await h.runtime.dispatch(function* listens(draft: IWorld): IActionGenerator {
			bind(draft.Sub as never, Listener as never);
		}, "root");
		await h.runtime.dispatch(function* says(): IActionGenerator {
			yield* publishAny("T/ZeroSaid", {
				Z: -0
			});
		}, "root");
		await settled();
		expect(heard).toHaveLength(1);
		expect(Object.is(heard[0], 0)).toBe(true);
	});

	function withFeed(h: ReturnType<typeof build>, topic: string, heard: unknown[]) {
		const Feed = receiver<IWorld>(`${topic}Receiver`)({
			*[topic](_draft: IWorld, event: unknown) {
				heard.push(event);
			}
		} as never);
		h.runtime.registerReceiver(Feed);
		const feed: {
			emit?: (message: unknown) => Promise<void>;
			args: unknown[];
		} = {
			args: []
		};
		(h.runtime as unknown as IResourceRegistrar).registerResourceType(topic.toLowerCase(), (_params, r) => {
			feed.emit = (message) => r.emit(message);
			r.methods({
				echo(_ctx: unknown, n: number) {
					feed.args.push(n);
					return -0;
				}
			});
		});
		return {
			Feed,
			feed
		};
	}

	it("for a resource method's arguments and result, and a resource's emit", async () => {
		const h = build();
		const heard: unknown[] = [];
		const { Feed, feed } = withFeed(h, "T/ZeroFeed", heard);
		await h.runtime.dispatch(function* opens(draft: IWorld): IActionGenerator {
			yield* openResourceAny(draft, "T/ZeroFeed", Feed, {
				Type: "t/zerofeed"
			});
		}, "root");
		await settled();
		await feed.emit!({
			Z: -0
		});
		await settled();
		let result: unknown;
		await h.runtime.dispatch(function* calls(draft: IWorld): IActionGenerator {
			result = yield* resourceAny(draft.$Id, "T/ZeroFeed").echo!(-0);
		}, "root");
		expect(
			Object.is(
				(
					heard[0] as {
						Z: number;
					}
				).Z,
				0
			)
		).toBe(true);
		expect(Object.is(feed.args[0], 0)).toBe(true);
		expect(Object.is(result, 0)).toBe(true);
	});

	it("copies a frozen payload that crosses twice once: a resource's emit and the dispatch to its receiver", async () => {
		const h = build();
		const heard: unknown[] = [];
		const { Feed, feed } = withFeed(h, "T/CountFeed", heard);
		await h.runtime.dispatch(function* opens(draft: IWorld): IActionGenerator {
			yield* openResourceAny(draft, "T/CountFeed", Feed, {
				Type: "t/countfeed"
			});
		}, "root");
		await settled();
		const rows = Array.from(
			{
				length: 20
			},
			(_, i) => ({
				Counted: true,
				I: i
			})
		);
		const freeze = vi.spyOn(Object, "freeze");
		await feed.emit!({
			Rows: rows
		});
		await settled();
		const copied = freeze.mock.calls.filter(
			([value]) =>
				(
					value as
						| {
								Counted?: unknown;
						  }
						| undefined
				)?.Counted === true
		).length;
		freeze.mockRestore();
		expect(
			(
				heard[0] as {
					Rows: unknown[];
				}
			).Rows
		).toHaveLength(20);
		expect(copied).toBe(20);
	});

	it("for a reconcileRows row, which the state then holds", async () => {
		const h = build();
		await h.runtime.dispatch(function* refreshes(draft: IWorld): IActionGenerator {
			yield* reconcileRowsAny(
				draft.Rows,
				[
					{
						K: "a",
						V: -0
					}
				],
				(row) => row.K,
				{
					update(row, item) {
						row.V = item.V;
					}
				}
			);
		}, "root");
		expect(Object.is(h.runtime.state.Rows[0]?.V, 0)).toBe(true);
	});

	it("shares an unwritten transient's default that holds none with an action that reads it, and reports no copy", async () => {
		const h = build();
		const rows = Array.from(
			{
				length: 12_000
			},
			(_, i) => ({
				I: i
			})
		);
		function* slot(state: IWorld): ISelectorGenerator<{
			Rows: {
				I: number;
			}[];
		}> {
			return yield* transient(state, "t/largeSlot", {
				Rows: rows
			});
		}
		const outside = h.runtime.processSelector(slot, () => h.runtime.state);
		expect(isFrozenCopy(outside)).toBe(true);
		let inside: unknown;
		await h.runtime.dispatch(function* reads(): IActionGenerator {
			inside = yield* select(slot);
		}, "root");
		expect(inside).toEqual(outside);
		expect(isFrozenCopy(inside)).toBe(true);
		expect(h.codes("action/large-read-copy")).toEqual([]);
	});

	it("but not for an unwritten transient a selector reads, before or after another field is written", async () => {
		const h = build();
		function* slot(state: IWorld): ISelectorGenerator<{
			Z: number;
			N: number;
		}> {
			return yield* transient(state, "t/zeroSlot", {
				Z: -0,
				N: 0
			});
		}
		const read = () => h.runtime.processSelector(slot, () => h.runtime.state);
		const unwritten = read();
		expect(Object.is(unwritten.Z, -0)).toBe(true);
		expect(Object.isFrozen(unwritten)).toBe(true);
		expect(isFrozenCopy(unwritten)).toBe(false);
		let passed: unknown;
		await h.runtime.dispatch(
			function* writes(
				draft: IWorld,
				given: {
					Z: number;
				}
			): IActionGenerator {
				passed = given;
				const held = yield* transient(draft, "t/zeroSlot", {
					Z: -0,
					N: 0
				});
				held.N = 1;
			},
			"root",
			unwritten
		);
		expect(passed).not.toBe(unwritten);
		expect(
			Object.is(
				(
					passed as {
						Z: number;
					}
				).Z,
				0
			)
		).toBe(true);
		const written = read();
		expect(written.N).toBe(1);
		expect(Object.is(written.Z, -0)).toBe(true);
	});
});
