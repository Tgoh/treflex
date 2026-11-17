import type { IReactiveHost, IVersion } from "../Solid/host";
import type { IExternalAnswer } from "../Types/IRecord";
import { callbackThrew, type IDiagEmitter } from "../Types/IRuntimeEvent";
import { DEV } from "../Utility/devMode";
import { jsonExact } from "../Utility/jsonExact";
import { cloneStrict } from "../Utility/valueCodec";
import { NonPlainDataError } from "./nonPlainDataError";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/externals": IExternalTable;
	}
}

/** What `runtime.provideExternal` takes. See docs/reference/derived-reads.md#providing-a-value. */
export interface IExternalProvider<T> {
	/** The current value, plain data treated as immutable. Called at provide and after each change. */
	read(): T;
	/** Starts listening and calls `changed` on each change. Returns the function that stops listening. */
	subscribe?(changed: () => void): () => void;
	/** Whether two values `read` gave are the same. `Object.is` by default. */
	equals?(a: T, b: T): boolean;
	/** An action's read lands the key on its step record, and not the value. */
	redact?: boolean;
}

/** What `runtime.provideExternal` returns. */
export interface IExternalHandle {
	/** Calls the provider's `read` again, and re-runs the key's readers when the value differs. */
	changed(): void;
}

/** An action's read of a key, for its step record. */
export interface IExternalRead {
	readonly key: string;
	readonly provided: boolean;
	readonly redacted: boolean;
	/** The frozen copy the action received. */
	readonly value: unknown;
}

export interface IExternalPeek {
	readonly value: unknown;
	readonly provided: boolean;
	readonly redacted: boolean;
}

export interface IProvideOptions {
	/** Skips the development plain-data check, for a provider whose values are plain as it builds them. Not public. */
	plainByConstruction?: boolean;
}

export interface IExternalTable {
	provide(key: string, provider: IExternalProvider<unknown>, options?: IProvideOptions): IExternalHandle;
	/** A selector's read: tracks the key and answers the cached value. */
	read(key: string): unknown;
	/** An action's read: the cached value, untracked. */
	peek(key: string): IExternalPeek;
	dispose(): void;
}

interface IProvision {
	readonly key: string;
	readonly provider: IExternalProvider<unknown>;
	/** Whether a value `read` gives gets the development plain-data check. */
	readonly checked: boolean;
	live: boolean;
	stop: (() => void) | undefined;
}

interface IEntry {
	readonly version: IVersion;
	value: unknown;
	provision: IProvision | undefined;
}

function refuseNonPlain(key: string, value: unknown, when: string): void {
	const checked = cloneStrict(value);
	if (!checked.ok) {
		throw new NonPlainDataError(`provideExternal("${key}"): the value ${when}`, checked.kind, checked.path);
	}
}

