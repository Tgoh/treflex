import type { IExternalKey, IExternalValue } from "../Registries/IExternalRegistry";
import type { IReadGenerator } from "../Types/ISelector";

/** The value provided under `key` on this runtime, `undefined` while nothing provides it. See docs/reference/derived-reads.md#outside-values. */
export function* external<K extends IExternalKey>(key: K): IReadGenerator<IExternalValue<K> | undefined> {
	const result = yield {
		Type: "external",
		Key: key
	};
	return result;
}
