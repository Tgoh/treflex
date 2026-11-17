// Below the depth the runtime's own construction walks overflow at.
export const MAX_TREE_DEPTH = 1000;

// False for a loop, which JSON.stringify reports with its own error.
export function nestsDeeperThanBound(value: unknown): boolean {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const onPath = new Set<object>();
	const pending: [
		object,
		number,
		boolean
	][] = [
		[
			value,
			1,
			false
		]
	];
	while (pending.length > 0) {
		const [node, depth, leaving] = pending.pop()!;
		if (leaving) {
			onPath.delete(node);
			continue;
		}
		if (onPath.has(node)) {
			return false;
		}
		if (depth > MAX_TREE_DEPTH) {
			return true;
		}
		onPath.add(node);
		pending.push([
			node,
			depth,
			true
		]);
		for (const child of Object.values(node)) {
			if (child !== null && typeof child === "object") {
				pending.push([
					child,
					depth + 1,
					false
				]);
			}
		}
	}
	return false;
}
