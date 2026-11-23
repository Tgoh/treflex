import { host } from "../Reactive/host";

export function watch(read: () => void, onChange: () => void): () => void {
	let armed = false;
	const memo = host.createOwnedMemo(() => {
		read();
		if (armed) {
			host.untrack(onChange);
		}
	});
	armed = true;
	return memo.dispose;
}
