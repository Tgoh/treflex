// On globalThis, like tracking.ts's records: a second evaluation of this
// module (a Vite duplicate load, an HMR re-evaluation) must find the same
// declarations, the same open sync call and the same code results, or sync
// types quietly suspend again and redaction quietly switches off.

import { TreflexRefusal } from "./refusal";

export interface IEffectDeclaration {
	readonly settles?: "sync" | undefined;
	readonly redact: boolean;
	readonly returns?: "module" | undefined;
}

export class SyncEffectPromiseError extends TreflexRefusal {
	readonly effectType: string;
	constructor(effectType: string) {
		super(
			`[treflex] effect "${effectType}" is declared settles: "sync", and its implementation returned a promise. ` +
				`A sync type's implementation returns its result directly (docs/reference/effects.md#sync-effects).`
		);
		this.name = "SyncEffectPromiseError";
		this.effectType = effectType;
	}
}

export class SyncEffectWorkError extends TreflexRefusal {
	readonly effectType: string;
	constructor(effectType: string, attempted: string) {
		super(
			`[treflex] code ${attempted} inside the dispatch of "${effectType}", which is declared settles: "sync", and was refused. ` +
				`Its implementation may not start actions or write state ` +
				`(docs/reference/effects.md#sync-effects).`
		);
		this.name = "SyncEffectWorkError";
		this.effectType = effectType;
	}
}

export interface ISyncCall {
	readonly effectType: string;
	readonly outer: ISyncCall | null;
	violation: SyncEffectWorkError | null;
}

interface IDeclarationState {
	declarations: Map<string, IEffectDeclaration>;
	syncCall: ISyncCall | null;
	codeResults: WeakSet<object>;
}

const STATE_KEY = "__treflex_effect_declarations__";

function state(): IDeclarationState {
	const g = globalThis as Record<string, unknown>;
	let held = g[STATE_KEY] as IDeclarationState | undefined;
	if (!held) {
		held = {
			declarations: new Map(),
			syncCall: null,
			codeResults: new WeakSet()
		};
		g[STATE_KEY] = held;
	}
	return held;
}

const shared = state();

export function declarationOf(type: string): IEffectDeclaration | undefined {
	return shared.declarations.get(type);
}

export function settlesSync(type: string): boolean {
	return shared.declarations.get(type)?.settles === "sync";
}

export function isRedacted(type: string): boolean {
	return shared.declarations.get(type)?.redact === true;
}

function sameDeclaration(a: IEffectDeclaration, b: IEffectDeclaration): boolean {
	return a.settles === b.settles && a.redact === b.redact && a.returns === b.returns;
}

export function declare(type: string, declaration: IEffectDeclaration): void {
	const existing = shared.declarations.get(type);
	if (existing && sameDeclaration(existing, declaration)) {
		return;
	}
	if (existing) {
		console.warn(
			`[treflex] effect "${type}" was declared again with different options, and the new declaration replaces the old one. ` +
				`A hot update does this; two modules declaring one Type do too, and one of them should rename its Type.`
		);
	}
	shared.declarations.set(type, declaration);
}

export const syncCall = {
	enter(effectType: string): ISyncCall {
		const call: ISyncCall = {
			effectType,
			outer: shared.syncCall,
			violation: null
		};
		shared.syncCall = call;
		return call;
	},
	exit(call: ISyncCall): void {
		shared.syncCall = call.outer;
	},
	outside(fn: () => void): void {
		const open = shared.syncCall;
		shared.syncCall = null;
		try {
			fn();
		} finally {
			shared.syncCall = open;
		}
	}
};

export function syncCallOpen(): boolean {
	return shared.syncCall !== null;
}

// Throws, and records the refusal on the open call so the driver fails the
// settlement even when the implementation catches this throw.
export function refuseInSyncCall(attempted: string): void {
	const call = shared.syncCall;
	if (!call) {
		return;
	}
	const error = new SyncEffectWorkError(call.effectType, attempted);
	call.violation ??= error;
	throw error;
}

export function recordCodeResult(value: unknown): void {
	if (value !== null && typeof value === "object") {
		shared.codeResults.add(value);
	}
}

export function isCode(value: unknown): boolean {
	return typeof value === "function" || (value !== null && typeof value === "object" && shared.codeResults.has(value));
}
