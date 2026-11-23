import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeThrow, UNREADABLE } from "../../src/Utility/serializeThrow";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("serializeThrow", () => {
	it("serializes an Error: name, message, and stack land on the record", () => {
		const original = new TypeError("boom");
		const record = serializeThrow(original);
		expect(record).toEqual({
			Thrown: "error",
			Name: "TypeError",
			Message: "boom",
			Stack: original.stack,
			Native: "TypeError"
		});
	});

	it("omits Fields entirely for an Error with no custom fields", () => {
		const record = serializeThrow(new Error("plain"));
		expect(record).not.toHaveProperty("Fields");
		expect(Object.keys(record).sort()).toEqual([
			"Message",
			"Name",
			"Stack",
			"Thrown"
		]);
	});

	it("captures enumerable own data fields on an Error", () => {
		const original = Object.assign(new Error("boom"), {
			status: 404,
			code: "NOT_FOUND",
			detail: {
				Url: "/api/x"
			}
		});
		const record = serializeThrow(original);
		expect(record).toEqual({
			Thrown: "error",
			Name: "Error",
			Message: "boom",
			Stack: original.stack,
			Fields: {
				status: 404,
				code: "NOT_FOUND",
				detail: {
					Url: "/api/x"
				}
			}
		});
	});

	it("owns its fields: the record is a clone of the thrown error's data", () => {
		const detail = {
			N: 1
		};
		const original = Object.assign(new Error("boom"), {
			detail
		});
		const record = serializeThrow(original);
		detail.N = 2;
		expect(record).toMatchObject({
			Fields: {
				detail: {
					N: 1
				}
			}
		});
	});

	it("drops unserializable fields silently, keeping the serializable ones", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const original = Object.assign(new Error("boom"), {
			status: 500,
			retry: () => {},
			cycle: circular,
			nothing: undefined
		});
		const record = serializeThrow(original);
		expect(record).toEqual({
			Thrown: "error",
			Name: "Error",
			Message: "boom",
			Stack: original.stack,
			Fields: {
				status: 500
			}
		});
		// Lossy Error fields drop without the non-Error warning.
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not duplicate an assigned name/message/stack into Fields", () => {
		// Assignment makes these own-enumerable on the instance — they must
		// stay with their dedicated keys, not ride Fields as well.
		const original = new Error("first");
		original.name = "CustomError";
		original.message = "boom";
		original.stack = "fake-stack";
		const record = serializeThrow(original);
		expect(record).toEqual({
			Thrown: "error",
			Name: "CustomError",
			Message: "boom",
			Stack: "fake-stack"
		});
	});

	it("an assigned-name error re-serializes stably: Name stays dedicated, no Fields appears", () => {
		const error = new Error("legacy");
		error.name = "TypeError";
		error.stack = "legacy-stack";
		expect(serializeThrow(error)).toEqual({
			Thrown: "error",
			Name: "TypeError",
			Message: "legacy",
			Stack: "legacy-stack"
		});
	});

	// The header's promise, exercised. An Error subclass that computes a
	// field from state the failure left unset faults on the read, and V8
	// formats `stack` lazily, so it reads `message` again. Anything that
	// escaped here would mask the error the caller was actually handed.
	function faulting(): Error {
		const error = new Error("never read");
		for (const key of [
			"name",
			"message",
			"stack"
		]) {
			Object.defineProperty(error, key, {
				get() {
					throw new Error(`${key} getter faulted`);
				},
				configurable: true
			});
		}
		return error;
	}

	it("never throws when the error's own getters fault", () => {
		const record = serializeThrow(faulting());
		expect(record).toEqual({
			Thrown: "error",
			Name: UNREADABLE,
			Message: UNREADABLE
		});
		// Not "Error": a consumer branching on Name must be able to tell an
		// unreadable one from a plain Error's.
		expect(record).not.toMatchObject({
			Name: "Error"
		});
	});

	it("loses only the field that faulted", () => {
		const error = new Error("still readable");
		// Read first: V8 formats `stack` lazily and reads `name` while it
		// does, so once the getter below is installed even this assertion
		// cannot ask for it.
		const stack = error.stack;
		Object.defineProperty(error, "name", {
			get() {
				throw new Error("name getter faulted");
			},
			configurable: true
		});
		expect(serializeThrow(error)).toMatchObject({
			Thrown: "error",
			Name: UNREADABLE,
			Message: "still readable",
			Stack: stack
		});
	});

	it("keeps the record when the error refuses ownKeys", () => {
		const hostile = new Proxy(new Error("boom"), {
			ownKeys() {
				throw new Error("ownKeys refused");
			}
		});
		const record = serializeThrow(hostile);
		expect(record).toMatchObject({
			Thrown: "error",
			Name: "Error",
			Message: "boom"
		});
		expect(record).not.toHaveProperty("Fields");
	});

	it("takes the value branch when instanceof cannot be established", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const hostile = new Proxy(
			{
				Code: 1
			},
			{
				getPrototypeOf() {
					throw new Error("getPrototypeOf refused");
				}
			}
		);
		expect(serializeThrow(hostile)).toEqual({
			Thrown: "value",
			Data: {
				Code: 1
			}
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("never throws when the console itself throws", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {
			throw new Error("console patched by a hostile page");
		});
		expect(
			serializeThrow({
				fn: () => {}
			})
		).toEqual({
			Thrown: "value",
			Data: {}
		});
	});

	it("serializes a plain-value throw without warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const record = serializeThrow({
			Code: 404,
			Reason: "missing"
		});
		expect(record).toEqual({
			Thrown: "value",
			Data: {
				Code: 404,
				Reason: "missing"
			}
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("owns its data: the record is a clone, not the thrown reference", () => {
		const thrown = {
			Code: 1
		};
		const record = serializeThrow(thrown);
		thrown.Code = 2;
		expect(record).toEqual({
			Thrown: "value",
			Data: {
				Code: 1
			}
		});
	});

	it("warns (never throws) on a lossy non-Error value", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const record = serializeThrow({
			fn: () => {}
		});
		expect(record).toEqual({
			Thrown: "value",
			Data: {}
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("does not survive JSON");
	});

	it("warns (never throws) on a circular value", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const record = serializeThrow(circular);
		expect(record).toEqual({
			Thrown: "value",
			Data: undefined
		});
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
