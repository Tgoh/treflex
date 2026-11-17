// An object key holding `undefined` serializes to
// absence, and under property access — the only way descriptors, args, and
// responses are consumed — `{ Body: undefined }` and `{}` bind identically
// (`obj.Body` is undefined either way). So that round-trip is faithful, not
// loss. The pervasive optional-field idiom (`{ ...opts }` spreads with
// omitted options) depends on it. Array ELEMENTS get no such tolerance:
// `[undefined]` rewrites to `[null]`, and null binds differently — that is
// real loss and still fails.
export function jsonEquals(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return false;
	}
	if (Array.isArray(a)) {
		const bArr = b as unknown[];
		if (a.length !== bArr.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (!jsonEquals(a[i], bArr[i])) {
				return false;
			}
		}
		return true;
	}
	// Keys holding undefined drop out of the comparison on BOTH sides —
	// callers pass (clone, original) or (original, clone) and the tolerance
	// must not depend on which side carried the explicit undefined. A key
	// defined on one side and absent-or-undefined on the other still fails
	// through the per-key recursion below.
	const aKeys = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
	const bKeys = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	for (const key of aKeys) {
		if (!jsonEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
			return false;
		}
	}
	return true;
}
