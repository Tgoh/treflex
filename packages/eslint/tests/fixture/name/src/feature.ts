export function createEntityFeature<S>(id: string): (actions: object) => {
	id: string;
	state?: S;
} {
	return () => ({
		id
	});
}
