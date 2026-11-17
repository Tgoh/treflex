import type { IVersion } from "../Solid/host";
import { host } from "../Solid/host";
import { globalWeakMap } from "../Utility/globalWeakMap";

// The notebook: which reactive scope read which property of which raw
// object, as lazily created per-(object, key) versions. The view proxy
// (viewProxy.ts) calls the track* half from its read traps; the write
// gateway calls the notify* half at the recording proxy's set and delete
// traps. Storage is keyed by raw object in WeakMaps rather than stamped on
// the object as symbol properties, so raw nodes stay pristine for
// getOwnPropertySymbols callers.
//
// A version is created on the first TRACKED read of a key and never
// before: untracked reads (actions, effect implementations, handlers) pay
// one WeakMap lookup and nothing else, and an unobserved slot costs a
// write nothing but the lookups.

export interface ITracking {
	trackKey(target: object, key: PropertyKey): void;
	// $TRACK and ownKeys: the container's whole shape.
	trackShape(target: object): void;
	// The `in` operator.
	trackHas(target: object, key: PropertyKey): void;
	notifyKey(target: object, key: PropertyKey): void;
	notifyShape(target: object): void;
	notifyHas(target: object, key: PropertyKey): void;
}

interface IRecord {
	keys: Map<PropertyKey, IVersion>;
	shape: IVersion | null;
	has: Map<PropertyKey, IVersion> | null;
}

// On globalThis, like hmrRegistry's registry: a second evaluation of this
// module (a Vite duplicate load, an HMR re-evaluation) must find the same
// records or every live subscription is silently orphaned.
const records = globalWeakMap<object, IRecord>("__treflex_tracking_records__");

function recordFor(target: object): IRecord {
	let record = records.get(target);
	if (!record) {
		record = {
			keys: new Map(),
			shape: null,
			has: null
		};
		records.set(target, record);
	}
	return record;
}

// Ownerless, so a version born inside a memo's compute is not disposed
// with that memo's re-run.
function newVersion(): IVersion {
	return host.runUnowned(() => host.createVersion());
}

export const tracking: ITracking = {
	trackKey(target, key) {
		if (!host.isTracking()) {
			return;
		}
		const record = recordFor(target);
		let version = record.keys.get(key);
		if (!version) {
			version = newVersion();
			record.keys.set(key, version);
		}
		version.track();
	},
	trackShape(target) {
		if (!host.isTracking()) {
			return;
		}
		const record = recordFor(target);
		if (!record.shape) {
			record.shape = newVersion();
		}
		record.shape.track();
	},
	trackHas(target, key) {
		if (!host.isTracking()) {
			return;
		}
		const record = recordFor(target);
		if (!record.has) {
			record.has = new Map();
		}
		let version = record.has.get(key);
		if (!version) {
			version = newVersion();
			record.has.set(key, version);
		}
		version.track();
	},
	notifyKey(target, key) {
		records.get(target)?.keys.get(key)?.bump();
	},
	notifyShape(target) {
		records.get(target)?.shape?.bump();
	},
	notifyHas(target, key) {
		records.get(target)?.has?.get(key)?.bump();
	}
};

// The bumps one tree write implies, called after the write has landed on
// the raw object. Nothing bumps for a write that changed nothing (1.9's
// setProperty equality gate). Otherwise: the key, the container's shape
// (element replacement must re-run For), the has-version when the key
// appeared or vanished, and `length` when an array write moved it.
export function notifyWrite(target: object, key: PropertyKey, changed: boolean, presenceChanged: boolean, lengthChanged: boolean): void {
	if (!changed) {
		return;
	}
	const record = records.get(target);
	if (!record) {
		return;
	}
	record.keys.get(key)?.bump();
	record.shape?.bump();
	if (presenceChanged) {
		record.has?.get(key)?.bump();
	}
	if (lengthChanged) {
		record.keys.get("length")?.bump();
	}
}
