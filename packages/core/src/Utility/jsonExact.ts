export function jsonExact(value: unknown): boolean {
	switch (typeof value) {
		case "string":
		case "boolean":
			return true;
		case "number":
			return Number.isFinite(value) && !Object.is(value, -0);
		case "object": {
			if (value === null) {
				return true;
			}
			if (Array.isArray(value)) {
				for (let i = 0; i < value.length; i++) {
					if (!(i in value) || !jsonExact(value[i])) {
						return false;
					}
				}
				return true;
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== null && proto !== Object.prototype) {
				return false;
			}
			if (Object.getOwnPropertySymbols(value).length > 0) {
				return false;
			}
			for (const key of Object.keys(value)) {
				if (!jsonExact((value as Record<string, unknown>)[key])) {
					return false;
				}
			}
			return true;
		}
		default:
			return false;
	}
}