export function createExternalTable(host: IReactiveHost, report: IDiagEmitter): IExternalTable {
	const entries = new Map<string, IEntry>();
	// Provide order, which dispose stops in.
	const provisions = new Set<IProvision>();
	const reportedUnprovided = new Set<string>();
	let disposed = false;

	function entryOf(key: string): IEntry {
		let entry = entries.get(key);
		if (!entry) {
			entry = {
				version: host.runUnowned(() => host.createVersion()),
				value: undefined,
				provision: undefined
			};
			entries.set(key, entry);
		}
		return entry;
	}

	function reportUnprovided(key: string, entry: IEntry): void {
		if (!DEV || entry.provision !== undefined || reportedUnprovided.has(key)) {
			return;
		}
		reportedUnprovided.add(key);
		host.untrack(() =>
			report({
				severity: "warn",
				code: "external/unprovided",
				message:
					`[treflex] external("${key}") was read and nothing provides "${key}", so it read undefined. Provide it with ` +
					"runtime.provideExternal in setup, the function a fresh boot and a restore both call (docs/reference/derived-reads.md#providing-a-value).",
				data: {
					key
				}
			})
		);
	}

	function stopProvision(provision: IProvision): void {
		provision.live = false;
		provisions.delete(provision);
		const stop = provision.stop;
		provision.stop = undefined;
		if (!stop) {
			return;
		}
		try {
			stop();
		} catch (error) {
			report(
				callbackThrew(`provideExternal("${provision.key}")'s subscription stop`, error, {
					key: provision.key
				})
			);
		}
	}

	function apply(provision: IProvision): void {
		if (!provision.live) {
			return;
		}
		const entry = entryOf(provision.key);
		host.untrack(() => {
			const provider = provision.provider;
			const value = provider.read();
			if (provision.checked) {
				refuseNonPlain(provision.key, value, "read after a change");
			}
			if (provider.equals ? provider.equals(entry.value, value) : Object.is(entry.value, value)) {
				return;
			}
			host.batch(() => {
				entry.value = value;
				entry.version.bump();
			});
		});
	}

	function provide(key: string, provider: IExternalProvider<unknown>, options?: IProvideOptions): IExternalHandle {
		if (disposed) {
			throw new Error(
				`[treflex] provideExternal("${key}"): the runtime has been disposed, so nothing is provided. Provide on the runtime that replaced it.`
			);
		}
		const checked = DEV && options?.plainByConstruction !== true;
		const first = host.untrack(() =>
			host.runUnowned(() => {
				const value = provider.read();
				if (checked) {
					refuseNonPlain(key, value, "read at provide");
				}
				return value;
			})
		);
		const entry = entryOf(key);
		const replaced = entry.provision;
		if (replaced) {
			stopProvision(replaced);
			report({
				severity: "warn",
				code: "external/replaced",
				message:
					`[treflex] provideExternal("${key}") was called while "${key}" was already provided. The first provider's ` +
					"subscription is stopped and its handle does nothing, and readers re-run on the new value.",
				data: {
					key
				}
			});
		}
		const provision: IProvision = {
			key,
			provider,
			checked,
			live: true,
			stop: undefined
		};
		provisions.add(provision);
		entry.provision = provision;
		host.batch(() => {
			entry.value = first;
			entry.version.bump();
		});
		const changed = (): void => {
			if (!provision.live) {
				return;
			}
			// A change made while a computation runs could be lost to it or re-enter it.
			if (host.isTracking()) {
				queueMicrotask(() => apply(provision));
				return;
			}
			apply(provision);
		};
		const subscribe = provider.subscribe;
		if (subscribe) {
			const stop = host.untrack(() => host.runUnowned(() => subscribe.call(provider, changed)));
			// subscribe can replace this provider, or dispose the runtime, before it returns.
			if (provision.live) {
				provision.stop = stop;
			} else {
				stop();
			}
		}
		return {
			changed
		};
	}

	function read(key: string): unknown {
		const entry = entryOf(key);
		entry.version.track();
		reportUnprovided(key, entry);
		return entry.value;
	}

	function peek(key: string): IExternalPeek {
		const entry = entryOf(key);
		reportUnprovided(key, entry);
		return {
			value: entry.value,
			provided: entry.provision !== undefined,
			redacted: entry.provision?.provider.redact === true
		};
	}

	function dispose(): void {
		disposed = true;
		for (const provision of [
			...provisions
		]) {
			stopProvision(provision);
		}
	}

	return {
		provide,
		read,
		peek,
		dispose
	};
}

export function externalAnswer(read: IExternalRead): IExternalAnswer {
	if (read.redacted) {
		return {
			Key: read.key,
			Redacted: true
		};
	}
	// An absent Value reads undefined, which is what the action got.
	if (!read.provided || read.value === undefined) {
		return {
			Key: read.key
		};
	}
	return jsonExact(read.value)
		? {
				Key: read.key,
				Value: read.value
			}
		: {
				Key: read.key,
				Value: read.value,
				Lossy: true
			};
}
