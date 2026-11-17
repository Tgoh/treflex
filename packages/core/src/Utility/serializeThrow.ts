import { jsonEquals } from "./jsonEquals";

// What Name and Message carry when no usable value could be read off the
// error: the field was absent, it answered undefined, or its own getter
// threw. A consumer reads it as "no name was available" and never as a name
// to match. A hostile input can of course set the field to this string
// itself, so it separates the cases it can rather than proving anything.
export const UNREADABLE = "(unreadable)";

// A thrown value crossing a record boundary lands as data: journal error
// settlements, the Action/Error payload (a raw Error would fail
// the receiver's args-are-data contract), and diag data all carry this
// shape. Error instances keep name/message/stack plus their enumerable own
// data fields (`e.status`, `e.code` — the custom payload an API error
// carries); consumers match by name and fields, never `instanceof` — the
// record is data, not the original instance.
export type ISerializedThrow =
	| {
			Thrown: "error";
			// `UNREADABLE` where no usable value was read, whether the field
			// was absent, undefined, or its getter threw.
			Name: string;
			// `UNREADABLE` on the same terms.
			Message: string;
			// Absent on those same terms, which reads as an error carrying no
			// stack.
			Stack?: string;
			// Enumerable own data fields beyond name/message/stack, each a
			// lossy best-effort JSON clone (functions and unserializable
			// values drop silently — the codec's lossy discipline). Absent
			// when there are none.
			Fields?: Record<string, unknown>;
	  }
	| {
			Thrown: "value";
			// Absent for a thrown undefined (and for values that could not be
			// stringified at all) — absence rather than an undefined-valued
			// key, so the in-memory record and its JSON round-trip agree
			// field-for-field.
			Data?: unknown;
	  };

// Best-effort, and must never throw: serialization runs on the error path
// of layers the app does not control (effect implementations, transports),
// and a throwing serializer would mask the original failure with its own.
// Lossy non-Error throws warn instead — the journal still gets the closest
// JSON rendering, and the console points at the value that won't round-trip
// faithfully.
export function serializeThrow(thrown: unknown): ISerializedThrow {
	if (isErrorInstance(thrown)) {
		// Every read below can fault. A subclass can compute `name` or
		// `message` from state the failure left unset, and V8 formats `stack`
		// lazily, which reads `message` again. A faulting read costs its own
		// field and never the record.
		const record: ISerializedThrow = {
			Thrown: "error",
			Name: readErrorText(thrown, "name") ?? UNREADABLE,
			Message: readErrorText(thrown, "message") ?? UNREADABLE
		};
		const stack = readErrorText(thrown, "stack");
		if (stack !== undefined) {
			record.Stack = stack;
		}
		const fields = serializeErrorFields(thrown);
		if (fields !== undefined) {
			record.Fields = fields;
		}
		return record;
	}
	let data: unknown;
	let lossy = false;
	try {
		// Round-trip up front so the journal owns a clone (a held reference
		// could be mutated after the fact) and the loss is observable now,
		// at the throw site, rather than when a record is read back weeks later.
		const text = JSON.stringify(thrown);
		// JSON.stringify(undefined) is undefined, not a string — a thrown
		// undefined survives as an absent Data, which parses back to
		// undefined; that one is faithful, anything else that vanished
		// (functions, symbols) is not.
		data = text === undefined ? undefined : JSON.parse(text);
		lossy = !jsonEquals(thrown, data);
	} catch {
		// Circular or otherwise unstringifiable — record the absence.
		data = undefined;
		lossy = thrown !== undefined;
	}
	if (lossy) {
		try {
			console.warn(
				"[treflex] journal: a non-Error throw does not survive JSON serialization — its records (and the Action/Error " +
					"payload an error boundary hears) carry a different value than the live run saw. " +
					"Throw an Error or a plain-data value across effect boundaries.",
				thrown
			);
		} catch {
			// A patched or hostile console. The record is what the caller
			// needs; the narration about it is not.
		}
	}
	if (data === undefined) {
		return {
			Thrown: "value"
		};
	}
	return {
		Thrown: "value",
		Data: data
	};
}

// `instanceof` walks the prototype chain, which a proxy can refuse. A value
// whose kind cannot be established takes the value branch, where every read
// is already guarded.
function isErrorInstance(thrown: unknown): thrown is Error {
	try {
		return thrown instanceof Error;
	} catch {
		return false;
	}
}

// One of the three dedicated Error fields as text, or undefined when the
// property is absent or reading it throws. `String(value)` is inside the try
// because a non-string field can carry a throwing `toString` too.
function readErrorText(error: Error, key: "name" | "message" | "stack"): string | undefined {
	try {
		const value = error[key];
		if (value === undefined) {
			return undefined;
		}
		return typeof value === "string" ? value : String(value);
	} catch {
		return undefined;
	}
}

// Custom data fields on an Error instance — the enumerable own properties
// beyond name/message/stack (`message` and `stack` are own but
// non-enumerable on a normal Error; a body that ASSIGNED any of the three
// made it own-enumerable, and those stay with their dedicated keys). Each
// value takes a lossy best-effort JSON round-trip: the record must own a
// clone (a held reference could be mutated after the fact), and a field
// that cannot serialize — a function, a symbol, a circular object — drops
// silently, mirroring the codec's lossy discipline. Returns undefined when
// nothing survives, so the envelope omits Fields entirely.
function serializeErrorFields(error: Error): Record<string, unknown> | undefined {
	let fields: Record<string, unknown> | undefined;
	let keys: string[];
	try {
		keys = Object.keys(error);
	} catch {
		// A proxy refusing ownKeys. Same rule as the field reads: the loss is
		// the fields, not the record.
		return undefined;
	}
	for (const key of keys) {
		if (key === "name" || key === "message" || key === "stack") {
			continue;
		}
		try {
			const text = JSON.stringify((error as unknown as Record<string, unknown>)[key]);
			// JSON.stringify(undefined) is undefined, not a string — an
			// undefined-valued (or vanishing: function, symbol) field lands
			// as absence, which binds identically under property access.
			if (text === undefined) {
				continue;
			}
			fields ??= {};
			fields[key] = JSON.parse(text);
		} catch {
			// Circular, throwing toJSON, or otherwise unstringifiable —
			// dropped. Never throw: this runs on the error path.
		}
	}
	return fields;
}
