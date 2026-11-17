import type { IDiagEmitter, IRuntimeEventOf } from "../Types/IRuntimeEvent";
import type { IRuntimeStoreReader } from "./processAction";
import { consoleDiag } from "../Types/IRuntimeEvent";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/diag": IDiagService;
	}
}

// The dispatch side's diag channel. Modules constructed by createRuntime
// take an IDiagEmitter directly; anything reached only through
// IActionContext.get (every effect implementation, fanOut, the timer
// scheduler) has no constructor to thread one into, so the emitter is a
// service too.
//
// emitOnce is here rather than at each call site because those call sites
// are free functions with nowhere to keep the memory.
export interface IDiagService {
	emit: IDiagEmitter;
	// Emits at most once per dedupeKey for the runtime's lifetime. Callers
	// own the key's shape and must namespace it: producers share this one
	// flat string space, and clearOnce is a write into it.
	//
	// The set never shrinks, so a runtime churning guid-keyed entities
	// against a missing receiver accretes one entry per churned entity. An
	// accepted limit.
	emitOnce(dedupeKey: string, event: IRuntimeEventOf<"diag">): void;
	// Forgets a key so a condition that healed can report again if it
	// returns. Only recurring producers need this.
	clearOnce(dedupeKey: string): void;
}

export function createDiagService(emit: IDiagEmitter): IDiagService {
	const seen = new Set<string>();
	return {
		emit,
		emitOnce(dedupeKey, event) {
			if (seen.has(dedupeKey)) {
				return;
			}
			seen.add(dedupeKey);
			emit(event);
		},
		clearOnce(dedupeKey) {
			seen.delete(dedupeKey);
		}
	};
}

// The degraded emitter: console only, and it does NOT dedupe. Dedupe memory
// is per-runtime state, and there is no runtime here to hold it; a module
// singleton would suppress one runtime's diagnostic because another already
// reported the same condition. Repeating is the safe direction.
const undeduped: IDiagService = {
	emit: consoleDiag,
	emitOnce: (_dedupeKey, event) => consoleDiag(event),
	clearOnce: () => {}
};

// A tripwire must not be able to break what it watches. A direct
// construction with no "runtime/diag" registered degrades to the console
// half instead of throwing out of a publish. Both runtime assemblies
// register the key, so this serves assemblies built outside them.
export function resolveDiag(get: IRuntimeStoreReader): IDiagService {
	try {
		return get("runtime/diag");
	} catch {
		return undeduped;
	}
}
